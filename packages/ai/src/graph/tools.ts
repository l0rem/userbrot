import { z } from "zod";
import { tool } from "@langchain/core/tools";
import {
    findCandidateChats,
    searchMessages,
    expandContext,
    getChatMetadata,
    getAllChatsOverview,
    getMessagesInRange,
    getRecentMessages,
    getChatActivitySummary,
    getMessageCountByPeriod,
    searchMessagesByDate,
    findConversationsAroundDate
} from "@userbrot/core";

export const findCandidateChatsTool = tool(
    async ({ query }) => {
        try {
            const results = await findCandidateChats(query ?? undefined);
            console.log("[tool:find_candidate_chats] query:", query, "-> found", results.length, "chats");
            if (results.length === 0) {
                return "No chats found matching that query. You might want to try searching without a query to get a list of active chats.";
            }
            return JSON.stringify(results, null, 2);
        } catch (error) {
            console.error("[tool:find_candidate_chats] Error:", error);
            return `Error searching for chats: ${String(error)}`;
        }
    },
    {
        name: "find_candidate_chats",
        description: "Search for available Telegram chats. Use this to find the correct chatId to pass into search_messages. Provide an optional query to filter by chat title.",
        schema: z.object({
            query: z.string().nullable().optional().describe("Optional string to filter chat titles.")
        })
    }
);

export const searchMessagesTool = tool(
    async ({ query, chatIds, limit }) => {
        try {
            const results = await searchMessages({ query, chatIds: chatIds ?? undefined, limit: limit ?? undefined });
            console.log("[tool:search_messages] query:", query, "chatIds:", chatIds, "-> found", results.length, "results");
            if (results.length > 0) {
                console.log("[tool:search_messages] Top hit:", JSON.stringify(results[0]).slice(0, 200));
            }
            if (results.length === 0) {
                return "No semantic evidence found for that query within the specified chats.";
            }
            return JSON.stringify(results, null, 2);
        } catch (error) {
            console.error("[tool:search_messages] Error:", error);
            return `Error searching messages: ${String(error)}`;
        }
    },
    {
        name: "search_messages",
        description: "Perform a semantic search across Telegram messages using a specific query. You must specify chatIds to narrow the search scope. Returns a list of message hits including text, date, messageId, and isOutgoing (true = user wrote it, false = other person wrote it).",
        schema: z.object({
            query: z.string().describe("The semantic query string to search for."),
            chatIds: z.array(z.string()).nullable().optional().describe("Array of chatIds to restrict the search to. E.g. ['123', '456']. Always specify this if you know the chat context."),
            limit: z.number().int().min(1).max(50).nullable().optional().describe("Maximum number of results to return. Default 15.")
        })
    }
);

export const expandContextTool = tool(
    async ({ chatId, messageId, limitBefore, limitAfter }) => {
        try {
            const results = await expandContext({ chatId, messageId, limitBefore: limitBefore ?? undefined, limitAfter: limitAfter ?? undefined });
            console.log("[tool:expand_context] chatId:", chatId, "messageId:", messageId, "-> found", results.length, "messages");
            if (results.length > 0) {
                console.log("[tool:expand_context] Range:", results[0].messageId, "-", results[results.length - 1].messageId);
            }
            if (results.length === 0) {
                return "No messages found surrounding that messageId in the specified chat.";
            }
            return JSON.stringify(results, null, 2);
        } catch (error) {
            console.error("[tool:expand_context] Error:", error);
            return `Error expanding context: ${String(error)}`;
        }
    },
    {
        name: "expand_context",
        description: "Fetch chronological messages surrounding a specific messageId in a chat. Useful when a search hit lacks enough conversation continuity. Returns messages with text, date, messageId, and isOutgoing (true = user, false = other person).",
        schema: z.object({
            chatId: z.string().describe("The specific chatId the message belongs to."),
            messageId: z.number().int().describe("The target messageId to expand around."),
            limitBefore: z.number().int().min(1).max(20).nullable().optional().describe("Number of messages to fetch before target. Default 5."),
            limitAfter: z.number().int().min(1).max(20).nullable().optional().describe("Number of messages to fetch after target. Default 2.")
        })
    }
);

// ============================================================================
// CHAT METADATA TOOLS
// ============================================================================

export const getChatMetadataTool = tool(
    async ({ chatId }) => {
        try {
            const result = await getChatMetadata(chatId);
            console.log("[tool:get_chat_metadata] chatId:", chatId, "->", result ? "found" : "not found");
            if (!result) {
                return `Chat ${chatId} not found in the database.`;
            }
            return JSON.stringify(result, null, 2);
        } catch (error) {
            console.error("[tool:get_chat_metadata] Error:", error);
            return `Error getting chat metadata: ${String(error)}`;
        }
    },
    {
        name: "get_chat_metadata",
        description: "Get detailed metadata about a specific chat: first message date (when chat started), last message date, total message count, and sync status. Use this to understand the temporal boundaries of a chat.",
        schema: z.object({
            chatId: z.string().describe("The chatId to get metadata for.")
        })
    }
);

