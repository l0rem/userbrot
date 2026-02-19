import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  aiConversations,
  aiMessages,
  type AiConversationSurface,
  type AiConversationStatus,
  type AiMessageRole
} from "../db/schema";

export type Conversation = typeof aiConversations.$inferSelect;
export type NewConversation = typeof aiConversations.$inferInsert;
export type Message = typeof aiMessages.$inferSelect;
export type NewMessage = typeof aiMessages.$inferInsert;

export type ConversationKey = {
  surface: AiConversationSurface;
  externalChatId: string;
  externalThreadId: string | null;
};

export async function findOrCreateConversation(
  key: ConversationKey,
  title?: string
): Promise<Conversation> {
  const existing = await db
    .select()
    .from(aiConversations)
    .where(
      and(
        eq(aiConversations.surface, key.surface),
        eq(aiConversations.externalChatId, key.externalChatId),
        key.externalThreadId === null
          ? sql`${aiConversations.externalThreadId} IS NULL`
          : eq(aiConversations.externalThreadId, key.externalThreadId)
      )
    )
    .limit(1);

  if (existing[0]) {
    return existing[0];
  }

  const [created] = await db
    .insert(aiConversations)
    .values({
      surface: key.surface,
      externalChatId: key.externalChatId,
      externalThreadId: key.externalThreadId,
      title: title ?? null,
      status: "active"
    })
    .returning();

  return created;
}

export async function getConversationById(id: number): Promise<Conversation | undefined> {
  const [conversation] = await db
    .select()
    .from(aiConversations)
    .where(eq(aiConversations.id, id));
  return conversation;
}

export async function updateConversationStatus(
  id: number,
  status: AiConversationStatus
): Promise<void> {
  await db
    .update(aiConversations)
    .set({ status, updatedAt: new Date() })
    .where(eq(aiConversations.id, id));
}

export async function touchConversation(id: number): Promise<void> {
  await db
    .update(aiConversations)
    .set({
      lastMessageAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(aiConversations.id, id));
}

export async function addMessage(
  conversationId: number,
  role: AiMessageRole,
  content: string,
  options?: {
    modelName?: string;
    inputTokens?: number;
    outputTokens?: number;
    toolName?: string;
    toolCallId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<Message> {
  const [message] = await db
    .insert(aiMessages)
    .values({
      conversationId,
      role,
      content,
      modelName: options?.modelName,
      inputTokens: options?.inputTokens,
      outputTokens: options?.outputTokens,
      toolName: options?.toolName,
      toolCallId: options?.toolCallId,
      metadata: options?.metadata
    })
    .returning();

  await touchConversation(conversationId);

  return message;
}

export async function getConversationMessages(
  conversationId: number,
  limit: number = 50
): Promise<Message[]> {
  return db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(desc(aiMessages.createdAt))
    .limit(limit);
}

export async function getRecentMessagesForContext(
  conversationId: number,
  maxTokens: number = 4000
): Promise<Message[]> {
  const messages = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(desc(aiMessages.createdAt))
    .limit(100);

  let totalTokens = 0;
  const result: Message[] = [];

  for (const msg of messages.reverse()) {
    const estimatedTokens = Math.ceil(msg.content.length / 4);
    if (totalTokens + estimatedTokens > maxTokens && result.length > 0) {
      break;
    }
    totalTokens += estimatedTokens;
    result.push(msg);
  }

  return result;
}

export async function deleteConversationMessages(conversationId: number): Promise<void> {
  await db.delete(aiMessages).where(eq(aiMessages.conversationId, conversationId));
}

export const conversationRepo = {
  findOrCreate: findOrCreateConversation,
  getById: getConversationById,
  updateStatus: updateConversationStatus,
  touch: touchConversation
};

export const messageRepo = {
  add: addMessage,
  getForConversation: getConversationMessages,
  getForContext: getRecentMessagesForContext,
  deleteForConversation: deleteConversationMessages
};
