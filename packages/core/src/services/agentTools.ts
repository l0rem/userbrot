import OpenAI from "openai";
import { and, desc, eq, inArray, sql, gte, lte, count, between, gt, lt } from "drizzle-orm";
import { db } from "../db/client";
import { requireEmbeddingProviderConfig } from "../env";
import { telegramChats, telegramMessageEmbeddings, telegramMessages, syncCheckpoints } from "../db/schema";

type ChatCandidate = {
    chatId: string;
    title: string;
    type: string;
    lastMessageDate: string | null;
};

export async function findCandidateChats(query?: string): Promise<ChatCandidate[]> {
    const conditions = [];
    if (query && query.trim().length > 0) {
        conditions.push(sql`${telegramChats.title} ILIKE ${`%${query.trim()}%`}`);
    }

    const rows = await db
        .select({
            chatId: telegramChats.peerId,
            title: telegramChats.title,
            type: telegramChats.peerType,
            lastMessageDate: telegramChats.lastMessageDate,
        })
        .from(telegramChats)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(telegramChats.lastMessageDate))
        .limit(20);

    return rows.map((r) => ({
        chatId: r.chatId.toString(),
        title: r.title,
        type: r.type,
        lastMessageDate: r.lastMessageDate?.toISOString() ?? null,
    }));
}

type SearchMessageParams = {
    query: string;
    chatIds?: string[];
    limit?: number;
};

type SearchResult = {
    messageId: number;
    chatId: string;
    chatTitle: string;
    date: string;
    text: string;
    isOutgoing: boolean;
    distance: number;
};

export async function searchMessages(params: SearchMessageParams): Promise<SearchResult[]> {
    const embeddingProvider = requireEmbeddingProviderConfig();
    const embeddingClient = new OpenAI({
        apiKey: embeddingProvider.apiKey,
        baseURL: embeddingProvider.baseUrl
    });

    const embeddingResult = await embeddingClient.embeddings.create({
        model: embeddingProvider.model,
        input: params.query.trim()
    });

    const queryEmbedding = embeddingResult.data[0]?.embedding;
    if (!queryEmbedding || queryEmbedding.length === 0) {
        return [];
    }

    const queryVectorStr = `[${queryEmbedding.map((v) => Number(v).toString()).join(",")}]`;
    const distanceExpr = sql<number>`${telegramMessageEmbeddings.embedding} <=> ${queryVectorStr}::vector`;

    const conditions = [
        sql`${telegramMessageEmbeddings.model} = ${embeddingProvider.model}`,
        sql`${telegramMessages.text} is not null and length(trim(${telegramMessages.text})) > 0`,
        eq(telegramMessages.isService, false),
        eq(telegramMessages.isDeleted, false)
    ];

    if (params.chatIds && params.chatIds.length > 0) {
        const peerIds = params.chatIds.map(id => BigInt(id));
        conditions.push(inArray(telegramMessages.chatPeerId, peerIds));
    }

    const rows = await db
        .select({
            chatPeerId: telegramMessages.chatPeerId,
            messageId: telegramMessages.messageId,
            date: telegramMessages.date,
            text: telegramMessages.text,
            isOutgoing: telegramMessages.isOutgoing,
            chatTitle: telegramChats.title,
            distance: distanceExpr
        })
        .from(telegramMessageEmbeddings)
        .innerJoin(
            telegramMessages,
            sql`${telegramMessages.chatPeerId} = ${telegramMessageEmbeddings.chatPeerId} and ${telegramMessages.messageId} = ${telegramMessageEmbeddings.messageId}`
        )
        .innerJoin(
            telegramChats,
            eq(telegramChats.peerId, telegramMessages.chatPeerId)
        )
        .where(and(...conditions))
        .orderBy(distanceExpr, desc(telegramMessages.date))
        .limit(params.limit ?? 15);

    return rows
        .filter((row) => Number.isFinite(row.distance) && row.distance <= 0.8)
        .map((row) => ({
            messageId: row.messageId,
            chatId: row.chatPeerId.toString(),
            chatTitle: row.chatTitle,
            date: row.date.toISOString(),
            text: row.text ?? "",
            isOutgoing: row.isOutgoing,
            distance: row.distance
        }));
}

