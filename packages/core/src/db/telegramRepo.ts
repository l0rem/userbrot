import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "./client";
import {
    telegramChats,
    telegramMessages,
    telegramMessageMedia
} from "./schema";

export type DiscoveredPrivateChat = {
    peerId: bigint;
    title: string;
    username: string | null;
    isBot: boolean;
    folderIds: number[];
    lastMessageId: number | null;
    lastMessageDate: Date | null;
};

export type NormalizedMessageMedia = {
    mediaType: string;
    fileId?: string | null;
    fileUniqueId?: string | null;
    mimeType?: string | null;
    fileName?: string | null;
    durationSeconds?: number | null;
    width?: number | null;
    height?: number | null;
    sizeBytes?: number | null;
    raw?: Record<string, unknown> | null;
};

export type NormalizedSyncMessage = {
    messageId: number;
    senderPeerId: bigint | null;
    date: Date;
    editDate: Date | null;
    text: string | null;
    isOutgoing: boolean;
    isService: boolean;
    isDeleted: boolean;
    hasMedia: boolean;
    raw: Record<string, unknown> | null;
    media: NormalizedMessageMedia[];
};

export async function upsertDiscoveredPrivateChats(_ownerTelegramId: bigint, chats: DiscoveredPrivateChat[]) {
    if (chats.length === 0) return;
    const now = new Date();

    for (const chat of chats) {
        await db
            .insert(telegramChats)
            .values({
                peerId: chat.peerId,
                peerType: "user",
                title: chat.title,
                username: chat.username,
                isBot: chat.isBot,
                folderIds: chat.folderIds,
                lastMessageId: chat.lastMessageId,
                lastMessageDate: chat.lastMessageDate,
                updatedAt: now
            })
            .onConflictDoUpdate({
                target: telegramChats.peerId,
                set: {
                    title: chat.title,
                    username: chat.username,
                    isBot: chat.isBot,
                    folderIds: chat.folderIds,
                    lastMessageId: chat.lastMessageId,
                    lastMessageDate: chat.lastMessageDate,
                    updatedAt: now
                }
            });
    }
}

export async function storeNormalizedMessages(_ownerTelegramId: bigint, chatPeerId: bigint, messages: NormalizedSyncMessage[]) {
    if (messages.length === 0) return;
    const now = new Date();
    const messageIds = messages.map((m) => m.messageId);

    await db.transaction(async (tx) => {
        for (const message of messages) {
            await tx.insert(telegramMessages).values({
                chatPeerId,
                messageId: message.messageId,
                senderPeerId: message.senderPeerId,
                date: message.date,
                editDate: message.editDate,
                text: message.text,
                isOutgoing: message.isOutgoing,
                isService: message.isService,
                isDeleted: message.isDeleted,
                hasMedia: message.hasMedia,
                raw: message.raw,
                updatedAt: now
            }).onConflictDoUpdate({
                target: [telegramMessages.chatPeerId, telegramMessages.messageId],
                set: {
                    senderPeerId: message.senderPeerId,
                    date: message.date,
                    editDate: message.editDate,
                    text: message.text,
                    isOutgoing: message.isOutgoing,
                    isService: message.isService,
                    isDeleted: message.isDeleted,
                    hasMedia: message.hasMedia,
                    raw: message.raw,
                    updatedAt: now
                }
            });
        }

        await tx.delete(telegramMessageMedia).where(and(eq(telegramMessageMedia.chatPeerId, chatPeerId), inArray(telegramMessageMedia.messageId, messageIds)));

        const mediaRows = messages.flatMap((message) => message.media.map((media) => ({
            chatPeerId,
            messageId: message.messageId,
            mediaType: media.mediaType,
            fileId: media.fileId ?? null,
            fileUniqueId: media.fileUniqueId ?? null,
            mimeType: media.mimeType ?? null,
            fileName: media.fileName ?? null,
            durationSeconds: media.durationSeconds ?? null,
            width: media.width ?? null,
            height: media.height ?? null,
            sizeBytes: media.sizeBytes ?? null,
            raw: media.raw ?? null,
            createdAt: now,
            updatedAt: now
        })));

        if (mediaRows.length > 0) {
            await tx.insert(telegramMessageMedia).values(mediaRows);
        }
    });
}

export async function countStoredChatMessages(_ownerTelegramId: bigint, chatPeerId: bigint): Promise<number> {
    const result = await db.select({ value: sql<number>`count(*)::int` }).from(telegramMessages).where(eq(telegramMessages.chatPeerId, chatPeerId));
    return result[0]?.value ?? 0;
}

export const telegramRepo = {
    upsertDiscoveredPrivateChats,
    storeNormalizedMessages,
    countStoredChatMessages
};
