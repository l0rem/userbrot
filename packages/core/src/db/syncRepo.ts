import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./client";
import {
    syncCheckpoints,
    syncRunLogs,
    syncRuns,
    syncTargets,
    telegramChats,
    telegramMessages,
    telegramMessageMedia,
    type SyncRunStatus,
    type SyncTargetStatus
} from "./schema";

export type SyncCatalogChat = {
    peerId: bigint;
    title: string;
    username: string | null;
    isBot: boolean;
    folderIds: number[];
    lastMessageId: number | null;
    lastMessageDate: Date | null;
    selected: boolean;
    status: SyncTargetStatus;
    isSynced: boolean;
    estimatedMode: "exact" | "lower_bound" | "unknown";
    estimatedMessages: number | null;
    estimatedEtaSeconds: number | null;
    lastSyncedAt: Date | null;
    lastError: string | null;
};

export type SyncRunLog = {
    id: number;
    runId: number;
    level: string;
    message: string;
    meta: Record<string, unknown> | null;
    createdAt: Date;
};

export type SyncRunInfo = {
    id: number;
    ownerTelegramId: bigint;
    status: SyncRunStatus;
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

export type SyncStatusSnapshot = {
    activeRun: SyncRunInfo | null;
    latestRun: SyncRunInfo | null;
    logs: SyncRunLog[];
};

export type SyncCheckpointState = {
    nextOffset: number | null;
    nextMaxId: number | null;
    newestMessageId: number | null;
    oldestMessageId: number | null;
    backfillComplete: boolean;
    lastProcessedAt: Date | null;
    lastError: string | null;
};

function decodeChatPeerIds(raw: string[]): bigint[] {
    return raw.map((value) => BigInt(value));
}

function encodeChatPeerIds(ids: bigint[]): string[] {
    return ids.map((value) => value.toString());
}

function mapRun(row: typeof syncRuns.$inferSelect): SyncRunInfo {
    return {
        id: row.id,
        ownerTelegramId: 0n,
        status: row.status,
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

function sanitizeEstimatedMessages(estimatedMessages: number | null): number | null {
    if (estimatedMessages === null) return null;
    const TELEGRAM_TOTAL_SENTINEL = 2_147_483_647;
    if (estimatedMessages >= TELEGRAM_TOTAL_SENTINEL || estimatedMessages > 1_000_000_000) return null;
    if (estimatedMessages < 0) return 0;
    return estimatedMessages;
}

export async function listSyncCatalogChats(_ownerTelegramId?: bigint): Promise<SyncCatalogChat[]> {
    const storedMessageCounts = await db
        .select({ chatPeerId: telegramMessages.chatPeerId, total: sql<number>`count(*)::int` })
        .from(telegramMessages)
        .groupBy(telegramMessages.chatPeerId);
    const storedCountByPeerId = new Map(storedMessageCounts.map((row) => [row.chatPeerId.toString(), row.total]));

    const rows = await db
        .select({
            peerId: telegramChats.peerId,
            title: telegramChats.title,
            username: telegramChats.username,
            isBot: telegramChats.isBot,
            lastMessageId: telegramChats.lastMessageId,
            lastMessageDate: telegramChats.lastMessageDate,
            folderIds: telegramChats.folderIds,
            selected: syncTargets.enabled,
            targetStatus: syncTargets.status,
            targetEstimatedMessages: syncTargets.estimatedMessages,
            targetEstimatedEtaSeconds: syncTargets.estimatedEtaSeconds,
            targetLastSyncedAt: syncTargets.lastSyncedAt,
            targetLastError: syncTargets.lastError,
            checkpointBackfillComplete: syncCheckpoints.backfillComplete
        })
        .from(telegramChats)
        .leftJoin(syncTargets, eq(syncTargets.chatPeerId, telegramChats.peerId))
        .leftJoin(syncCheckpoints, eq(syncCheckpoints.chatPeerId, telegramChats.peerId))
        .orderBy(asc(telegramChats.title));

    return rows.map((row) => {
        const checkpointBackfillComplete = row.checkpointBackfillComplete ?? false;
        const status = checkpointBackfillComplete && (!row.targetStatus || row.targetStatus === "pending")
            ? "synced"
            : (row.targetStatus ?? "pending");
        const selected = row.selected ?? false;
        const isSynced = status === "synced" && checkpointBackfillComplete;
        const syncedStoredCount = isSynced ? (storedCountByPeerId.get(row.peerId.toString()) ?? 0) : null;
        const rawEstimatedMessages = isSynced ? syncedStoredCount : sanitizeEstimatedMessages(row.targetEstimatedMessages);
        const shouldExposeEstimate = status === "syncing" || status === "synced" || (status === "pending" && selected);
        const estimatedMessages = shouldExposeEstimate ? rawEstimatedMessages : null;
        const estimatedMode: SyncCatalogChat["estimatedMode"] = !shouldExposeEstimate
            ? "unknown"
            : estimatedMessages === null
                ? "unknown"
                : status === "synced" || row.targetEstimatedEtaSeconds !== null
                    ? "exact"
                    : "lower_bound";
        const estimatedEtaSeconds =
            !shouldExposeEstimate || estimatedMessages === null
                ? null
                : status === "synced"
                    ? 0
                    : estimatedMode === "exact"
                        ? (row.targetEstimatedEtaSeconds ?? null)
                        : null;

        return {
            peerId: row.peerId,
            title: row.title,
            username: row.username,
            isBot: row.isBot,
            lastMessageId: row.lastMessageId,
            lastMessageDate: row.lastMessageDate,
            folderIds: row.folderIds,
            selected,
            status,
            isSynced,
            estimatedMode,
            estimatedMessages,
            estimatedEtaSeconds,
            lastSyncedAt: row.targetLastSyncedAt,
            lastError: row.targetLastError
        };
    });
}

export async function setSyncTargets(_ownerTelegramId: bigint, chatPeerIds: bigint[]) {
    const now = new Date();
    await db.update(syncTargets).set({ enabled: false, updatedAt: now });

    for (const chatPeerId of chatPeerIds) {
        const existing = await db.query.syncTargets.findFirst({ where: eq(syncTargets.chatPeerId, chatPeerId) });
        const keepSynced = existing?.status === "synced";

        await db
            .insert(syncTargets)
            .values({
                chatPeerId,
                enabled: true,
                status: keepSynced ? "synced" : "pending",
                estimatedMessages: keepSynced ? (existing?.estimatedMessages ?? null) : null,
                estimatedEtaSeconds: keepSynced ? (existing?.estimatedEtaSeconds ?? null) : null,
                lastSyncedAt: keepSynced ? (existing?.lastSyncedAt ?? null) : null,
                lastError: null,
                updatedAt: now
            })
            .onConflictDoUpdate({
                target: syncTargets.chatPeerId,
                set: {
                    enabled: true,
                    status: keepSynced ? "synced" : "pending",
                    estimatedMessages: keepSynced ? (existing?.estimatedMessages ?? null) : null,
                    estimatedEtaSeconds: keepSynced ? (existing?.estimatedEtaSeconds ?? null) : null,
                    lastSyncedAt: keepSynced ? (existing?.lastSyncedAt ?? null) : null,
                    lastError: null,
                    updatedAt: now
                }
            });
    }
}

export async function setTargetEstimate(_ownerTelegramId: bigint, chatPeerId: bigint, estimate: { estimatedMessages: number | null; estimatedEtaSeconds: number | null; }) {
    await db
        .insert(syncTargets)
        .values({
            chatPeerId,
            enabled: true,
            estimatedMessages: estimate.estimatedMessages,
            estimatedEtaSeconds: estimate.estimatedEtaSeconds,
            updatedAt: new Date()
        })
        .onConflictDoUpdate({
            target: syncTargets.chatPeerId,
            set: {
                estimatedMessages: estimate.estimatedMessages,
                estimatedEtaSeconds: estimate.estimatedEtaSeconds,
                updatedAt: new Date()
            }
        });
}

export async function enqueueSyncRun(ownerTelegramId: bigint, chatPeerIds: bigint[]): Promise<SyncRunInfo> {
    if (chatPeerIds.length === 0) throw new Error("Select at least one chat to sync");
    const active = await getActiveSyncRun(ownerTelegramId);
    if (active) return active;

    await setSyncTargets(ownerTelegramId, chatPeerIds);
    const inserted = await db.insert(syncRuns).values({
        status: "queued",
        chatPeerIds: encodeChatPeerIds(chatPeerIds),
        totalChats: chatPeerIds.length,
        completedChats: 0,
        estimatedMessages: 0,
        processedMessages: 0,
        createdAt: new Date(),
        updatedAt: new Date()
    }).returning();

    const run = inserted[0];
    await appendSyncRunLog(run.id, ownerTelegramId, "Sync run queued", "info", { chatCount: chatPeerIds.length });
    return mapRun(run);
}

export async function getActiveSyncRun(_ownerTelegramId?: bigint) {
    const run = await db.query.syncRuns.findFirst({
        where: inArray(syncRuns.status, ["queued", "running"]),
        orderBy: [desc(syncRuns.createdAt)]
    });
    return run ? mapRun(run) : null;
}

export async function getLatestSyncRun(_ownerTelegramId?: bigint) {
    const run = await db.query.syncRuns.findFirst({ orderBy: [desc(syncRuns.createdAt)] });
    return run ? mapRun(run) : null;
}

export async function listSyncRunLogs(_ownerTelegramId: bigint, runId: number, limit = 80): Promise<SyncRunLog[]> {
    const rows = await db.query.syncRunLogs.findMany({ where: eq(syncRunLogs.runId, runId), orderBy: [desc(syncRunLogs.createdAt)], limit });
    return rows.map((row) => ({ id: row.id, runId: row.runId, level: row.level, message: row.message, meta: row.meta ?? null, createdAt: row.createdAt })).reverse();
}

export async function getSyncStatusSnapshot(ownerTelegramId: bigint): Promise<SyncStatusSnapshot> {
    const activeRun = await getActiveSyncRun(ownerTelegramId);
    const latestRun = activeRun ?? (await getLatestSyncRun(ownerTelegramId));
    const logs = latestRun ? await listSyncRunLogs(ownerTelegramId, latestRun.id, 80) : [];
    return { activeRun, latestRun, logs };
}

export async function appendSyncRunLog(runId: number, _ownerTelegramId: bigint, message: string, level: string, meta: Record<string, unknown> | null = null) {
    await db.insert(syncRunLogs).values({ runId, level, message, meta, createdAt: new Date() });
}

export async function claimQueuedSyncRun(_ownerTelegramId: bigint): Promise<SyncRunInfo | null> {
    return db.transaction(async (tx) => {
        const queued = await tx.query.syncRuns.findFirst({ where: eq(syncRuns.status, "queued"), orderBy: [asc(syncRuns.createdAt)] });
        if (!queued) return null;
        const updated = await tx.update(syncRuns).set({ status: "running", startedAt: new Date(), updatedAt: new Date() }).where(and(eq(syncRuns.id, queued.id), eq(syncRuns.status, "queued"))).returning();
        if (updated.length === 0) return null;
        return mapRun(updated[0]);
    });
}

export async function setRunCurrentChat(runId: number, _ownerTelegramId: bigint, chatPeerId: bigint | null) {
    await db.update(syncRuns).set({ currentChatPeerId: chatPeerId, updatedAt: new Date() }).where(eq(syncRuns.id, runId));
}

export async function completeSyncRun(runId: number, _ownerTelegramId: bigint) {
    await db.update(syncRuns).set({ status: "completed", currentChatPeerId: null, finishedAt: new Date(), etaSeconds: 0, updatedAt: new Date() }).where(eq(syncRuns.id, runId));
}

export async function failSyncRun(runId: number, _ownerTelegramId: bigint, errorMessage: string) {
    await db.update(syncRuns).set({ status: "failed", lastError: errorMessage, finishedAt: new Date(), currentChatPeerId: null, updatedAt: new Date() }).where(eq(syncRuns.id, runId));
}

export async function updateRunProgress(runId: number, _ownerTelegramId: bigint, payload: { estimatedMessages?: number; estimatedMessagesDelta?: number; processedMessagesDelta?: number; completedChatsDelta?: number; etaSeconds?: number | null; }) {
    const updates: Partial<typeof syncRuns.$inferInsert> = { updatedAt: new Date() };
    if (typeof payload.etaSeconds !== "undefined") updates.etaSeconds = payload.etaSeconds;
    if (typeof payload.estimatedMessages === "number") updates.estimatedMessages = payload.estimatedMessages;
    if (typeof payload.estimatedMessagesDelta === "number") updates.estimatedMessages = sql`${syncRuns.estimatedMessages} + ${payload.estimatedMessagesDelta}` as unknown as number;
    if (typeof payload.processedMessagesDelta === "number") updates.processedMessages = sql`${syncRuns.processedMessages} + ${payload.processedMessagesDelta}` as unknown as number;
    if (typeof payload.completedChatsDelta === "number") updates.completedChats = sql`${syncRuns.completedChats} + ${payload.completedChatsDelta}` as unknown as number;
    await db.update(syncRuns).set(updates).where(eq(syncRuns.id, runId));
}

export async function setTargetStatus(_ownerTelegramId: bigint, chatPeerId: bigint, status: SyncTargetStatus, lastError: string | null = null) {
    await db
        .insert(syncTargets)
        .values({ chatPeerId, enabled: true, status, lastError, lastSyncedAt: status === "synced" ? new Date() : null, updatedAt: new Date() })
        .onConflictDoUpdate({
            target: syncTargets.chatPeerId,
            set: { status, lastError, lastSyncedAt: status === "synced" ? new Date() : syncTargets.lastSyncedAt, updatedAt: new Date() }
        });
}

export async function loadSyncCheckpoint(_ownerTelegramId: bigint, chatPeerId: bigint): Promise<SyncCheckpointState> {
    const row = await db.query.syncCheckpoints.findFirst({ where: eq(syncCheckpoints.chatPeerId, chatPeerId) });
    if (!row) return { nextOffset: null, nextMaxId: null, newestMessageId: null, oldestMessageId: null, backfillComplete: false, lastProcessedAt: null, lastError: null };
    return { nextOffset: row.nextOffset, nextMaxId: row.nextMaxId, newestMessageId: row.newestMessageId, oldestMessageId: row.oldestMessageId, backfillComplete: row.backfillComplete, lastProcessedAt: row.lastProcessedAt, lastError: row.lastError };
}

export async function saveSyncCheckpoint(_ownerTelegramId: bigint, chatPeerId: bigint, payload: { nextOffset: number | null; nextMaxId: number | null; newestMessageId: number | null; oldestMessageId: number | null; backfillComplete: boolean; lastError?: string | null; }) {
    await db.insert(syncCheckpoints).values({
        chatPeerId,
        nextOffset: payload.nextOffset,
        nextMaxId: payload.nextMaxId,
        newestMessageId: payload.newestMessageId,
        oldestMessageId: payload.oldestMessageId,
        backfillComplete: payload.backfillComplete,
        lastProcessedAt: new Date(),
        lastError: payload.lastError ?? null,
        updatedAt: new Date()
    }).onConflictDoUpdate({
        target: syncCheckpoints.chatPeerId,
        set: {
            nextOffset: payload.nextOffset,
            nextMaxId: payload.nextMaxId,
            newestMessageId: payload.newestMessageId,
            oldestMessageId: payload.oldestMessageId,
            backfillComplete: payload.backfillComplete,
            lastProcessedAt: new Date(),
            lastError: payload.lastError ?? null,
            updatedAt: new Date()
        }
    });
}

export async function clearSyncData(_ownerTelegramId: bigint) {
    await db.transaction(async (tx) => {
        await tx.delete(telegramMessageMedia);
        await tx.delete(telegramMessages);
        await tx.delete(syncCheckpoints);
        await tx.delete(syncRunLogs);
        await tx.delete(syncRuns);
        await tx.delete(syncTargets);
        await tx.delete(telegramChats);
    });
}

export async function listRunChats(run: SyncRunInfo): Promise<SyncCatalogChat[]> {
    const ids = run.chatPeerIds;
    if (ids.length === 0) return [];
    const catalog = await listSyncCatalogChats();
    const map = new Map(catalog.map((chat) => [chat.peerId.toString(), chat]));
    return ids.map((id) => map.get(id.toString())).filter((v): v is SyncCatalogChat => Boolean(v));
}

export const syncRepo = {
    listSyncCatalogChats,
    setSyncTargets,
    setTargetEstimate,
    enqueueSyncRun,
    getActiveSyncRun,
    getLatestSyncRun,
    listSyncRunLogs,
    getSyncStatusSnapshot,
    appendSyncRunLog,
    claimQueuedSyncRun,
    setRunCurrentChat,
    completeSyncRun,
    failSyncRun,
    updateRunProgress,
    setTargetStatus,
    loadSyncCheckpoint,
    saveSyncCheckpoint,
    clearSyncData,
    listRunChats
};