type ExpandContextParams = {
    chatId: string;
    messageId: number;
    limitBefore?: number;
    limitAfter?: number;
};

type ContextMessage = {
    messageId: number;
    date: string;
    text: string | null;
    isOutgoing: boolean;
};

export async function expandContext(params: ExpandContextParams): Promise<ContextMessage[]> {
    const peerId = BigInt(params.chatId);
    const before = params.limitBefore ?? 5;
    const after = params.limitAfter ?? 2;

    const baseConditions = [
        eq(telegramMessages.chatPeerId, peerId),
        eq(telegramMessages.isService, false),
        eq(telegramMessages.isDeleted, false)
    ];

    // Fetch messages BEFORE (and including) the target messageId
    const beforeRows = await db
        .select({
            messageId: telegramMessages.messageId,
            date: telegramMessages.date,
            text: telegramMessages.text,
            isOutgoing: telegramMessages.isOutgoing
        })
        .from(telegramMessages)
        .where(
            and(
                ...baseConditions,
                lte(telegramMessages.messageId, params.messageId)
            )
        )
        .orderBy(desc(telegramMessages.messageId))
        .limit(before + 1); // +1 to include the target itself

    // Fetch messages AFTER the target messageId
    const afterRows = await db
        .select({
            messageId: telegramMessages.messageId,
            date: telegramMessages.date,
            text: telegramMessages.text,
            isOutgoing: telegramMessages.isOutgoing
        })
        .from(telegramMessages)
        .where(
            and(
                ...baseConditions,
                gte(telegramMessages.messageId, params.messageId + 1)
            )
        )
        .orderBy(telegramMessages.messageId)
        .limit(after);

    // Combine: beforeRows is desc, so reverse it, then append afterRows
    const combined = [...beforeRows.reverse(), ...afterRows];

    // Deduplicate by messageId (the target message might appear in both)
    const seen = new Set<number>();
    return combined
        .filter(row => {
            if (seen.has(row.messageId)) return false;
            seen.add(row.messageId);
            return true;
        })
        .map(row => ({
            messageId: row.messageId,
            date: row.date.toISOString(),
            text: row.text,
            isOutgoing: row.isOutgoing
        }));
}

// ============================================================================
// CHAT METADATA TOOLS
// ============================================================================

export type ChatMetadata = {
    chatId: string;
    title: string;
    type: string;
    firstMessageDate: string | null;
    lastMessageDate: string | null;
    totalMessages: number;
    syncStatus: "never_synced" | "syncing" | "synced" | "error";
};

export async function getChatMetadata(chatId: string): Promise<ChatMetadata | null> {
    const peerId = BigInt(chatId);

    const [chatRow] = await db
        .select()
        .from(telegramChats)
        .where(eq(telegramChats.peerId, peerId))
        .limit(1);

    if (!chatRow) return null;

    const [statsRow] = await db
        .select({
            firstDate: sql<Date | null>`min(${telegramMessages.date})`,
            lastDate: sql<Date | null>`max(${telegramMessages.date})`,
            total: count()
        })
        .from(telegramMessages)
        .where(
            and(
                eq(telegramMessages.chatPeerId, peerId),
                eq(telegramMessages.isDeleted, false),
                eq(telegramMessages.isService, false)
            )
        );

    const [checkpointRow] = await db
        .select()
        .from(syncCheckpoints)
        .where(eq(syncCheckpoints.chatPeerId, peerId))
        .limit(1);

    let syncStatus: ChatMetadata["syncStatus"] = "never_synced";
    if (checkpointRow) {
        if (checkpointRow.backfillComplete) syncStatus = "synced";
        else if (checkpointRow.lastError) syncStatus = "error";
        else syncStatus = "syncing";
    }

    return {
        chatId: chatRow.peerId.toString(),
        title: chatRow.title,
        type: chatRow.peerType,
        firstMessageDate: statsRow?.firstDate?.toISOString() ?? null,
        lastMessageDate: statsRow?.lastDate?.toISOString() ?? null,
        totalMessages: statsRow?.total ?? 0,
        syncStatus
    };
}

export type ChatOverview = {
    chatId: string;
    title: string;
    type: string;
    firstMessageDate: string | null;
    lastMessageDate: string | null;
    totalMessages: number;
};

