import {
  countEligibleEmbeddingsForChat,
  countPendingEmbeddingsForChat,
  db,
  embeddingCheckpoints,
  embeddingRunLogs,
  embeddingRuns,
  embeddingTargets,
  mtprotoSessions,
  sql as dbSql,
  telegramChats
} from "@userbrot/core";
import { requireEmbeddingProviderConfig } from "@userbrot/core/env";
import { desc, eq, sql } from "drizzle-orm";

const rawChatId = process.env.EMBEDDINGS_VERIFY_CHAT_ID;
if (!rawChatId || !/^\d+$/.test(rawChatId)) {
  console.error("Set EMBEDDINGS_VERIFY_CHAT_ID=<numeric chat id>");
  process.exit(1);
}

const chatPeerId = BigInt(rawChatId);
const model = requireEmbeddingProviderConfig().model;

const inferredSession = await db.query.mtprotoSessions.findFirst({
  orderBy: [desc(mtprotoSessions.createdAt)]
});
if (!inferredSession) {
  console.error("Could not resolve owner Telegram ID. Complete setup first.");
  await dbSql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}

try {
  const [chatRow, targetRow, checkpointRow] = await Promise.all([
    db.query.telegramChats.findFirst({
      where: eq(telegramChats.peerId, chatPeerId)
    }),
    db.query.embeddingTargets.findFirst({
      where: eq(embeddingTargets.chatPeerId, chatPeerId)
    }),
    db.query.embeddingCheckpoints.findFirst({
      where: eq(embeddingCheckpoints.chatPeerId, chatPeerId)
    })
  ]);

  const eligibleMessages = await countEligibleEmbeddingsForChat(0n, chatPeerId);
  const pendingMessages = await countPendingEmbeddingsForChat(0n, chatPeerId, model);

  const runCandidates = await db
    .select()
    .from(embeddingRuns)
    .where(sql`${embeddingRuns.chatPeerIds} @> ${JSON.stringify([chatPeerId.toString()])}::jsonb`)
    .orderBy(desc(embeddingRuns.createdAt))
    .limit(1);

  const latestRun = runCandidates[0] ?? null;

  const recentLogs = latestRun
    ? await db.query.embeddingRunLogs.findMany({
        where: eq(embeddingRunLogs.runId, latestRun.id),
        orderBy: [desc(embeddingRunLogs.createdAt)],
        limit: 8
      })
    : [];

  const logs = recentLogs
    .slice()
    .reverse()
    .map((item) => ({
      at: item.createdAt.toISOString(),
      level: item.level,
      message: item.message
    }));

  console.log({
    ownerTelegramId: "singleton",
    chatPeerId: chatPeerId.toString(),
    model,
    chat: chatRow
      ? {
          title: chatRow.title,
          username: chatRow.username,
          lastMessageId: chatRow.lastMessageId,
          lastMessageDate: chatRow.lastMessageDate
        }
      : null,
    target: targetRow
      ? {
          enabled: targetRow.enabled,
          status: targetRow.status,
          estimatedMessages: targetRow.estimatedMessages,
          estimatedEtaSeconds: targetRow.estimatedEtaSeconds,
          lastEmbeddedAt: targetRow.lastEmbeddedAt,
          lastError: targetRow.lastError
        }
      : null,
    checkpoint: checkpointRow
      ? {
          nextMessageId: checkpointRow.nextMessageId,
          backfillComplete: checkpointRow.backfillComplete,
          lastProcessedAt: checkpointRow.lastProcessedAt,
          lastError: checkpointRow.lastError
        }
      : null,
    eligibleMessages,
    pendingMessages,
    latestRun: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          totalChats: latestRun.totalChats,
          completedChats: latestRun.completedChats,
          estimatedMessages: latestRun.estimatedMessages,
          processedMessages: latestRun.processedMessages,
          etaSeconds: latestRun.etaSeconds,
          currentChatPeerId: latestRun.currentChatPeerId,
          startedAt: latestRun.startedAt,
          finishedAt: latestRun.finishedAt,
          lastError: latestRun.lastError
        }
      : null,
    recentLogs: logs
  });
} finally {
  await dbSql.end({ timeout: 5 }).catch(() => undefined);
}

process.exit(0);
