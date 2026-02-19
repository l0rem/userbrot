import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  db,
  mtprotoSessions,
  sql as dbSql,
  syncCheckpoints,
  syncTargets,
  telegramChats,
  telegramMessageMedia,
  telegramMessages
} from "@userbrot/core";
import { asc, desc, eq } from "drizzle-orm";

function asJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

const backupRoot = process.env.SYNC_BACKUP_DIR?.trim() || "data/backups";
const label = process.env.SYNC_BACKUP_LABEL?.trim() || "snapshot";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = join(backupRoot, `${timestamp}-${label}`);

const session = await db.query.mtprotoSessions.findFirst({
  orderBy: [desc(mtprotoSessions.updatedAt)]
});

const accountTelegramId = session?.ownerTelegramId ?? 1n;

try {
  await mkdir(outputDir, { recursive: true });

  const chats = await db.query.telegramChats.findMany({
    orderBy: [asc(telegramChats.title), asc(telegramChats.peerId)]
  });

  const targets = await db.query.syncTargets.findMany({
    orderBy: [asc(syncTargets.chatPeerId)]
  });

  const checkpoints = await db.query.syncCheckpoints.findMany({
    orderBy: [asc(syncCheckpoints.chatPeerId)]
  });

  const allMessagesPath = join(outputDir, "messages.jsonl");
  const allMediaPath = join(outputDir, "media.jsonl");
  await writeFile(allMessagesPath, "");
  await writeFile(allMediaPath, "");

  let totalMessages = 0;
  let totalMedia = 0;

  for (const chat of chats) {
    const messages = await db.query.telegramMessages.findMany({
      where: eq(telegramMessages.chatPeerId, chat.peerId),
      orderBy: [asc(telegramMessages.messageId)]
    });

    const media = await db.query.telegramMessageMedia.findMany({
      where: eq(telegramMessageMedia.chatPeerId, chat.peerId),
      orderBy: [asc(telegramMessageMedia.messageId), asc(telegramMessageMedia.id)]
    });

    totalMessages += messages.length;
    totalMedia += media.length;

    await writeFile(
      join(outputDir, `chat-${chat.peerId.toString()}.json`),
      asJson({
        chat,
        messages,
        media
      })
    );

    if (messages.length > 0) {
      await appendFile(allMessagesPath, `${messages.map((row) => asJson(row)).join("\n")}\n`);
    }

    if (media.length > 0) {
      await appendFile(allMediaPath, `${media.map((row) => asJson(row)).join("\n")}\n`);
    }
  }

  await writeFile(join(outputDir, "chats.jsonl"), chats.map((row) => asJson(row)).join("\n") + (chats.length ? "\n" : ""));
  await writeFile(
    join(outputDir, "sync-targets.jsonl"),
    targets.map((row) => asJson(row)).join("\n") + (targets.length ? "\n" : "")
  );
  await writeFile(
    join(outputDir, "sync-checkpoints.jsonl"),
    checkpoints.map((row) => asJson(row)).join("\n") + (checkpoints.length ? "\n" : "")
  );

  await writeFile(
    join(outputDir, "manifest.json"),
    asJson({
      createdAt: new Date().toISOString(),
      accountTelegramId,
      chatCount: chats.length,
      messageCount: totalMessages,
      mediaCount: totalMedia,
      includes: [
        "telegram_chats",
        "telegram_messages",
        "telegram_message_media",
        "sync_targets",
        "sync_checkpoints"
      ]
    })
  );

  console.log(
    asJson({
      ok: true,
      outputDir,
      accountTelegramId,
      chatCount: chats.length,
      messageCount: totalMessages,
      mediaCount: totalMedia
    })
  );
} finally {
  await dbSql.end({ timeout: 5 }).catch(() => undefined);
}

process.exit(0);