export async function getAllChatsOverview(options?: { limit?: number }): Promise<ChatOverview[]> {
    const limit = options?.limit ?? 50;

    const chats = await db
        .select({
            chatPeerId: telegramChats.peerId,
            title: telegramChats.title,
            type: telegramChats.peerType,
            lastMessageDate: telegramChats.lastMessageDate
        })
        .from(telegramChats)
        .orderBy(desc(telegramChats.lastMessageDate))
        .limit(limit);

    const results: ChatOverview[] = [];

    for (const chat of chats) {
        const [stats] = await db
            .select({
                firstDate: sql<Date | null>`min(${telegramMessages.date})`,
                lastDate: sql<Date | null>`max(${telegramMessages.date})`,
                total: count()
            })
            .from(telegramMessages)
            .where(
                and(
                    eq(telegramMessages.chatPeerId, chat.chatPeerId),
                    eq(telegramMessages.isDeleted, false),
                    eq(telegramMessages.isService, false)
                )
            );

        results.push({
            chatId: chat.chatPeerId.toString(),
            title: chat.title,
            type: chat.type,
            firstMessageDate: stats?.firstDate?.toISOString() ?? null,
            lastMessageDate: stats?.lastDate?.toISOString() ?? chat.lastMessageDate?.toISOString() ?? null,
            totalMessages: stats?.total ?? 0
        });
    }

    return results.sort((a, b) => {
        if (!a.lastMessageDate && !b.lastMessageDate) return 0;
        if (!a.lastMessageDate) return 1;
        if (!b.lastMessageDate) return -1;
        return new Date(b.lastMessageDate).getTime() - new Date(a.lastMessageDate).getTime();
    });
}

// ============================================================================
// TIME-RANGE MESSAGE RETRIEVAL TOOLS
// ============================================================================

export type TimeRangeMessage = {
    messageId: number;
    date: string;
    text: string | null;
    isOutgoing: boolean;
};

export type GetMessagesInRangeParams = {
    chatId: string;
    startDate: string;
    endDate: string;
    limit?: number;
};

export async function getMessagesInRange(params: GetMessagesInRangeParams): Promise<TimeRangeMessage[]> {
    const peerId = BigInt(params.chatId);
    const start = new Date(params.startDate);
    const end = new Date(params.endDate);
    const limit = params.limit ?? 100;

    const rows = await db
        .select({
            messageId: telegramMessages.messageId,
            date: telegramMessages.date,
            text: telegramMessages.text,
            isOutgoing: telegramMessages.isOutgoing
        })
        .from(telegramMessages)
        .where(
            and(
                eq(telegramMessages.chatPeerId, peerId),
                between(telegramMessages.date, start, end),
                eq(telegramMessages.isDeleted, false),
                eq(telegramMessages.isService, false)
            )
        )
        .orderBy(telegramMessages.date)
        .limit(limit);

    return rows.map(row => ({
        messageId: row.messageId,
        date: row.date.toISOString(),
        text: row.text,
        isOutgoing: row.isOutgoing
    }));
}

export type GetRecentMessagesParams = {
    chatId: string;
    limit?: number;
};

export async function getRecentMessages(params: GetRecentMessagesParams): Promise<TimeRangeMessage[]> {
    const peerId = BigInt(params.chatId);
    const limit = params.limit ?? 20;

    const rows = await db
        .select({
            messageId: telegramMessages.messageId,
            date: telegramMessages.date,
            text: telegramMessages.text,
            isOutgoing: telegramMessages.isOutgoing
        })
        .from(telegramMessages)
        .where(
            and(
                eq(telegramMessages.chatPeerId, peerId),
                eq(telegramMessages.isDeleted, false),
                eq(telegramMessages.isService, false)
            )
        )
        .orderBy(desc(telegramMessages.date))
        .limit(limit);

    return rows.reverse().map(row => ({
        messageId: row.messageId,
        date: row.date.toISOString(),
        text: row.text,
        isOutgoing: row.isOutgoing
    }));
}

// ============================================================================
// ACTIVITY/STATISTICS TOOLS
// ============================================================================

export type ActivityBucket = {
    period: string;
    messageCount: number;
    incomingCount: number;
    outgoingCount: number;
};

export type GetActivitySummaryParams = {
    chatId: string;
    granularity: "day" | "week" | "month";
    startDate?: string;
    endDate?: string;
};

