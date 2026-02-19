import {
  appendEmbeddingRunLog,
  appendSyncRunLog,
  claimQueuedEmbeddingRun,
  claimQueuedSyncRun,
  completeEmbeddingRun,
  completeSyncRun,
  countEligibleEmbeddingsForChat,
  countPendingEmbeddingsForChat,
  countStoredChatMessages,
  db,
  failEmbeddingRun,
  failSyncRun,
  listEmbeddingRunChats,
  listPendingMessagesForEmbedding,
  listRunChats,
  loadEmbeddingCheckpoint,
  loadSyncCheckpoint,
  mtprotoSessions,
  saveEmbeddingCheckpoint,
  setRunCurrentChat,
  setEmbeddingRunCurrentChat,
  setEmbeddingTargetEstimate,
  setEmbeddingTargetStatus,
  setTargetEstimate,
  setTargetStatus,
  sql,
  storeNormalizedMessages,
  upsertMessageEmbeddings,
  type NormalizedMessageMedia,
  type NormalizedSyncMessage,
  type EmbeddingRunInfo,
  type SyncRunInfo,
  updateEmbeddingRunProgress,
  updateRunProgress,
  saveSyncCheckpoint
} from "@userbrot/core";
import {
  requireEmbeddingProviderConfig,
  requireMtprotoApiCredentials
} from "@userbrot/core/env";
import { MemoryStorage, TelegramClient, type Message, tl } from "@mtcute/node";
import { desc } from "drizzle-orm";

const IDLE_SLEEP_MS = 4000;
const INTER_BATCH_DELAY_MS = 1100;
const HISTORY_BATCH_SIZE = 100;
const DIALOG_CACHE_WARM_LIMIT = 5000;
const EMBEDDING_BATCH_SIZE = 64;
const INTER_EMBEDDING_BATCH_DELAY_MS = 350;

const session = await db.query.mtprotoSessions.findFirst({
  orderBy: [desc(mtprotoSessions.updatedAt)]
});

if (!session) {
  console.log("No persisted MTProto session found yet. Complete setup flow first.");
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(0);
}

const resolvedOwnerTelegramId = session.ownerTelegramId;
const { apiId, apiHash } = requireMtprotoApiCredentials();
const embeddingProvider = requireEmbeddingProviderConfig();

const client = new TelegramClient({
  apiId,
  apiHash,
  storage: new MemoryStorage()
});

let dialogCacheWarmPromise: Promise<void> | null = null;
let dialogCacheWarmedOnce = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const maybeCause = error as Error & { cause?: unknown };
    if (
      typeof maybeCause.cause === "object" &&
      maybeCause.cause !== null &&
      "message" in maybeCause.cause &&
      typeof (maybeCause.cause as { message?: unknown }).message === "string"
    ) {
      return (maybeCause.cause as { message: string }).message;
    }

    const compact = error.message.split("\nparams:")[0];
    if (compact.length > 400) {
      return `${compact.slice(0, 397)}...`;
    }

    return compact;
  }

  return String(error);
}

function isLocalCachePeerError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /not found in local cache/i.test(error.message);
}

async function warmDialogCache(force = false): Promise<void> {
  if (dialogCacheWarmedOnce && !force) {
    return;
  }

  if (dialogCacheWarmPromise) {
    return dialogCacheWarmPromise;
  }

  dialogCacheWarmPromise = (async () => {
    for await (const _dialog of client.iterDialogs({
      limit: DIALOG_CACHE_WARM_LIMIT,
      archived: "keep",
      pinned: "keep"
    })) {
      void _dialog;
    }

    dialogCacheWarmedOnce = true;
  })();

  try {
    await dialogCacheWarmPromise;
  } finally {
    dialogCacheWarmPromise = null;
  }
}