export const getAllChatsOverviewTool = tool(
    async ({ limit }) => {
        try {
            const results = await getAllChatsOverview({ limit: limit ?? undefined });
            console.log("[tool:get_all_chats_overview] -> found", results.length, "chats");
            if (results.length === 0) {
                return "No chats found in the database.";
            }
            return JSON.stringify(results, null, 2);
        } catch (error) {
            console.error("[tool:get_all_chats_overview] Error:", error);
            return `Error getting chats overview: ${String(error)}`;
        }
    },
    {
        name: "get_all_chats_overview",
        description: "Get an overview of all chats with their temporal metadata: first message date, last message date, and total message count. Useful for understanding the scope and recency of all available conversations.",
        schema: z.object({
            limit: z.number().int().min(1).max(100).nullable().optional().describe("Maximum number of chats to return. Default 50.")
        })
    }
);

// ============================================================================
// TIME-RANGE MESSAGE RETRIEVAL TOOLS
// ============================================================================

export const getMessagesInRangeTool = tool(
    async ({ chatId, startDate, endDate, limit }) => {
        try {
            const results = await getMessagesInRange({ chatId, startDate, endDate, limit: limit ?? undefined });
            console.log("[tool:get_messages_in_range] chatId:", chatId, "range:", startDate, "-", endDate, "-> found", results.length, "messages");
            if (results.length === 0) {
                return `No messages found in chat ${chatId} between ${startDate} and ${endDate}.`;
            }
            return JSON.stringify(results, null, 2);
        } catch (error) {
            console.error("[tool:get_messages_in_range] Error:", error);
            return `Error getting messages in range: ${String(error)}`;
        }
    },
    {
        name: "get_messages_in_range",
        description: "Fetch all messages from a specific chat within a date range. Returns chronological messages with text, date, messageId, and isOutgoing. Use this when you need to see conversations from a specific time period.",
        schema: z.object({
            chatId: z.string().describe("The chatId to fetch messages from."),
            startDate: z.string().describe("Start date in ISO format (e.g., '2024-01-01' or '2024-01-01T00:00:00Z')."),
            endDate: z.string().describe("End date in ISO format."),
            limit: z.number().int().min(1).max(500).nullable().optional().describe("Maximum messages to return. Default 100.")
        })
    }
);

export const getRecentMessagesTool = tool(
    async ({ chatId, limit }) => {
        try {
            const results = await getRecentMessages({ chatId, limit: limit ?? undefined });
            console.log("[tool:get_recent_messages] chatId:", chatId, "-> found", results.length, "messages");
            if (results.length === 0) {
                return `No messages found in chat ${chatId}.`;
            }
            return JSON.stringify(results, null, 2);
        } catch (error) {
            console.error("[tool:get_recent_messages] Error:", error);
            return `Error getting recent messages: ${String(error)}`;
        }
    },
    {
        name: "get_recent_messages",
        description: "Fetch the most recent messages from a specific chat. Returns chronological messages with text, date, messageId, and isOutgoing. Use this to see the latest conversation activity.",
        schema: z.object({
            chatId: z.string().describe("The chatId to fetch recent messages from."),
            limit: z.number().int().min(1).max(100).nullable().optional().describe("Number of recent messages to return. Default 20.")
        })
    }
);

// ============================================================================
// ACTIVITY/STATISTICS TOOLS
// ============================================================================

export const getChatActivitySummaryTool = tool(
    async ({ chatId, granularity, startDate, endDate }) => {
        try {
            const results = await getChatActivitySummary({
                chatId,
                granularity: granularity ?? "day",
                startDate: startDate ?? undefined,
                endDate: endDate ?? undefined
            });
            console.log("[tool:get_chat_activity_summary] chatId:", chatId, "granularity:", granularity, "-> found", results.length, "buckets");
            if (results.length === 0) {
                return `No activity data found for chat ${chatId}.`;
            }
            return JSON.stringify(results, null, 2);
        } catch (error) {
            console.error("[tool:get_chat_activity_summary] Error:", error);
            return `Error getting activity summary: ${String(error)}`;
        }
    },
    {
        name: "get_chat_activity_summary",
        description: "Get message activity statistics for a chat grouped by day, week, or month. Shows message counts broken down by incoming/outgoing. Useful for understanding communication patterns and frequency.",
        schema: z.object({
            chatId: z.string().describe("The chatId to analyze."),
            granularity: z.enum(["day", "week", "month"]).nullable().optional().describe("Time granularity for grouping. Default 'day'."),
            startDate: z.string().nullable().optional().describe("Optional start date filter (ISO format)."),
            endDate: z.string().nullable().optional().describe("Optional end date filter (ISO format).")
        })
    }
);

