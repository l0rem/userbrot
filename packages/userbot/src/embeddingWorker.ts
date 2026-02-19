import {
    appendEmbeddingRunLog,
    claimQueuedEmbeddingRun,
    completeEmbeddingRun,
    countEligibleEmbeddingsForChat,
    countPendingEmbeddingsForChat,
    failEmbeddingRun,
    getEmbeddingRunById,
    listEmbeddingRunChats,
    listPendingMessagesForEmbedding,
    loadEmbeddingCheckpoint,
    saveEmbeddingCheckpoint,
    setEmbeddingRunCurrentChat,
    setEmbeddingTargetEstimate,
    setEmbeddingTargetStatus,
    upsertMessageEmbeddings,
    type EmbeddingRunInfo,
    updateEmbeddingRunProgress,
    embedBatch
} from "@userbrot/core";

import { sleep, normalizeErrorMessage, parseStatusCodeFromError, chunkArray } from "./utils";

const EMBEDDING_BATCH_SIZE = 128;
const EMBEDDING_REQUEST_CONCURRENCY = 3;
const EMBEDDING_CHAT_MAX_ATTEMPTS = 4;

export class EmbeddingRunStoppedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EmbeddingRunStoppedError";
    }
}

export async function assertEmbeddingRunIsActive(run: EmbeddingRunInfo): Promise<void> {
    const latest = await getEmbeddingRunById(run.ownerTelegramId, run.id);
    if (!latest) {
        throw new EmbeddingRunStoppedError(`Embedding run ${run.id} no longer exists`);
    }

    if (latest.status === "cancelled") {
        throw new EmbeddingRunStoppedError(`Embedding run ${run.id} was stopped by user`);
    }

    if (latest.status === "completed" || latest.status === "failed") {
        throw new EmbeddingRunStoppedError(`Embedding run ${run.id} already finished with status ${latest.status}`);
    }
}

async function processEmbeddingChat(
    run: EmbeddingRunInfo,
    chatPeerId: bigint,
    knownEstimate: number | null
): Promise<void> {
    await assertEmbeddingRunIsActive(run);

    const checkpoint = await loadEmbeddingCheckpoint(run.ownerTelegramId, chatPeerId);
    const estimatedMessages = await countPendingEmbeddingsForChat(run.ownerTelegramId, chatPeerId, run.model);

    await appendEmbeddingRunLog(
        run.id,
        run.ownerTelegramId,
        checkpoint.nextMessageId && checkpoint.nextMessageId > 0
            ? `Resuming embeddings chat ${chatPeerId.toString()} from checkpoint ${checkpoint.nextMessageId}`
            : `Starting embeddings chat ${chatPeerId.toString()}`,
        "info",
        {
            chatPeerId: chatPeerId.toString(),
            checkpointNextMessageId: checkpoint.nextMessageId,
            checkpointBackfillComplete: checkpoint.backfillComplete
        }
    );

    await setEmbeddingTargetEstimate(run.ownerTelegramId, chatPeerId, {
        estimatedMessages,
        estimatedEtaSeconds: null
    });

    if (knownEstimate === null) {
        await updateEmbeddingRunProgress(run.id, run.ownerTelegramId, {
            estimatedMessagesDelta: estimatedMessages
        });
    }

    await setEmbeddingTargetStatus(run.ownerTelegramId, chatPeerId, "embedding");
    await setEmbeddingRunCurrentChat(run.id, run.ownerTelegramId, chatPeerId);

    let processedInChat = 0;
    let nextMessageId = checkpoint.nextMessageId ?? 0;
    let wrappedToStart = false;

    while (true) {
        await assertEmbeddingRunIsActive(run);

        const rows = await listPendingMessagesForEmbedding(
            run.ownerTelegramId,
            chatPeerId,
            run.model,
            nextMessageId,
            EMBEDDING_BATCH_SIZE * EMBEDDING_REQUEST_CONCURRENCY
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

        const rowChunks = chunkArray(rows, EMBEDDING_BATCH_SIZE);

        await Promise.all(
            rowChunks.map(async (rowChunk) => {
                const vectors = await embedBatch(rowChunk.map((row) => row.text));

                await upsertMessageEmbeddings(
                    run.ownerTelegramId,
                    rowChunk.map((row, index) => ({
                        chatPeerId,
                        messageId: row.messageId,
                        model: run.model,
                        embedding: vectors[index],
                        sourceUpdatedAt: row.updatedAt,
                        sourceText: row.text
                    }))
                );
            })
        );

        nextMessageId = rows[rows.length - 1]?.messageId ?? nextMessageId;
        processedInChat += rows.length;

        await saveEmbeddingCheckpoint(run.ownerTelegramId, chatPeerId, {
            nextMessageId,
            backfillComplete: false
        });

        await updateEmbeddingRunProgress(run.id, run.ownerTelegramId, {
            processedMessagesDelta: rows.length
        });

        await appendEmbeddingRunLog(run.id, run.ownerTelegramId, "Embedded message batch", "info", {
            chatPeerId: chatPeerId.toString(),
            batchSize: rows.length,
            nextMessageId,
            processedInChat,
            targetMessages: estimatedMessages
        });
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
        estimatedEtaSeconds: null
    });
    await setEmbeddingTargetStatus(run.ownerTelegramId, chatPeerId, status, null);
    await updateEmbeddingRunProgress(run.id, run.ownerTelegramId, {
        completedChatsDelta: 1
    });
    await appendEmbeddingRunLog(run.id, run.ownerTelegramId, `Chat ${chatPeerId.toString()} embeddings updated`, "info", {
        processedMessages: processedInChat,
        pendingAfter,
        eligibleTotal,
        nextMessageId
    });
}