async function getHistoryWithPeerRecovery(
  chatPeerId: bigint,
  params: {
    limit: number;
    offsetId?: number;
    addOffset?: number;
  }
): Promise<Message[]> {
  try {
    return await withSafeHistoryCall(() => client.getHistory(Number(chatPeerId), params as any));
  } catch (error) {
    if (!isLocalCachePeerError(error)) {
      throw error;
    }

    await warmDialogCache(true);
    return withSafeHistoryCall(() => client.getHistory(Number(chatPeerId), params as any));
  }
}

function toSerializable(value: unknown): unknown {
  if (value === null || typeof value === "undefined") {
    return null;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => toSerializable(item));
  }

  if (typeof value === "object") {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      try {
        return toSerializable((value as { toJSON: () => unknown }).toJSON());
      } catch {
        // no-op
      }
    }

    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, inner] of Object.entries(record)) {
      output[key] = toSerializable(inner);
    }

    return output;
  }

  return value;
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return null;
}

function parseInteger(value: unknown): number | null {
  const numeric = parseNumeric(value);
  if (numeric === null) {
    return null;
  }

  return Math.round(numeric);
}

function parseText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  return null;
}

function normalizeMessageMedia(media: Message["media"]): NormalizedMessageMedia[] {
  if (!media) {
    return [];
  }

  const anyMedia = media as unknown as Record<string, unknown>;

  return [
    {
      mediaType: String(anyMedia.type ?? "unknown"),
      fileId: parseText(anyMedia.fileId),
      fileUniqueId: parseText(anyMedia.uniqueFileId),
      mimeType: parseText(anyMedia.mimeType),
      fileName: parseText(anyMedia.fileName),
      durationSeconds: parseInteger(anyMedia.duration),
      width: parseInteger(anyMedia.width),
      height: parseInteger(anyMedia.height),
      sizeBytes: parseInteger(anyMedia.fileSize),
      raw: toSerializable(anyMedia.raw ?? media) as Record<string, unknown>
    }
  ];
}

function normalizeMessage(message: Message): NormalizedSyncMessage {
  const sender = message.sender as { id?: unknown };
  const senderPeerId = typeof sender.id === "number" ? BigInt(sender.id) : null;
  const media = normalizeMessageMedia(message.media);

  return {
    messageId: message.id,
    senderPeerId,
    date: message.date,
    editDate: message.editDate,
    text: message.text.length > 0 ? message.text : null,
    isOutgoing: message.isOutgoing,
    isService: message.isService,
    isDeleted: false,
    hasMedia: media.length > 0,
    raw: toSerializable(message.raw) as Record<string, unknown>,
    media
  };
}

async function withSafeHistoryCall<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;

  while (attempt < 6) {
    try {
      return await fn();
    } catch (error) {
      if (tl.RpcError.is(error, "FLOOD_WAIT_%d")) {
        const waitMs = Math.ceil(error.seconds * 1000 * 1.1 + Math.random() * 700);
        await sleep(waitMs);
        attempt += 1;
        continue;
      }

      if (error instanceof Error) {
        const match = error.message.match(/wait of\s+(\d+)\s+seconds/i);
        if (match) {
          const waitSeconds = Number.parseInt(match[1], 10);
          if (Number.isFinite(waitSeconds) && waitSeconds > 0) {
            const waitMs = Math.ceil(waitSeconds * 1000 * 1.1 + Math.random() * 700);
            await sleep(waitMs);
            attempt += 1;
            continue;
          }
        }
      }

      if (tl.RpcError.is(error, "TIMEOUT") || tl.RpcError.is(error, "INTERNAL")) {
        const waitMs = 800 * (attempt + 1);
        await sleep(waitMs);
        attempt += 1;
        continue;
      }

      throw error;
    }
  }

  throw new Error("History call exceeded retry policy");
}

async function estimateRemainingMessages(chatPeerId: bigint): Promise<number | null> {
  void chatPeerId;
  return null;
}

