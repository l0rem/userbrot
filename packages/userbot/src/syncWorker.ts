import {
    appendSyncRunLog,
    completeSyncRun,
    countStoredChatMessages,
    failSyncRun,
    listRunChats,
    loadSyncCheckpoint,
    saveSyncCheckpoint,
    setRunCurrentChat,
    setTargetEstimate,
    setTargetStatus,
    storeNormalizedMessages,
    type NormalizedMessageMedia,
    type NormalizedSyncMessage,
    type SyncRunInfo,
    updateRunProgress,
} from "@userbrot/core";
import { type TelegramClient, type Message, tl } from "@mtcute/node";
import { sleep, normalizeErrorMessage } from "./utils";

const INTER_BATCH_DELAY_MS = 1100;
const HISTORY_BATCH_SIZE = 100;
const DIALOG_CACHE_WARM_LIMIT = 5000;

let dialogCacheWarmPromise: Promise<void> | null = null;
let dialogCacheWarmedOnce = false;

function isLocalCachePeerError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    return /not found in local cache/i.test(error.message);
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

export class SyncWorker {
    constructor(private client: TelegramClient) { }

    async warmDialogCache(force = false): Promise<void> {
        if (dialogCacheWarmedOnce && !force) {
            return;
        }

        if (dialogCacheWarmPromise) {
            return dialogCacheWarmPromise;
        }

        dialogCacheWarmPromise = (async () => {
            for await (const _dialog of this.client.iterDialogs({
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

    async withSafeHistoryCall<T>(fn: () => Promise<T>): Promise<T> {
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

    async getHistoryWithPeerRecovery(
        chatPeerId: bigint,
        params: {
            limit: number;
            offsetId?: number;
            addOffset?: number;
        }
    ): Promise<Message[]> {
        try {
            return await this.withSafeHistoryCall(() => this.client.getHistory(Number(chatPeerId), params as any));
        } catch (error) {
            if (!isLocalCachePeerError(error)) {
                throw error;
            }

            await this.warmDialogCache(true);
            return this.withSafeHistoryCall(() => this.client.getHistory(Number(chatPeerId), params as any));
        }
    }

    async estimateRemainingMessages(chatPeerId: bigint): Promise<number | null> {
        void chatPeerId;
        return null;
    }

    computeEtaSeconds(processedMessages: number, elapsedMs: number, remainingMessages: number): number | null {
        if (processedMessages <= 0 || elapsedMs <= 0 || remainingMessages <= 0) {
            return null;
        }

        const throughput = processedMessages / (elapsedMs / 1000);
        if (throughput <= 0) {
            return null;
        }

        return Math.ceil(remainingMessages / throughput);
    }

    async processChat(
        run: SyncRunInfo,
        chatPeerId: bigint,
        knownEstimate: number | null
    ): Promise<void> {
        const checkpoint = await loadSyncCheckpoint(run.ownerTelegramId, chatPeerId);

        const estimatedMessages = await this.estimateRemainingMessages(chatPeerId);
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

        const firstPage = await this.getHistoryWithPeerRecovery(chatPeerId, {
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
                const page = await this.getHistoryWithPeerRecovery(chatPeerId, {
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
            const page = await this.getHistoryWithPeerRecovery(chatPeerId, {
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
                    ? this.computeEtaSeconds(processedInChat, elapsedMs, Math.max(estimatedMessages - processedInChat, 0))
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

    async processRun(run: SyncRunInfo): Promise<void> {
        await appendSyncRunLog(run.id, run.ownerTelegramId, "Worker claimed sync run", "info", {
            chatPeerIds: run.chatPeerIds.map((value) => value.toString())
        });

        try {
            await this.warmDialogCache();
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
                await this.processChat(run, chat.peerId, chat.estimatedMessages);
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
}
