import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  db,
  mtprotoSessions,
  sql as dbSql,
  telegramChats,
  telegramMessageMedia,
  telegramMessages
} from "@userbrot/core";
import { and, desc, eq, inArray } from "drizzle-orm";

type BackupPayload = {
  chat: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  media: Array<Record<string, unknown>>;
};

const chatIdRaw = process.env.IMPORT_CHAT_PEER_ID?.trim();
if (!chatIdRaw || !/^\d+$/.test(chatIdRaw)) {
  console.error("Set IMPORT_CHAT_PEER_ID=<numeric chat peer id>");
  process.exit(1);
}

const backupDir = process.env.SYNC_BACKUP_DIR?.trim();
if (!backupDir) {
  console.error("Set SYNC_BACKUP_DIR to backup folder path (e.g. data/backups/2026-...-snapshot)");
  process.exit(1);
}

const filePath = join(backupDir, `chat-${chatIdRaw}.json`);

function parseDate(value: unknown): Date | null {
  return typeof value === "string" && value.length > 0 ? new Date(value) : null;
}

function parseBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  return null;
}

const chatPeerId = BigInt(chatIdRaw);

const session = await db.query.mtprotoSessions.findFirst({
  orderBy: [desc(mtprotoSessions.updatedAt)]
});

if (!session) {
  console.error("No MTProto session found. Complete setup first.");
  await dbSql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}

try {
  const raw = await readFile(filePath, "utf8");
  const payload = JSON.parse(raw) as BackupPayload;

  const chat = payload.chat;
  const messages = payload.messages ?? [];
  const media = payload.media ?? [];

  await db
    .insert(telegramChats)
    .values({
      peerId: chatPeerId,
      peerType: typeof chat.peerType === "string" ? chat.peerType : "user",
      title: typeof chat.title === "string" ? chat.title : `chat ${chatPeerId.toString()}`,
      username: typeof chat.username === "string" ? chat.username : null,
      isBot: Boolean(chat.isBot),
      folderIds: Array.isArray(chat.folderIds) ? (chat.folderIds as number[]) : [],
      lastMessageId: typeof chat.lastMessageId === "number" ? chat.lastMessageId : null,
      lastMessageDate: parseDate(chat.lastMessageDate),
      createdAt: parseDate(chat.createdAt) ?? new Date(),
      updatedAt: parseDate(chat.updatedAt) ?? new Date()
    })
    .onConflictDoUpdate({
      target: telegramChats.peerId,
      set: {
        title: typeof chat.title === "string" ? chat.title : `chat ${chatPeerId.toString()}`,
        username: typeof chat.username === "string" ? chat.username : null,
        isBot: Boolean(chat.isBot),
        folderIds: Array.isArray(chat.folderIds) ? (chat.folderIds as number[]) : [],
        lastMessageId: typeof chat.lastMessageId === "number" ? chat.lastMessageId : null,
        lastMessageDate: parseDate(chat.lastMessageDate),
        updatedAt: new Date()
      }
    });

  for (const row of messages) {
    await db
      .insert(telegramMessages)
      .values({
        chatPeerId,
        messageId: Number(row.messageId ?? 0),
        senderPeerId: parseBigInt(row.senderPeerId),
        date: parseDate(row.date) ?? new Date(),
        editDate: parseDate(row.editDate),
        text: typeof row.text === "string" ? row.text : null,
        isOutgoing: Boolean(row.isOutgoing),
        isService: Boolean(row.isService),
        isDeleted: Boolean(row.isDeleted),
        hasMedia: Boolean(row.hasMedia),
        raw: (row.raw as Record<string, unknown> | null) ?? null,
        createdAt: parseDate(row.createdAt) ?? new Date(),
        updatedAt: parseDate(row.updatedAt) ?? new Date()
      })
      .onConflictDoUpdate({
        target: [telegramMessages.chatPeerId, telegramMessages.messageId],
        set: {
          senderPeerId: parseBigInt(row.senderPeerId),
          date: parseDate(row.date) ?? new Date(),
          editDate: parseDate(row.editDate),
          text: typeof row.text === "string" ? row.text : null,
          isOutgoing: Boolean(row.isOutgoing),
          isService: Boolean(row.isService),
          isDeleted: Boolean(row.isDeleted),
          hasMedia: Boolean(row.hasMedia),
          raw: (row.raw as Record<string, unknown> | null) ?? null,
          updatedAt: new Date()
        }
      });
  }

  const messageIds = messages
    .map((item) => Number(item.messageId ?? 0))
    .filter((item) => Number.isFinite(item) && item > 0);

  if (messageIds.length > 0) {
    await db
      .delete(telegramMessageMedia)
      .where(
        and(
          eq(telegramMessageMedia.chatPeerId, chatPeerId),
          inArray(telegramMessageMedia.messageId, messageIds)
        )
      );
  }

  if (media.length > 0) {
    await db.insert(telegramMessageMedia).values(
      media.map((row) => ({
        chatPeerId,
        messageId: Number(row.messageId ?? 0),
        mediaType: typeof row.mediaType === "string" ? row.mediaType : "unknown",
        fileId: typeof row.fileId === "string" ? row.fileId : null,
        fileUniqueId: typeof row.fileUniqueId === "string" ? row.fileUniqueId : null,
        mimeType: typeof row.mimeType === "string" ? row.mimeType : null,
        fileName: typeof row.fileName === "string" ? row.fileName : null,
        durationSeconds: typeof row.durationSeconds === "number" ? row.durationSeconds : null,
        width: typeof row.width === "number" ? row.width : null,
        height: typeof row.height === "number" ? row.height : null,
        sizeBytes: typeof row.sizeBytes === "number" ? row.sizeBytes : null,
        raw: (row.raw as Record<string, unknown> | null) ?? null,
        createdAt: parseDate(row.createdAt) ?? new Date(),
        updatedAt: parseDate(row.updatedAt) ?? new Date()
      }))
    );
  }

  console.log(
    JSON.stringify({
      ok: true,
      filePath,
      chatPeerId: chatPeerId.toString(),
      importedMessages: messages.length,
      importedMedia: media.length
    })
  );
} finally {
  await dbSql.end({ timeout: 5 }).catch(() => undefined);
}

process.exit(0);