function computeEtaSeconds(processedMessages: number, elapsedMs: number, remainingMessages: number): number | null {
  if (processedMessages <= 0 || elapsedMs <= 0 || remainingMessages <= 0) {
    return null;
  }

  const throughput = processedMessages / (elapsedMs / 1000);
  if (throughput <= 0) {
    return null;
  }

  return Math.ceil(remainingMessages / throughput);
}

async function withSafeEmbeddingCall<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;

  while (attempt < 6) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Error) {
        const maybeStatus = error.message.match(/status\s+(\d{3})/i);
        const statusCode = maybeStatus ? Number.parseInt(maybeStatus[1], 10) : null;
        const shouldRetry = statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504;

        if (shouldRetry) {
          const waitMs = Math.ceil(900 * (attempt + 1) + Math.random() * 600);
          await sleep(waitMs);
          attempt += 1;
          continue;
        }

        const waitMatch = error.message.match(/wait of\s+(\d+)\s+seconds/i);
        if (waitMatch) {
          const waitSeconds = Number.parseInt(waitMatch[1], 10);
          if (Number.isFinite(waitSeconds) && waitSeconds > 0) {
            await sleep(Math.ceil(waitSeconds * 1000 * 1.1 + Math.random() * 700));
            attempt += 1;
            continue;
          }
        }
      }

      throw error;
    }
  }

  throw new Error("Embedding call exceeded retry policy");
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const base = new URL(embeddingProvider.baseUrl);
  const endpoint = /\/embeddings\/?$/i.test(base.pathname)
    ? base
    : new URL("embeddings", embeddingProvider.baseUrl.endsWith("/") ? embeddingProvider.baseUrl : `${embeddingProvider.baseUrl}/`);

  const payload = await withSafeEmbeddingCall(async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${embeddingProvider.apiKey}`
      },
      body: JSON.stringify({
        model: embeddingProvider.model,
        input: texts
      })
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`Embedding provider status ${response.status}: ${raw.slice(0, 220)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const contentType = response.headers.get("content-type") ?? "unknown";
      throw new Error(
        `Embedding provider returned non-JSON response (content-type ${contentType}): ${raw.slice(0, 220)}`
      );
    }

    return parsed as {
      data?: Array<{ embedding?: unknown }>;
    };
  });

  if (!payload.data || !Array.isArray(payload.data) || payload.data.length !== texts.length) {
    throw new Error("Embedding provider returned invalid batch response");
  }

  return payload.data.map((item) => {
    const vector = item.embedding;
    if (!Array.isArray(vector)) {
      throw new Error("Embedding response missing vector array");
    }

    const normalized = vector
      .map((value) => (typeof value === "number" && Number.isFinite(value) ? value : null))
      .filter((value): value is number => value !== null);

    if (normalized.length === 0) {
      throw new Error("Embedding vector is empty");
    }

    return normalized;
  });
}

