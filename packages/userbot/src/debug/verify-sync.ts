import {
  countStoredChatMessages,
  db,
  mtprotoSessions,
  sql as dbSql,
  syncCheckpoints,
  syncRunLogs,
  syncRuns,
  syncTargets,
  telegramChats
} from "@userbrot/core";
import { getOwnerTelegramId } from "@userbrot/core/env";
import { and, desc, eq, sql } from "drizzle-orm";

const rawChatId = process.env.SYNC_VERIFY_CHAT_ID;
if (!rawChatId || !/^\d+$/.test(rawChatId)) {
  console.error("Set SYNC_VERIFY_CHAT_ID=<numeric chat id>");
  process.exit(1);
}

const chatPeerId = BigInt(rawChatId);

const ownerFromEnv = getOwnerTelegramId();
const inferredSession = ownerFromEnv
  ? null
  : await db.query.mtprotoSessions.findFirst({
      orderBy: [desc(mtprotoSessions.createdAt)]
    });
const ownerTelegramId = ownerFromEnv ?? inferredSession?.ownerTelegramId;

if (!ownerTelegramId) {
  console.error("Could not resolve owner Telegram ID. Set OWNER_TELEGRAM_ID or complete setup first.");
  await dbSql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}

try {
  const [chatRow, targetRow, checkpointRow] = await Promise.all([
    db.query.telegramChats.findFirst({
      where: and(eq(telegramChats.ownerTelegramId, ownerTelegramId), eq(telegramChats.peerId, chatPeerId))
    }),
    db.query.syncTargets.findFirst({
      where: and(eq(syncTargets.ownerTelegramId, ownerTelegramId), eq(syncTargets.chatPeerId, chatPeerId))
    }),
    db.query.syncCheckpoints.findFirst({
      where: and(eq(syncCheckpoints.ownerTelegramId, ownerTelegramId), eq(syncCheckpoints.chatPeerId, chatPeerId))
    })
  ]);

  const chat = chatRow ?? null;
  const target = targetRow ?? null;
  const checkpoint = checkpointRow ?? null;

  const storedMessages = await countStoredChatMessages(ownerTelegramId, chatPeerId);

  const runCandidates = await db
    .select()
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.ownerTelegramId, ownerTelegramId),
        sql`${syncRuns.chatPeerIds} @> ${JSON.stringify([chatPeerId.toString()])}::jsonb`
      )
    )
    .orderBy(desc(syncRuns.createdAt))
    .limit(1);

  const latestRun = runCandidates[0] ?? null;

  const recentLogs = latestRun
    ? await db.query.syncRunLogs.findMany({
        where: and(eq(syncRunLogs.ownerTelegramId, ownerTelegramId), eq(syncRunLogs.runId, latestRun.id)),
        orderBy: [desc(syncRunLogs.createdAt)],
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
    ownerTelegramId: ownerTelegramId.toString(),
    chatPeerId: chatPeerId.toString(),
    chat: chat
      ? {
          title: chat.title,
          username: chat.username,
          isBot: chat.isBot,
          lastMessageId: chat.lastMessageId,
          lastMessageDate: chat.lastMessageDate
        }
      : null,
    target: target
      ? {
          enabled: target.enabled,
          status: target.status,
          estimatedMessages: target.estimatedMessages,
          estimatedEtaSeconds: target.estimatedEtaSeconds,
          lastSyncedAt: target.lastSyncedAt,
          lastError: target.lastError
        }
      : null,
    checkpoint: checkpoint
      ? {
          nextOffset: checkpoint.nextOffset,
          nextMaxId: checkpoint.nextMaxId,
          newestMessageId: checkpoint.newestMessageId,
          oldestMessageId: checkpoint.oldestMessageId,
          backfillComplete: checkpoint.backfillComplete,
          lastProcessedAt: checkpoint.lastProcessedAt,
          lastError: checkpoint.lastError
        }
      : null,
    storedMessages,
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
    recentLogs: logs,
    hints: {
      estimateLooksLowerBound:
        target !== null &&
        target.status !== "synced" &&
        target.estimatedMessages !== null &&
        target.estimatedEtaSeconds === null,
      resumableCursorPresent:
        checkpoint !== null && (checkpoint.nextOffset !== null || checkpoint.oldestMessageId !== null)
    }
  });
} finally {
  await dbSql.end({ timeout: 5 }).catch(() => undefined);
}

process.exit(0);