export async function getChatActivitySummary(params: GetActivitySummaryParams): Promise<ActivityBucket[]> {
    const peerId = BigInt(params.chatId);
    const granularity = params.granularity ?? "day";
    const start = params.startDate ? new Date(params.startDate) : undefined;
    const end = params.endDate ? new Date(params.endDate) : undefined;

    const conditions = [
        eq(telegramMessages.chatPeerId, peerId),
        eq(telegramMessages.isDeleted, false),
        eq(telegramMessages.isService, false)
    ];

    if (start) conditions.push(gte(telegramMessages.date, start));
    if (end) conditions.push(lte(telegramMessages.date, end));

    let truncExpr: ReturnType<typeof sql>;
    if (granularity === "day") {
        truncExpr = sql<string>`date_trunc('day', ${telegramMessages.date})`;
    } else if (granularity === "week") {
        truncExpr = sql<string>`date_trunc('week', ${telegramMessages.date})`;
    } else {
        truncExpr = sql<string>`date_trunc('month', ${telegramMessages.date})`;
    }

    const rows = await db
        .select({
            period: truncExpr,
            total: count(),
            incoming: sql<number>`sum(case when ${telegramMessages.isOutgoing} = false then 1 else 0 end)`,
            outgoing: sql<number>`sum(case when ${telegramMessages.isOutgoing} = true then 1 else 0 end)`
        })
        .from(telegramMessages)
        .where(and(...conditions))
        .groupBy(truncExpr)
        .orderBy(sql`period DESC`)
        .limit(30);

    return rows.map(row => ({
        period: String(row.period),
        messageCount: row.total,
        incomingCount: Number(row.incoming),
        outgoingCount: Number(row.outgoing)
    }));
}

export type GetMessageCountParams = {
    chatId?: string;
    startDate: string;
    endDate: string;
};

export type MessageCountResult = {
    chatId: string | null;
    chatTitle: string | null;
    messageCount: number;
    incomingCount: number;
    outgoingCount: number;
};

export async function getMessageCountByPeriod(params: GetMessageCountParams): Promise<MessageCountResult[]> {
    const start = new Date(params.startDate);
    const end = new Date(params.endDate);

    if (params.chatId) {
        const peerId = BigInt(params.chatId);

        const [chatRow] = await db
            .select({ title: telegramChats.title })
            .from(telegramChats)
            .where(eq(telegramChats.peerId, peerId))
            .limit(1);

        const [stats] = await db
            .select({
                total: count(),
                incoming: sql<number>`sum(case when ${telegramMessages.isOutgoing} = false then 1 else 0 end)`,
                outgoing: sql<number>`sum(case when ${telegramMessages.isOutgoing} = true then 1 else 0 end)`
            })
            .from(telegramMessages)
            .where(
                and(
                    eq(telegramMessages.chatPeerId, peerId),
                    between(telegramMessages.date, start, end),
                    eq(telegramMessages.isDeleted, false),
                    eq(telegramMessages.isService, false)
                )
            );

        return [{
            chatId: params.chatId,
            chatTitle: chatRow?.title ?? null,
            messageCount: stats?.total ?? 0,
            incomingCount: Number(stats?.incoming ?? 0),
            outgoingCount: Number(stats?.outgoing ?? 0)
        }];
    }

    const rows = await db
        .select({
            chatPeerId: telegramMessages.chatPeerId,
            chatTitle: telegramChats.title,
            total: count(),
            incoming: sql<number>`sum(case when ${telegramMessages.isOutgoing} = false then 1 else 0 end)`,
            outgoing: sql<number>`sum(case when ${telegramMessages.isOutgoing} = true then 1 else 0 end)`
        })
        .from(telegramMessages)
        .innerJoin(
            telegramChats,
            eq(telegramChats.peerId, telegramMessages.chatPeerId)
        )
        .where(
            and(
                between(telegramMessages.date, start, end),
                eq(telegramMessages.isDeleted, false),
                eq(telegramMessages.isService, false)
            )
        )
        .groupBy(telegramMessages.chatPeerId, telegramChats.title)
        .orderBy(desc(sql`total`))
        .limit(20);

    return rows.map(row => ({
        chatId: row.chatPeerId.toString(),
        chatTitle: row.chatTitle,
        messageCount: row.total,
        incomingCount: Number(row.incoming),
        outgoingCount: Number(row.outgoing)
    }));
}