async function processEmbeddingChat(
  run: EmbeddingRunInfo,
  chatPeerId: bigint,
  knownEstimate: number | null
): Promise<void> {
  const checkpoint = await loadEmbeddingCheckpoint(run.ownerTelegramId, chatPeerId);
  const estimatedMessages = await countPendingEmbeddingsForChat(run.ownerTelegramId, chatPeerId, run.model);
  const estimatedEtaSeconds = estimatedMessages > 0 ? Math.ceil(estimatedMessages / 45) : 0;

  await setEmbeddingTargetEstimate(run.ownerTelegramId, chatPeerId, {
    estimatedMessages,
    estimatedEtaSeconds
  });

  if (knownEstimate === null) {
    await updateEmbeddingRunProgress(run.id, run.ownerTelegramId, {
      estimatedMessagesDelta: estimatedMessages
    });
  }

  await setEmbeddingTargetStatus(run.ownerTelegramId, chatPeerId, "embedding");
  await setEmbeddingRunCurrentChat(run.id, run.ownerTelegramId, chatPeerId);

  const startedAt = Date.now();
  let processedInChat = 0;
  let nextMessageId = checkpoint.nextMessageId ?? 0;
  let wrappedToStart = false;

  while (true) {
    const rows = await listPendingMessagesForEmbedding(
      run.ownerTelegramId,
      chatPeerId,
      run.model,
      nextMessageId,
      EMBEDDING_BATCH_SIZE
    );

    if (rows.length === 0) {
      const stillPending = await countPendingEmbeddingsForChat(run.ownerTelegramId, chatPeerId, run.model);
      if (stillPending > 0 && !wrappedToStart) {
        nextMessageId = 0;
        wrappedToStart = true;
        continue;
      }

      break;
    }

    const vectors = await embedBatch(rows.map((row) => row.text));

    await upsertMessageEmbeddings(
      run.ownerTelegramId,
      rows.map((row, index) => ({
        chatPeerId,
        messageId: row.messageId,
        model: run.model,
        embedding: vectors[index],
        sourceUpdatedAt: row.updatedAt,
        sourceText: row.text
      }))
    );

    nextMessageId = rows[rows.length - 1]?.messageId ?? nextMessageId;
    processedInChat += rows.length;

    const elapsedMs = Date.now() - startedAt;
    const etaSeconds = computeEtaSeconds(processedInChat, elapsedMs, Math.max(estimatedMessages - processedInChat, 0));

    await saveEmbeddingCheckpoint(run.ownerTelegramId, chatPeerId, {
      nextMessageId,
      backfillComplete: false
    });

    await updateEmbeddingRunProgress(run.id, run.ownerTelegramId, {
      processedMessagesDelta: rows.length,
      etaSeconds
    });

    await appendEmbeddingRunLog(run.id, run.ownerTelegramId, "Embedded message batch", "info", {
      chatPeerId: chatPeerId.toString(),
      batchSize: rows.length,
      nextMessageId,
      processedInChat,
      etaSeconds
    });

    await sleep(INTER_EMBEDDING_BATCH_DELAY_MS);
  }

  const pendingAfter = await countPendingEmbeddingsForChat(run.ownerTelegramId, chatPeerId, run.model);
  const eligibleTotal = await countEligibleEmbeddingsForChat(run.ownerTelegramId, chatPeerId);
  const status = pendingAfter === 0 ? "embedded" : "pending";

  await saveEmbeddingCheckpoint(run.ownerTelegramId, chatPeerId, {
    nextMessageId,
    backfillComplete: pendingAfter === 0
  });

  await setEmbeddingTargetEstimate(run.ownerTelegramId, chatPeerId, {
    estimatedMessages: pendingAfter,
    estimatedEtaSeconds: pendingAfter > 0 ? Math.ceil(pendingAfter / 45) : 0
  });
  await setEmbeddingTargetStatus(run.ownerTelegramId, chatPeerId, status, null);
  await updateEmbeddingRunProgress(run.id, run.ownerTelegramId, {
    completedChatsDelta: 1,
    etaSeconds: 0
  });
  await appendEmbeddingRunLog(run.id, run.ownerTelegramId, `Chat ${chatPeerId.toString()} embeddings updated`, "info", {
    processedMessages: processedInChat,
    pendingAfter,
    eligibleTotal,
    nextMessageId
  });
}