export async function processEmbeddingRun(run: EmbeddingRunInfo): Promise<void> {
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
        await assertEmbeddingRunIsActive(run);

        let chatProcessed = false;

        for (let attempt = 1; attempt <= EMBEDDING_CHAT_MAX_ATTEMPTS; attempt += 1) {
            try {
                await assertEmbeddingRunIsActive(run);
                await processEmbeddingChat(run, chat.peerId, chat.estimatedMessages);
                chatProcessed = true;
                break;
            } catch (error) {
                if (error instanceof EmbeddingRunStoppedError) {
                    throw error;
                }

                const errorMessage = normalizeErrorMessage(error);
                const statusCode = parseStatusCodeFromError(error);
                const existing = await loadEmbeddingCheckpoint(run.ownerTelegramId, chat.peerId);

                await saveEmbeddingCheckpoint(run.ownerTelegramId, chat.peerId, {
                    nextMessageId: existing.nextMessageId,
                    backfillComplete: existing.backfillComplete,
                    lastError: errorMessage
                });

                if (attempt < EMBEDDING_CHAT_MAX_ATTEMPTS) {
                    const delayMs = Math.ceil(1200 * attempt * attempt + Math.random() * 1000);

                    await setEmbeddingTargetStatus(run.ownerTelegramId, chat.peerId, "embedding", errorMessage);

                    await appendEmbeddingRunLog(
                        run.id,
                        run.ownerTelegramId,
                        `Embedding chat ${chat.peerId.toString()} failed, retrying attempt ${attempt + 1}/${EMBEDDING_CHAT_MAX_ATTEMPTS}`,
                        "warn",
                        {
                            runId: run.id,
                            chatPeerId: chat.peerId.toString(),
                            attempt,
                            maxAttempts: EMBEDDING_CHAT_MAX_ATTEMPTS,
                            delayMs,
                            statusCode,
                            error: errorMessage,
                            nextMessageId: existing.nextMessageId,
                            backfillComplete: existing.backfillComplete
                        }
                    );

                    console.error("[embeddings] chat attempt failed, retrying", {
                        runId: run.id,
                        chatPeerId: chat.peerId.toString(),
                        attempt,
                        maxAttempts: EMBEDDING_CHAT_MAX_ATTEMPTS,
                        delayMs,
                        statusCode,
                        error: errorMessage,
                        nextMessageId: existing.nextMessageId,
                        backfillComplete: existing.backfillComplete
                    });

                    await sleep(delayMs);
                    continue;
                }

                await setEmbeddingTargetStatus(run.ownerTelegramId, chat.peerId, "error", errorMessage);
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
                        runId: run.id,
                        chatPeerId: chat.peerId.toString(),
                        attempt,
                        maxAttempts: EMBEDDING_CHAT_MAX_ATTEMPTS,
                        statusCode,
                        error: errorMessage,
                        nextMessageId: existing.nextMessageId,
                        backfillComplete: existing.backfillComplete
                    }
                );

                console.error("[embeddings] chat failed after retries, skipping", {
                    runId: run.id,
                    chatPeerId: chat.peerId.toString(),
                    attempt,
                    maxAttempts: EMBEDDING_CHAT_MAX_ATTEMPTS,
                    statusCode,
                    error: errorMessage,
                    nextMessageId: existing.nextMessageId,
                    backfillComplete: existing.backfillComplete
                });
            }
        }

        if (!chatProcessed) {
            continue;
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
