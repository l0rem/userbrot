import OpenAI from "openai";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { requireLlmProviderConfig } from "../env";
import { telegramChats, telegramMessages } from "../db/schema";

export type RagCitation = {
  chatPeerId: bigint;
  chatTitle: string;
  messageId: number;
  date: Date;
  text: string;
};

export type RagAnswer = {
  answer: string;
  citations: RagCitation[];
  model: string;
};

type CandidateRow = {
  chatPeerId: bigint;
  messageId: number;
  date: Date;
  text: string;
  chatTitle: string;
};

async function searchRelevantMessages(ownerTelegramId: bigint, question: string): Promise<CandidateRow[]> {
  const rows = await db
    .select({
      chatPeerId: telegramMessages.chatPeerId,
      messageId: telegramMessages.messageId,
      date: telegramMessages.date,
      text: telegramMessages.text,
      chatTitle: telegramChats.title
    })
    .from(telegramMessages)
    .innerJoin(
      telegramChats,
      and(
        eq(telegramChats.ownerTelegramId, telegramMessages.ownerTelegramId),
        eq(telegramChats.peerId, telegramMessages.chatPeerId)
      )
    )
    .where(
      and(
        eq(telegramMessages.ownerTelegramId, ownerTelegramId),
        sql`${telegramMessages.text} is not null and length(trim(${telegramMessages.text})) > 0`,
        sql`to_tsvector('simple', coalesce(${telegramMessages.text}, '')) @@ websearch_to_tsquery('simple', ${question})`
      )
    )
    .orderBy(desc(telegramMessages.date))
    .limit(32);

  if (rows.length > 0) {
    return rows
      .filter((row) => Boolean(row.text))
      .map((row) => ({
        chatPeerId: row.chatPeerId,
        messageId: row.messageId,
        date: row.date,
        text: row.text ?? "",
        chatTitle: row.chatTitle
      }));
  }

  const fallbackRows = await db
    .select({
      chatPeerId: telegramMessages.chatPeerId,
      messageId: telegramMessages.messageId,
      date: telegramMessages.date,
      text: telegramMessages.text,
      chatTitle: telegramChats.title
    })
    .from(telegramMessages)
    .innerJoin(
      telegramChats,
      and(
        eq(telegramChats.ownerTelegramId, telegramMessages.ownerTelegramId),
        eq(telegramChats.peerId, telegramMessages.chatPeerId)
      )
    )
    .where(
      and(
        eq(telegramMessages.ownerTelegramId, ownerTelegramId),
        sql`${telegramMessages.text} is not null and length(trim(${telegramMessages.text})) > 0`
      )
    )
    .orderBy(desc(telegramMessages.date))
    .limit(24);

  return fallbackRows
    .filter((row) => Boolean(row.text))
    .map((row) => ({
      chatPeerId: row.chatPeerId,
      messageId: row.messageId,
      date: row.date,
      text: row.text ?? "",
      chatTitle: row.chatTitle
    }));
}

function renderEvidence(candidates: CandidateRow[]): string {
  return candidates
    .slice(0, 24)
    .map((row, index) => {
      const ref = `[ref:${index + 1} chat=${row.chatPeerId.toString()} msg=${row.messageId}]`;
      const when = row.date.toISOString();
      return `${ref} ${when} | ${row.chatTitle}\n${row.text}`;
    })
    .join("\n\n");
}

export async function answerQuestionFromSyncedChats(
  ownerTelegramId: bigint,
  question: string
): Promise<RagAnswer> {
  const trimmed = question.trim();
  if (trimmed.length < 2) {
    throw new Error("Question is too short");
  }

  const candidates = await searchRelevantMessages(ownerTelegramId, trimmed);
  if (candidates.length === 0) {
    return {
      answer: "I do not have any synced chat messages yet. Run chat sync first.",
      citations: [],
      model: "none"
    };
  }

  const llm = requireLlmProviderConfig();
  const client = new OpenAI({
    apiKey: llm.apiKey,
    baseURL: llm.baseUrl
  });

  const evidence = renderEvidence(candidates);

  const completion = await client.chat.completions.create({
    model: llm.model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You answer questions strictly using provided Telegram chat evidence. If evidence is insufficient, say so clearly. Keep answers concise and factual."
      },
      {
        role: "user",
        content:
          `Question:\n${trimmed}\n\nEvidence:\n${evidence}\n\nReturn a direct answer. Mention uncertainty explicitly when needed.`
      }
    ]
  });

  const answer = completion.choices[0]?.message?.content?.trim();
  const citations: RagCitation[] = candidates.slice(0, 5).map((row) => ({
    chatPeerId: row.chatPeerId,
    chatTitle: row.chatTitle,
    messageId: row.messageId,
    date: row.date,
    text: row.text
  }));

  return {
    answer: answer && answer.length > 0 ? answer : "I could not generate an answer.",
    citations,
    model: llm.model
  };
}