async function processEmbeddingRun(run: EmbeddingRunInfo): Promise<void> {
  await appendEmbeddingRunLog(run.id, run.ownerTelegramId, "Worker claimed embedding run", "info", {
    chatPeerIds: run.chatPeerIds.map((value) => value.toString()),
    model: run.model
  });

  const chats = await listEmbeddingRunChats(run);
  if (chats.length === 0) {
    await completeEmbeddingRun(run.id, run.ownerTelegramId);
    await appendEmbeddingRunLog(run.id, run.ownerTelegramId, "Run has no synced chats, marking completed", "warn");
    return;
  }

  let estimatedTotal = 0;
  for (const chat of chats) {
    if (chat.estimatedMessages !== null) {
      estimatedTotal += chat.estimatedMessages;
    }
  }

  await updateEmbeddingRunProgress(run.id, run.ownerTelegramId, {
    estimatedMessages: estimatedTotal
  });

  const failedChats: Array<{ peerId: string; error: string }> = [];

  for (const chat of chats) {
    try {
      await processEmbeddingChat(run, chat.peerId, chat.estimatedMessages);
    } catch (error) {
      const errorMessage = normalizeErrorMessage(error);
      const existing = await loadEmbeddingCheckpoint(run.ownerTelegramId, chat.peerId);
      await setEmbeddingTargetStatus(run.ownerTelegramId, chat.peerId, "error", errorMessage);
      await saveEmbeddingCheckpoint(run.ownerTelegramId, chat.peerId, {
        nextMessageId: existing.nextMessageId,
        backfillComplete: existing.backfillComplete,
        lastError: errorMessage
      });
      failedChats.push({
        peerId: chat.peerId.toString(),
        error: errorMessage
      });

      await appendEmbeddingRunLog(
        run.id,
        run.ownerTelegramId,
        `Skipping failed embeddings chat ${chat.peerId.toString()}`,
        "warn",
        {
          chatPeerId: chat.peerId.toString(),
          error: errorMessage
        }
      );
    }
  }

  await setEmbeddingRunCurrentChat(run.id, run.ownerTelegramId, null);

  if (failedChats.length > 0) {
    const preview = failedChats
      .slice(0, 5)
      .map((item) => `${item.peerId}: ${item.error}`)
      .join("; ");
    const suffix = failedChats.length > 5 ? ` (+${failedChats.length - 5} more)` : "";
    throw new Error(`Failed ${failedChats.length}/${chats.length} embedding chats (${preview}${suffix})`);
  }

  await completeEmbeddingRun(run.id, run.ownerTelegramId);
}

