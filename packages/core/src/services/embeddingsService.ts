import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  embeddingCheckpoints,
  embeddingRunLogs,
  embeddingRuns,
  embeddingTargets,
  syncCheckpoints,
  telegramChats,
  telegramMessageEmbeddings,
  telegramMessages,
  type EmbeddingRunStatus,
  type EmbeddingTargetStatus
} from "../db/schema";

export type EmbeddingCatalogChat = {
  peerId: bigint;
  title: string;
  username: string | null;
  folderIds: number[];
  lastMessageId: number | null;
  lastMessageDate: Date | null;
  selected: boolean;
  status: EmbeddingTargetStatus;
  isEmbedded: boolean;
  estimatedMode: "exact" | "unknown";
  estimatedMessages: number | null;
  estimatedEtaSeconds: number | null;
  lastEmbeddedAt: Date | null;
  lastError: string | null;
};

export type EmbeddingRunInfo = {
  id: number;
  ownerTelegramId: bigint;
  status: EmbeddingRunStatus;
  model: string;
  chatPeerIds: bigint[];
  totalChats: number;
  completedChats: number;
  estimatedMessages: number;
  processedMessages: number;
  etaSeconds: number | null;
  currentChatPeerId: bigint | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type EmbeddingRunLog = {
  id: number;
  runId: number;
  level: string;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: Date;
};

export type EmbeddingStatusSnapshot = {
  activeRun: EmbeddingRunInfo | null;
  latestRun: EmbeddingRunInfo | null;
  logs: EmbeddingRunLog[];
};

export type EmbeddingCheckpointState = {
  nextMessageId: number | null;
  backfillComplete: boolean;
  lastProcessedAt: Date | null;
  lastError: string | null;
};

export type PendingEmbeddingMessage = {
  messageId: number;
  text: string;
  updatedAt: Date;
};

export type MessageEmbeddingUpsert = {
  chatPeerId: bigint;
  messageId: number;
  model: string;
  embedding: number[];
  sourceUpdatedAt: Date;
  sourceText: string | null;
};

function decodeChatPeerIds(raw: string[]): bigint[] {
  return raw.map((value) => BigInt(value));
}

function encodeChatPeerIds(values: bigint[]): string[] {
  return values.map((value) => value.toString());
}

function mapRun(row: typeof embeddingRuns.$inferSelect): EmbeddingRunInfo {
  return {
    id: row.id,
    ownerTelegramId: 0n,
    status: row.status,
    model: row.model,
    chatPeerIds: decodeChatPeerIds(row.chatPeerIds),
    totalChats: row.totalChats,
    completedChats: row.completedChats,
    estimatedMessages: row.estimatedMessages,
    processedMessages: row.processedMessages,
    etaSeconds: row.etaSeconds,
    currentChatPeerId: row.currentChatPeerId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function embeddableMessagePredicate() {
  return sql`${telegramMessages.text} is not null and length(trim(${telegramMessages.text})) > 0 and ${telegramMessages.isService} = false and ${telegramMessages.isDeleted} = false`;
}

export async function listEmbeddingCatalogChats(_ownerTelegramId: bigint, model: string): Promise<EmbeddingCatalogChat[]> {
  const eligibleCounts = await db
    .select({ chatPeerId: telegramMessages.chatPeerId, total: sql<number>`count(*)::int` })
    .from(telegramMessages)
    .where(embeddableMessagePredicate())
    .groupBy(telegramMessages.chatPeerId);

  const pendingCounts = await db
    .select({ chatPeerId: telegramMessages.chatPeerId, total: sql<number>`count(*)::int` })
    .from(telegramMessages)
    .leftJoin(
      telegramMessageEmbeddings,
      and(
        eq(telegramMessageEmbeddings.chatPeerId, telegramMessages.chatPeerId),
        eq(telegramMessageEmbeddings.messageId, telegramMessages.messageId)
      )
    )
    .where(
      and(
        embeddableMessagePredicate(),
        sql`(${telegramMessageEmbeddings.id} is null or ${telegramMessageEmbeddings.model} <> ${model} or ${telegramMessageEmbeddings.sourceUpdatedAt} < ${telegramMessages.updatedAt})`
      )
    )
    .groupBy(telegramMessages.chatPeerId);

  const eligibleByPeerId = new Map(eligibleCounts.map((item) => [item.chatPeerId.toString(), item.total]));
  const pendingByPeerId = new Map(pendingCounts.map((item) => [item.chatPeerId.toString(), item.total]));

  const rows = await db
    .select({
      peerId: telegramChats.peerId,
      title: telegramChats.title,
      username: telegramChats.username,
      folderIds: telegramChats.folderIds,
      lastMessageId: telegramChats.lastMessageId,
      lastMessageDate: telegramChats.lastMessageDate,
      selected: embeddingTargets.enabled,
      targetStatus: embeddingTargets.status,
      targetEstimatedMessages: embeddingTargets.estimatedMessages,
      targetEstimatedEtaSeconds: embeddingTargets.estimatedEtaSeconds,
      targetLastEmbeddedAt: embeddingTargets.lastEmbeddedAt,
      targetLastError: embeddingTargets.lastError,
      checkpointBackfillComplete: embeddingCheckpoints.backfillComplete,
      syncBackfillComplete: syncCheckpoints.backfillComplete
    })
    .from(telegramChats)
    .innerJoin(syncCheckpoints, eq(syncCheckpoints.chatPeerId, telegramChats.peerId))
    .leftJoin(embeddingTargets, eq(embeddingTargets.chatPeerId, telegramChats.peerId))
    .leftJoin(embeddingCheckpoints, eq(embeddingCheckpoints.chatPeerId, telegramChats.peerId))
    .where(eq(syncCheckpoints.backfillComplete, true))
    .orderBy(asc(telegramChats.title));

  return rows.map((row) => {
    const key = row.peerId.toString();
    const eligible = eligibleByPeerId.get(key) ?? 0;
    const computedPending = pendingByPeerId.get(key) ?? 0;
    const selected = row.selected ?? false;
    const targetStatus = row.targetStatus ?? "pending";
    const checkpointDone = row.checkpointBackfillComplete ?? false;
    const isEmbedded = eligible === 0 ? checkpointDone : computedPending === 0;
    const status: EmbeddingTargetStatus = isEmbedded
      ? "embedded"
      : targetStatus === "embedding" || targetStatus === "error"
        ? targetStatus
        : "pending";

    const shouldExposeEstimate = status === "embedding" || status === "embedded" || selected;
    const estimatedMessages = shouldExposeEstimate
      ? status === "embedded"
        ? eligible
        : status === "pending"
          ? computedPending
          : (row.targetEstimatedMessages ?? computedPending)
      : null;

    return {
      peerId: row.peerId,
      title: row.title,
      username: row.username,
      folderIds: row.folderIds,
      lastMessageId: row.lastMessageId,
      lastMessageDate: row.lastMessageDate,
      selected,
      status,
      isEmbedded,
      estimatedMode: estimatedMessages === null ? "unknown" : "exact",
      estimatedMessages,
      estimatedEtaSeconds:
        status === "embedded"
          ? 0
          : shouldExposeEstimate
            ? (row.targetEstimatedEtaSeconds ?? null)
            : null,
      lastEmbeddedAt: row.targetLastEmbeddedAt,
      lastError: row.targetLastError
    };
  });
}

export async function setEmbeddingTargets(_ownerTelegramId: bigint, chatPeerIds: bigint[]) {
  const now = new Date();
  await db.update(embeddingTargets).set({ enabled: false, updatedAt: now });

  for (const chatPeerId of chatPeerIds) {
    const existing = await db.query.embeddingTargets.findFirst({ where: eq(embeddingTargets.chatPeerId, chatPeerId) });
    const keepEmbedded = existing?.status === "embedded";

    await db
      .insert(embeddingTargets)
      .values({
        chatPeerId,
        enabled: true,
        status: keepEmbedded ? "embedded" : "pending",
        estimatedMessages: keepEmbedded ? 0 : null,
        estimatedEtaSeconds: keepEmbedded ? 0 : null,
        lastEmbeddedAt: keepEmbedded ? (existing?.lastEmbeddedAt ?? null) : null,
        lastError: null,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: embeddingTargets.chatPeerId,
        set: {
          enabled: true,
          status: keepEmbedded ? "embedded" : "pending",
          estimatedMessages: keepEmbedded ? 0 : null,
          estimatedEtaSeconds: keepEmbedded ? 0 : null,
          lastEmbeddedAt: keepEmbedded ? (existing?.lastEmbeddedAt ?? null) : null,
          lastError: null,
          updatedAt: now
        }
      });
  }
}

export async function setEmbeddingTargetEstimate(_ownerTelegramId: bigint, chatPeerId: bigint, estimate: { estimatedMessages: number | null; estimatedEtaSeconds: number | null; }) {
  await db
    .insert(embeddingTargets)
    .values({
      chatPeerId,
      enabled: true,
      estimatedMessages: estimate.estimatedMessages,
      estimatedEtaSeconds: estimate.estimatedEtaSeconds,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: embeddingTargets.chatPeerId,
      set: { estimatedMessages: estimate.estimatedMessages, estimatedEtaSeconds: estimate.estimatedEtaSeconds, updatedAt: new Date() }
    });
}

export async function enqueueEmbeddingRun(ownerTelegramId: bigint, chatPeerIds: bigint[], model: string): Promise<EmbeddingRunInfo> {
  if (chatPeerIds.length === 0) throw new Error("Select at least one chat to embed");
  const active = await getActiveEmbeddingRun(ownerTelegramId);
  if (active) return active;
  await setEmbeddingTargets(ownerTelegramId, chatPeerIds);

  const inserted = await db.insert(embeddingRuns).values({
    status: "queued",
    model,
    chatPeerIds: encodeChatPeerIds(chatPeerIds),
    totalChats: chatPeerIds.length,
    completedChats: 0,
    estimatedMessages: 0,
    processedMessages: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  }).returning();

  const run = inserted[0];
  await appendEmbeddingRunLog(run.id, ownerTelegramId, "Embedding run queued", "info", { chatCount: chatPeerIds.length, model });
  return mapRun(run);
}

export async function getActiveEmbeddingRun(_ownerTelegramId?: bigint) {
  const running = await db.query.embeddingRuns.findFirst({ where: eq(embeddingRuns.status, "running"), orderBy: [desc(embeddingRuns.createdAt)] });
  if (running) {
    return mapRun(running);
  }

  const queued = await db.query.embeddingRuns.findFirst({ where: eq(embeddingRuns.status, "queued"), orderBy: [desc(embeddingRuns.createdAt)] });
  return queued ? mapRun(queued) : null;
}

export async function getLatestEmbeddingRun(_ownerTelegramId?: bigint) {
  const run = await db.query.embeddingRuns.findFirst({ orderBy: [desc(embeddingRuns.createdAt)] });
  return run ? mapRun(run) : null;
}

export async function getEmbeddingRunById(_ownerTelegramId: bigint, runId: number): Promise<EmbeddingRunInfo | null> {
  const run = await db.query.embeddingRuns.findFirst({ where: eq(embeddingRuns.id, runId) });
  return run ? mapRun(run) : null;
}

export async function listEmbeddingRunLogs(_ownerTelegramId: bigint, runId: number, limit = 80): Promise<EmbeddingRunLog[]> {
  const rows = await db.query.embeddingRunLogs.findMany({ where: eq(embeddingRunLogs.runId, runId), orderBy: [desc(embeddingRunLogs.createdAt)], limit });
  return rows.map((row) => ({ id: row.id, runId: row.runId, level: row.level, message: row.message, meta: row.meta ?? null, createdAt: row.createdAt })).reverse();
}

export async function getEmbeddingStatusSnapshot(ownerTelegramId: bigint): Promise<EmbeddingStatusSnapshot> {
  const activeRun = await getActiveEmbeddingRun(ownerTelegramId);
  const latestRun = activeRun ?? (await getLatestEmbeddingRun(ownerTelegramId));
  const logs = latestRun ? await listEmbeddingRunLogs(ownerTelegramId, latestRun.id, 80) : [];
  return { activeRun, latestRun, logs };
}

export async function appendEmbeddingRunLog(runId: number, _ownerTelegramId: bigint, message: string, level: string, meta: Record<string, unknown> | null = null) {
  await db.insert(embeddingRunLogs).values({ runId, level, message, meta, createdAt: new Date() });
}

export async function claimQueuedEmbeddingRun(_ownerTelegramId: bigint): Promise<EmbeddingRunInfo | null> {
  return db.transaction(async (tx) => {
    const running = await tx.query.embeddingRuns.findFirst({ where: eq(embeddingRuns.status, "running"), orderBy: [desc(embeddingRuns.createdAt)] });
    if (running) {
      return mapRun(running);
    }

    const queued = await tx.query.embeddingRuns.findFirst({ where: eq(embeddingRuns.status, "queued"), orderBy: [asc(embeddingRuns.createdAt)] });
    if (!queued) return null;
    const updated = await tx.update(embeddingRuns).set({ status: "running", startedAt: new Date(), updatedAt: new Date() }).where(and(eq(embeddingRuns.id, queued.id), eq(embeddingRuns.status, "queued"))).returning();
    if (updated.length === 0) return null;
    return mapRun(updated[0]);
  });
}

export async function cancelActiveEmbeddingRun(_ownerTelegramId: bigint): Promise<EmbeddingRunInfo | null> {
  return db.transaction(async (tx) => {
    const active = await tx.query.embeddingRuns.findFirst({
      where: inArray(embeddingRuns.status, ["queued", "running"]),
      orderBy: [desc(embeddingRuns.createdAt)]
    });

    if (!active) {
      return null;
    }

    const now = new Date();
    const updated = await tx
      .update(embeddingRuns)
      .set({
        status: "cancelled",
        lastError: "Stopped by user",
        finishedAt: now,
        currentChatPeerId: null,
        updatedAt: now
      })
      .where(and(eq(embeddingRuns.id, active.id), inArray(embeddingRuns.status, ["queued", "running"])))
      .returning();

    if (updated.length === 0) {
      return null;
    }

    await tx
      .update(embeddingTargets)
      .set({ status: "pending", updatedAt: now })
      .where(eq(embeddingTargets.status, "embedding"));

    return mapRun(updated[0]);
  });
}

export async function setEmbeddingRunCurrentChat(runId: number, _ownerTelegramId: bigint, chatPeerId: bigint | null) {
  await db.update(embeddingRuns).set({ currentChatPeerId: chatPeerId, updatedAt: new Date() }).where(eq(embeddingRuns.id, runId));
}

export async function completeEmbeddingRun(runId: number, _ownerTelegramId: bigint) {
  await db.update(embeddingRuns).set({ status: "completed", currentChatPeerId: null, finishedAt: new Date(), etaSeconds: 0, updatedAt: new Date() }).where(eq(embeddingRuns.id, runId));
}

export async function failEmbeddingRun(runId: number, _ownerTelegramId: bigint, errorMessage: string) {
  await db.update(embeddingRuns).set({ status: "failed", lastError: errorMessage, finishedAt: new Date(), currentChatPeerId: null, updatedAt: new Date() }).where(eq(embeddingRuns.id, runId));
}

export async function updateEmbeddingRunProgress(runId: number, _ownerTelegramId: bigint, payload: { estimatedMessages?: number; estimatedMessagesDelta?: number; processedMessagesDelta?: number; completedChatsDelta?: number; etaSeconds?: number | null; }) {
  const updates: Partial<typeof embeddingRuns.$inferInsert> = { updatedAt: new Date() };
  if (typeof payload.etaSeconds !== "undefined") updates.etaSeconds = payload.etaSeconds;
  if (typeof payload.estimatedMessages === "number") updates.estimatedMessages = payload.estimatedMessages;
  if (typeof payload.estimatedMessagesDelta === "number") updates.estimatedMessages = sql`${embeddingRuns.estimatedMessages} + ${payload.estimatedMessagesDelta}` as unknown as number;
  if (typeof payload.processedMessagesDelta === "number") updates.processedMessages = sql`${embeddingRuns.processedMessages} + ${payload.processedMessagesDelta}` as unknown as number;
  if (typeof payload.completedChatsDelta === "number") updates.completedChats = sql`${embeddingRuns.completedChats} + ${payload.completedChatsDelta}` as unknown as number;
  await db.update(embeddingRuns).set(updates).where(eq(embeddingRuns.id, runId));
}

export async function setEmbeddingTargetStatus(_ownerTelegramId: bigint, chatPeerId: bigint, status: EmbeddingTargetStatus, lastError: string | null = null) {
  await db.insert(embeddingTargets).values({
    chatPeerId,
    enabled: true,
    status,
    lastError,
    lastEmbeddedAt: status === "embedded" ? new Date() : null,
    updatedAt: new Date()
  }).onConflictDoUpdate({
    target: embeddingTargets.chatPeerId,
    set: {
      status,
      lastError,
      lastEmbeddedAt: status === "embedded" ? new Date() : embeddingTargets.lastEmbeddedAt,
      updatedAt: new Date()
    }
  });
}

export async function loadEmbeddingCheckpoint(_ownerTelegramId: bigint, chatPeerId: bigint): Promise<EmbeddingCheckpointState> {
  const row = await db.query.embeddingCheckpoints.findFirst({ where: eq(embeddingCheckpoints.chatPeerId, chatPeerId) });
  if (!row) return { nextMessageId: null, backfillComplete: false, lastProcessedAt: null, lastError: null };
  return { nextMessageId: row.nextMessageId, backfillComplete: row.backfillComplete, lastProcessedAt: row.lastProcessedAt, lastError: row.lastError };
}

export async function saveEmbeddingCheckpoint(_ownerTelegramId: bigint, chatPeerId: bigint, payload: { nextMessageId: number | null; backfillComplete: boolean; lastError?: string | null; }) {
  await db.insert(embeddingCheckpoints).values({
    chatPeerId,
    nextMessageId: payload.nextMessageId,
    backfillComplete: payload.backfillComplete,
    lastProcessedAt: new Date(),
    lastError: payload.lastError ?? null,
    updatedAt: new Date()
  }).onConflictDoUpdate({
    target: embeddingCheckpoints.chatPeerId,
    set: {
      nextMessageId: payload.nextMessageId,
      backfillComplete: payload.backfillComplete,
      lastProcessedAt: new Date(),
      lastError: payload.lastError ?? null,
      updatedAt: new Date()
    }
  });
}

export async function listPendingMessagesForEmbedding(_ownerTelegramId: bigint, chatPeerId: bigint, model: string, afterMessageId: number, limit: number): Promise<PendingEmbeddingMessage[]> {
  const rows = await db
    .select({ messageId: telegramMessages.messageId, text: telegramMessages.text, updatedAt: telegramMessages.updatedAt })
    .from(telegramMessages)
    .leftJoin(
      telegramMessageEmbeddings,
      and(eq(telegramMessageEmbeddings.chatPeerId, telegramMessages.chatPeerId), eq(telegramMessageEmbeddings.messageId, telegramMessages.messageId))
    )
    .where(
      and(
        eq(telegramMessages.chatPeerId, chatPeerId),
        sql`${telegramMessages.messageId} > ${afterMessageId}`,
        embeddableMessagePredicate(),
        sql`(${telegramMessageEmbeddings.id} is null or ${telegramMessageEmbeddings.model} <> ${model} or ${telegramMessageEmbeddings.sourceUpdatedAt} < ${telegramMessages.updatedAt})`
      )
    )
    .orderBy(asc(telegramMessages.messageId))
    .limit(limit);

  return rows.filter((row) => typeof row.text === "string" && row.text.trim().length > 0).map((row) => ({ messageId: row.messageId, text: row.text ?? "", updatedAt: row.updatedAt }));
}

export async function countPendingEmbeddingsForChat(_ownerTelegramId: bigint, chatPeerId: bigint, model: string): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(telegramMessages)
    .leftJoin(
      telegramMessageEmbeddings,
      and(eq(telegramMessageEmbeddings.chatPeerId, telegramMessages.chatPeerId), eq(telegramMessageEmbeddings.messageId, telegramMessages.messageId))
    )
    .where(
      and(
        eq(telegramMessages.chatPeerId, chatPeerId),
        embeddableMessagePredicate(),
        sql`(${telegramMessageEmbeddings.id} is null or ${telegramMessageEmbeddings.model} <> ${model} or ${telegramMessageEmbeddings.sourceUpdatedAt} < ${telegramMessages.updatedAt})`
      )
    );
  return rows[0]?.value ?? 0;
}

export async function countEligibleEmbeddingsForChat(_ownerTelegramId: bigint, chatPeerId: bigint): Promise<number> {
  const rows = await db.select({ value: sql<number>`count(*)::int` }).from(telegramMessages).where(and(eq(telegramMessages.chatPeerId, chatPeerId), embeddableMessagePredicate()));
  return rows[0]?.value ?? 0;
}

export async function upsertMessageEmbeddings(_ownerTelegramId: bigint, items: MessageEmbeddingUpsert[]) {
  if (items.length === 0) return;
  const now = new Date();
  await db
    .insert(telegramMessageEmbeddings)
    .values(
      items.map((item) => ({
        chatPeerId: item.chatPeerId,
        messageId: item.messageId,
        model: item.model,
        dimensions: item.embedding.length,
        embedding: item.embedding,
        sourceUpdatedAt: item.sourceUpdatedAt,
        sourceText: item.sourceText,
        updatedAt: now
      }))
    )
    .onConflictDoUpdate({
      target: [telegramMessageEmbeddings.chatPeerId, telegramMessageEmbeddings.messageId],
      set: {
        model: sql`excluded.model`,
        dimensions: sql`excluded.dimensions`,
        embedding: sql`excluded.embedding`,
        sourceUpdatedAt: sql`excluded.source_updated_at`,
        sourceText: sql`excluded.source_text`,
        updatedAt: sql`excluded.updated_at`
      }
    });
}

export async function clearEmbeddingData(_ownerTelegramId: bigint) {
  await db.transaction(async (tx) => {
    await tx.delete(telegramMessageEmbeddings);
    await tx.delete(embeddingCheckpoints);
    await tx.delete(embeddingRunLogs);
    await tx.delete(embeddingRuns);
    await tx.delete(embeddingTargets);
  });
}

export async function resetChatEmbeddings(_ownerTelegramId: bigint, chatPeerId: bigint) {
  await db.transaction(async (tx) => {
    await tx.delete(telegramMessageEmbeddings).where(eq(telegramMessageEmbeddings.chatPeerId, chatPeerId));
    await tx.delete(embeddingCheckpoints).where(eq(embeddingCheckpoints.chatPeerId, chatPeerId));
    await tx.insert(embeddingTargets).values({
      chatPeerId,
      enabled: true,
      status: "pending",
      estimatedMessages: null,
      estimatedEtaSeconds: null,
      lastEmbeddedAt: null,
      lastError: null,
      updatedAt: new Date()
    }).onConflictDoUpdate({
      target: embeddingTargets.chatPeerId,
      set: {
        enabled: true,
        status: "pending",
        estimatedMessages: null,
        estimatedEtaSeconds: null,
        lastEmbeddedAt: null,
        lastError: null,
        updatedAt: new Date()
      }
    });
  });
}

export async function listEmbeddingRunChats(run: EmbeddingRunInfo): Promise<EmbeddingCatalogChat[]> {
  if (run.chatPeerIds.length === 0) return [];
  const catalog = await listEmbeddingCatalogChats(0n, run.model);
  const byPeerId = new Map(catalog.map((chat) => [chat.peerId.toString(), chat]));
  return run.chatPeerIds.map((peerId) => byPeerId.get(peerId.toString())).filter((v): v is EmbeddingCatalogChat => Boolean(v));
}