export const getMessageCountByPeriodTool = tool(
    async ({ chatId, startDate, endDate }) => {
        try {
            const results = await getMessageCountByPeriod({
                chatId: chatId ?? undefined,
                startDate,
                endDate
            });
            console.log("[tool:get_message_count_by_period] range:", startDate, "-", endDate, "-> found", results.length, "results");
            if (results.length === 0) {
                return `No messages found between ${startDate} and ${endDate}.`;
            }
            return JSON.stringify(results, null, 2);
        } catch (error) {
            console.error("[tool:get_message_count_by_period] Error:", error);
            return `Error getting message count: ${String(error)}`;
        }
    },
    {
        name: "get_message_count_by_period",
        description: "Count messages in a specific time period, optionally for a specific chat. Shows total, incoming, and outgoing message counts. Use this to quantify communication volume in a time range.",
        schema: z.object({
            chatId: z.string().nullable().optional().describe("Optional chatId to filter. If omitted, returns counts for all chats."),
            startDate: z.string().describe("Start date in ISO format."),
            endDate: z.string().describe("End date in ISO format.")
        })
    }
);

// ============================================================================
// DATE-AWARE SEARCH TOOLS
// ============================================================================

export const searchMessagesByDateTool = tool(
    async ({ query, chatIds, startDate, endDate, limit }) => {
        try {
            const results = await searchMessagesByDate({
                query,
                chatIds: chatIds ?? undefined,
                startDate: startDate ?? undefined,
                endDate: endDate ?? undefined,
                limit: limit ?? undefined
            });
            console.log("[tool:search_messages_by_date] query:", query, "range:", startDate, "-", endDate, "-> found", results.length, "results");
            if (results.length === 0) {
                return `No messages found matching "${query}" in the specified time range.`;
            }
            return JSON.stringify(results, null, 2);
        } catch (error) {
            console.error("[tool:search_messages_by_date] Error:", error);
            return `Error searching messages by date: ${String(error)}`;
        }
    },
    {
        name: "search_messages_by_date",
        description: "Full-text search for messages within a specific time range. Unlike semantic search, this finds exact word matches. Use this when you know keywords and approximate time period. Optionally filter by chatIds.",
        schema: z.object({
            query: z.string().describe("Search query with keywords (space-separated terms are ANDed)."),
            chatIds: z.array(z.string()).nullable().optional().describe("Optional array of chatIds to search within."),
            startDate: z.string().nullable().optional().describe("Optional start date filter (ISO format)."),
            endDate: z.string().nullable().optional().describe("Optional end date filter (ISO format)."),
            limit: z.number().int().min(1).max(100).nullable().optional().describe("Maximum results. Default 20.")
        })
    }
);

export const findConversationsAroundDateTool = tool(
    async ({ aroundDate, windowDays, limit }) => {
        try {
            const results = await findConversationsAroundDate({
                aroundDate,
                windowDays: windowDays ?? undefined,
                limit: limit ?? undefined
            });
            console.log("[tool:find_conversations_around_date] date:", aroundDate, "-> found", results.length, "conversations");
            if (results.length === 0) {
                return `No conversations found around ${aroundDate}.`;
            }
            return JSON.stringify(results, null, 2);
        } catch (error) {
            console.error("[tool:find_conversations_around_date] Error:", error);
            return `Error finding conversations: ${String(error)}`;
        }
    },
    {
        name: "find_conversations_around_date",
        description: "Find which chats were most active around a specific date. Returns chats with their message counts and date ranges within the time window. Useful for contextualizing 'what was I talking about around X date?'.",
        schema: z.object({
            aroundDate: z.string().describe("The target date around which to find conversations (ISO format)."),
            windowDays: z.number().int().min(1).max(30).nullable().optional().describe("Number of days before/after the date to search. Default 7."),
            limit: z.number().int().min(1).max(20).nullable().optional().describe("Maximum number of chats to return. Default 10.")
        })
    }
);

export const agentTools = [
    findCandidateChatsTool,
    searchMessagesTool,
    expandContextTool,
    getChatMetadataTool,
    getAllChatsOverviewTool,
    getMessagesInRangeTool,
    getRecentMessagesTool,
    getChatActivitySummaryTool,
    getMessageCountByPeriodTool,
    searchMessagesByDateTool,
    findConversationsAroundDateTool
];