async function processChat(
  run: SyncRunInfo,
  chatPeerId: bigint,
  knownEstimate: number | null
): Promise<void> {
  const checkpoint = await loadSyncCheckpoint(run.ownerTelegramId, chatPeerId);

  const estimatedMessages = await estimateRemainingMessages(chatPeerId);
  const estimatedEtaSeconds = estimatedMessages && estimatedMessages > 0 ? Math.ceil(estimatedMessages / 35) : null;

  await setTargetEstimate(run.ownerTelegramId, chatPeerId, {
    estimatedMessages,
    estimatedEtaSeconds
  });

  if (knownEstimate === null && typeof estimatedMessages === "number") {
    await updateRunProgress(run.id, run.ownerTelegramId, {
      estimatedMessagesDelta: estimatedMessages
    });
  }

  await setTargetStatus(run.ownerTelegramId, chatPeerId, "syncing");
  await setRunCurrentChat(run.id, run.ownerTelegramId, chatPeerId);

  const firstPage = await getHistoryWithPeerRecovery(chatPeerId, {
    limit: 1
  });

  if (firstPage.length === 0) {
    await saveSyncCheckpoint(run.ownerTelegramId, chatPeerId, {
      nextOffset: 0,
      nextMaxId: 0,
      newestMessageId: checkpoint.newestMessageId,
      oldestMessageId: checkpoint.oldestMessageId,
      backfillComplete: true
    });

    await setTargetEstimate(run.ownerTelegramId, chatPeerId, {
      estimatedMessages: 0,
      estimatedEtaSeconds: 0
    });

    await setTargetStatus(run.ownerTelegramId, chatPeerId, "synced", null);
    await updateRunProgress(run.id, run.ownerTelegramId, {
      completedChatsDelta: 1,
      etaSeconds: 0
    });
    await appendSyncRunLog(run.id, run.ownerTelegramId, `Chat ${chatPeerId.toString()} has no history`, "info");
    return;
  }

  const newestAtSyncStart = firstPage[0].id;
  let newestMessageId = checkpoint.newestMessageId ?? newestAtSyncStart;
  let oldestMessageId = checkpoint.oldestMessageId;
  let processedInChat = 0;

  if (checkpoint.newestMessageId !== null && newestAtSyncStart > checkpoint.newestMessageId) {
    let catchupOffset = 0;

    while (true) {
      const page = await getHistoryWithPeerRecovery(chatPeerId, {
        limit: HISTORY_BATCH_SIZE,
        offsetId: 0,
        addOffset: catchupOffset
      });

      if (page.length === 0) {
        break;
      }

      const freshMessages = page.filter((message) => message.id > checkpoint.newestMessageId!);
      if (freshMessages.length > 0) {
        const normalizedFresh = freshMessages.map((message) => normalizeMessage(message));
        await storeNormalizedMessages(run.ownerTelegramId, chatPeerId, normalizedFresh);

        const freshIds = normalizedFresh.map((item) => item.messageId);
        const freshestId = Math.max(...freshIds);
        newestMessageId = newestMessageId ? Math.max(newestMessageId, freshestId) : freshestId;
        processedInChat += normalizedFresh.length;

        await updateRunProgress(run.id, run.ownerTelegramId, {
          processedMessagesDelta: normalizedFresh.length
        });

        await appendSyncRunLog(run.id, run.ownerTelegramId, "Imported new message batch", "info", {
          chatPeerId: chatPeerId.toString(),
          batchSize: normalizedFresh.length,
          fetchedBatchSize: page.length,
          processedInChat
        });
      }

      catchupOffset += page.length;
      const oldestInPage = page[page.length - 1]?.id ?? 0;
      if (oldestInPage <= checkpoint.newestMessageId || page.length < HISTORY_BATCH_SIZE) {
        break;
      }

      await sleep(INTER_BATCH_DELAY_MS);
    }
  }

  if (checkpoint.backfillComplete) {
    await saveSyncCheckpoint(run.ownerTelegramId, chatPeerId, {
      nextOffset: checkpoint.nextOffset,
      nextMaxId: oldestMessageId,
      newestMessageId: newestMessageId ? Math.max(newestMessageId, newestAtSyncStart) : newestAtSyncStart,
      oldestMessageId,
      backfillComplete: true
    });

    const totalStoredMessages = await countStoredChatMessages(run.ownerTelegramId, chatPeerId);

    await setTargetEstimate(run.ownerTelegramId, chatPeerId, {
      estimatedMessages: totalStoredMessages,
      estimatedEtaSeconds: 0
    });

    await setTargetStatus(run.ownerTelegramId, chatPeerId, "synced", null);
    await updateRunProgress(run.id, run.ownerTelegramId, {
      completedChatsDelta: 1,
      etaSeconds: 0
    });
    await appendSyncRunLog(
      run.id,
      run.ownerTelegramId,
      `Chat ${chatPeerId.toString()} synced successfully`,
      "info",
      {
        processedMessages: processedInChat,
        totalStoredMessages
      }
    );
    return;
  }

  const anchorOffsetId = newestMessageId ? newestMessageId + 1 : newestAtSyncStart + 1;
  const isLegacyCheckpointFormat =
    checkpoint.nextOffset === null &&
    checkpoint.nextMaxId !== null &&
    checkpoint.oldestMessageId !== null &&
    checkpoint.nextMaxId === checkpoint.oldestMessageId;

  let nextOffset = checkpoint.nextOffset ?? (isLegacyCheckpointFormat ? 0 : (checkpoint.nextMaxId ?? 0));
  const resumeBeforeMessageId = checkpoint.oldestMessageId;
  const startedAt = Date.now();

  await appendSyncRunLog(
    run.id,
    run.ownerTelegramId,
    `Syncing chat ${chatPeerId.toString()} from checkpoint ${resumeBeforeMessageId ?? 0}`,
    "info",
    {
      estimatedMessages,
      estimatedEtaSeconds,
      nextOffset,
      anchorOffsetId,
      legacyCheckpoint: isLegacyCheckpointFormat
    }
  );

  while (true) {
    const page = await getHistoryWithPeerRecovery(chatPeerId, {
      limit: HISTORY_BATCH_SIZE,
      offsetId: anchorOffsetId,
      addOffset: nextOffset
    });

    if (page.length === 0) {
      break;
    }

    const pageToStore =
      resumeBeforeMessageId === null ? page : page.filter((message) => message.id < resumeBeforeMessageId);

    if (pageToStore.length === 0) {
      nextOffset += page.length;
      continue;
    }

    const normalized = pageToStore.map((message) => normalizeMessage(message));
    await storeNormalizedMessages(run.ownerTelegramId, chatPeerId, normalized);

    const batchIds = normalized.map((item) => item.messageId);
    const batchMinId = Math.min(...batchIds);
    const batchMaxId = Math.max(...batchIds);
    newestMessageId = newestMessageId ? Math.max(newestMessageId, batchMaxId) : batchMaxId;
    oldestMessageId = oldestMessageId ? Math.min(oldestMessageId, batchMinId) : batchMinId;
    processedInChat += normalized.length;
    nextOffset += page.length;

    const elapsedMs = Date.now() - startedAt;
    const etaSeconds =
      typeof estimatedMessages === "number"
        ? computeEtaSeconds(processedInChat, elapsedMs, Math.max(estimatedMessages - processedInChat, 0))
        : null;

    await saveSyncCheckpoint(run.ownerTelegramId, chatPeerId, {
      nextOffset,
      nextMaxId: oldestMessageId,
      newestMessageId,
      oldestMessageId,
      backfillComplete: false
    });

    await updateRunProgress(run.id, run.ownerTelegramId, {
      processedMessagesDelta: normalized.length,
      etaSeconds
    });

    await appendSyncRunLog(run.id, run.ownerTelegramId, "Imported message batch", "info", {
      chatPeerId: chatPeerId.toString(),
      batchSize: normalized.length,
      fetchedBatchSize: page.length,
      oldestMessageId: batchMinId,
      nextOffset,
      processedInChat,
      etaSeconds
    });

    await sleep(INTER_BATCH_DELAY_MS);

    if (page.length < HISTORY_BATCH_SIZE) {
      break;
    }
  }

  await saveSyncCheckpoint(run.ownerTelegramId, chatPeerId, {
    nextOffset,
    nextMaxId: oldestMessageId,
    newestMessageId,
    oldestMessageId,
    backfillComplete: true
  });

  const totalStoredMessages = await countStoredChatMessages(run.ownerTelegramId, chatPeerId);

  await setTargetEstimate(run.ownerTelegramId, chatPeerId, {
    estimatedMessages: totalStoredMessages,
    estimatedEtaSeconds: 0
  });

  await setTargetStatus(run.ownerTelegramId, chatPeerId, "synced", null);
  await updateRunProgress(run.id, run.ownerTelegramId, {
    completedChatsDelta: 1,
    etaSeconds: 0
  });
  await appendSyncRunLog(
    run.id,
    run.ownerTelegramId,
    `Chat ${chatPeerId.toString()} synced successfully`,
    "info",
    {
      processedMessages: processedInChat,
      totalStoredMessages,
      nextOffset,
      anchorOffsetId
    }
  );
}