// ============================================================================
// DATE-AWARE SEARCH TOOLS
// ============================================================================

export type SearchMessagesByDateParams = {
    query: string;
    chatIds?: string[];
    startDate?: string;
    endDate?: string;
    limit?: number;
};

export type DateSearchResult = {
    messageId: number;
    chatId: string;
    chatTitle: string;
    date: string;
    text: string;
    isOutgoing: boolean;
};

export async function searchMessagesByDate(params: SearchMessagesByDateParams): Promise<DateSearchResult[]> {
    const limit = params.limit ?? 20;
    const searchTerms = params.query.trim().split(/\s+/).filter(t => t.length >= 2);

    if (searchTerms.length === 0) return [];

    const conditions = [
        eq(telegramMessages.isDeleted, false),
        eq(telegramMessages.isService, false),
        sql`${telegramMessages.text} is not null and length(trim(${telegramMessages.text})) > 0`
    ];

    for (const term of searchTerms) {
        conditions.push(sql`${telegramMessages.text} ILIKE ${`%${term}%`}`);
    }

    if (params.chatIds && params.chatIds.length > 0) {
        const peerIds = params.chatIds.map(id => BigInt(id));
        conditions.push(inArray(telegramMessages.chatPeerId, peerIds));
    }

    if (params.startDate) {
        conditions.push(gte(telegramMessages.date, new Date(params.startDate)));
    }
    if (params.endDate) {
        conditions.push(lte(telegramMessages.date, new Date(params.endDate)));
    }

    const rows = await db
        .select({
            messageId: telegramMessages.messageId,
            chatPeerId: telegramMessages.chatPeerId,
            date: telegramMessages.date,
            text: telegramMessages.text,
            isOutgoing: telegramMessages.isOutgoing,
            chatTitle: telegramChats.title
        })
        .from(telegramMessages)
        .innerJoin(
            telegramChats,
            eq(telegramChats.peerId, telegramMessages.chatPeerId)
        )
        .where(and(...conditions))
        .orderBy(desc(telegramMessages.date))
        .limit(limit);

    return rows.map(row => ({
        messageId: row.messageId,
        chatId: row.chatPeerId.toString(),
        chatTitle: row.chatTitle,
        date: row.date.toISOString(),
        text: row.text ?? "",
        isOutgoing: row.isOutgoing
    }));
}

export type FindConversationsParams = {
    aroundDate: string;
    windowDays?: number;
    limit?: number;
};

export type ConversationHit = {
    chatId: string;
    chatTitle: string;
    messageCount: number;
    firstMessageDate: string;
    lastMessageDate: string;
};

export async function findConversationsAroundDate(params: FindConversationsParams): Promise<ConversationHit[]> {
    const center = new Date(params.aroundDate);
    const windowDays = params.windowDays ?? 7;
    const limit = params.limit ?? 10;

    const start = new Date(center);
    start.setDate(start.getDate() - windowDays);
    const end = new Date(center);
    end.setDate(end.getDate() + windowDays);

    const rows = await db
        .select({
            chatPeerId: telegramMessages.chatPeerId,
            chatTitle: telegramChats.title,
            messageCount: count(),
            firstDate: sql<Date>`min(${telegramMessages.date})`,
            lastDate: sql<Date>`max(${telegramMessages.date})`
        })
        .from(telegramMessages)
        .innerJoin(
            telegramChats,
            eq(telegramChats.peerId, telegramMessages.chatPeerId)
        )
        .where(
            and(
                between(telegramMessages.date, start, end),
                eq(telegramMessages.isDeleted, false),
                eq(telegramMessages.isService, false)
            )
        )
        .groupBy(telegramMessages.chatPeerId, telegramChats.title)
        .orderBy(desc(sql`messageCount`))
        .limit(limit);

    return rows.map(row => ({
        chatId: row.chatPeerId.toString(),
        chatTitle: row.chatTitle,
        messageCount: row.messageCount,
        firstMessageDate: row.firstDate.toISOString(),
        lastMessageDate: row.lastDate.toISOString()
    }));
}