async function processRun(run: SyncRunInfo): Promise<void> {
  await appendSyncRunLog(run.id, run.ownerTelegramId, "Worker claimed sync run", "info", {
    chatPeerIds: run.chatPeerIds.map((value) => value.toString())
  });

  try {
    await warmDialogCache();
  } catch {
    await appendSyncRunLog(run.id, run.ownerTelegramId, "Failed to warm dialog cache before run", "warn");
  }

  const chats = await listRunChats(run);
  if (chats.length === 0) {
    await completeSyncRun(run.id, run.ownerTelegramId);
    await appendSyncRunLog(run.id, run.ownerTelegramId, "Run has no chats, marking completed", "warn");
    return;
  }

  let estimatedTotal = 0;
  for (const chat of chats) {
    if (chat.estimatedMessages !== null) {
      estimatedTotal += chat.estimatedMessages;
    }
  }

  await updateRunProgress(run.id, run.ownerTelegramId, {
    estimatedMessages: estimatedTotal
  });

  const failedChats: Array<{ peerId: string; error: string }> = [];

  for (const chat of chats) {
    try {
      await processChat(run, chat.peerId, chat.estimatedMessages);
    } catch (error) {
      const errorMessage = normalizeErrorMessage(error);
      const existing = await loadSyncCheckpoint(run.ownerTelegramId, chat.peerId);
      await setTargetStatus(run.ownerTelegramId, chat.peerId, "error", errorMessage);
      await saveSyncCheckpoint(run.ownerTelegramId, chat.peerId, {
        nextOffset: existing.nextOffset,
        nextMaxId: existing.nextMaxId,
        newestMessageId: existing.newestMessageId,
        oldestMessageId: existing.oldestMessageId,
        backfillComplete: existing.backfillComplete,
        lastError: errorMessage
      });
      failedChats.push({
        peerId: chat.peerId.toString(),
        error: errorMessage
      });

      await appendSyncRunLog(run.id, run.ownerTelegramId, `Skipping failed chat ${chat.peerId.toString()}`, "warn", {
        chatPeerId: chat.peerId.toString(),
        error: errorMessage
      });
    }
  }

  await setRunCurrentChat(run.id, run.ownerTelegramId, null);

  if (failedChats.length > 0) {
    const preview = failedChats
      .slice(0, 5)
      .map((item) => `${item.peerId}: ${item.error}`)
      .join("; ");
    const suffix = failedChats.length > 5 ? ` (+${failedChats.length - 5} more)` : "";
    throw new Error(`Failed ${failedChats.length}/${chats.length} chats (${preview}${suffix})`);
  }

  await completeSyncRun(run.id, run.ownerTelegramId);
}

let exitCode = 0;

try {
  await client.importSession(session.sessionString, true);
  const me = await client.getMe();
  const accountLabel = me.username ? `@${me.username}` : `${me.id}`;
  console.log(`Userbot worker authorized as ${accountLabel}. Polling sync queue...`);

  while (true) {
    const run = await claimQueuedSyncRun(resolvedOwnerTelegramId);

    if (run) {
      try {
        await processRun(run);
        await appendSyncRunLog(run.id, run.ownerTelegramId, "Run completed", "info");
      } catch (error) {
        const message = normalizeErrorMessage(error);
        await appendSyncRunLog(run.id, run.ownerTelegramId, `Run failed: ${message}`, "error");
        await failSyncRun(run.id, run.ownerTelegramId, message);
      }

      continue;
    }

    const embeddingRun = await claimQueuedEmbeddingRun(resolvedOwnerTelegramId);

    if (embeddingRun) {
      try {
        await processEmbeddingRun(embeddingRun);
        await appendEmbeddingRunLog(embeddingRun.id, embeddingRun.ownerTelegramId, "Embedding run completed", "info");
      } catch (error) {
        const message = normalizeErrorMessage(error);
        await appendEmbeddingRunLog(embeddingRun.id, embeddingRun.ownerTelegramId, `Run failed: ${message}`, "error");
        await failEmbeddingRun(embeddingRun.id, embeddingRun.ownerTelegramId, message);
      }

      continue;
    }

    await sleep(IDLE_SLEEP_MS);
  }
} catch (error) {
  const message = normalizeErrorMessage(error);
  console.error(`Userbot worker failed to start: ${message}`);
  exitCode = 1;
} finally {
  await client.destroy().catch(() => undefined);
  await sql.end({ timeout: 5 }).catch(() => undefined);
}

process.exit(exitCode);
