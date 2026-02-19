import OpenAI from "openai";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { requireEmbeddingProviderConfig, requireLlmProviderConfig } from "../env";
import { telegramChats, telegramMessageEmbeddings, telegramMessages } from "../db/schema";

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
  distance: number;
};

const MAX_RETRIEVAL_DISTANCE = 0.8;
const STRONG_RETRIEVAL_DISTANCE = 0.5;

function vectorLiteral(values: number[]): string {
  return `[${values.map((v) => Number(v).toString()).join(",")}]`;
}

function chooseRelevantCandidates(rows: CandidateRow[]): CandidateRow[] {
  const strong = rows.filter((row) => row.distance <= STRONG_RETRIEVAL_DISTANCE);
  if (strong.length >= 2) {
    return strong.slice(0, 20);
  }

  const weak = rows.filter((row) => row.distance <= MAX_RETRIEVAL_DISTANCE);
  if (weak.length >= 1) {
    return weak.slice(0, 20);
  }

  return [];
}

async function searchRelevantMessages(question: string): Promise<CandidateRow[]> {
  const embeddingProvider = requireEmbeddingProviderConfig();
  const embeddingClient = new OpenAI({
    apiKey: embeddingProvider.apiKey,
    baseURL: embeddingProvider.baseUrl
  });

  const embeddingResult = await embeddingClient.embeddings.create({
    model: embeddingProvider.model,
    input: question
  });

  const queryEmbedding = embeddingResult.data[0]?.embedding;
  if (!queryEmbedding || queryEmbedding.length === 0) {
    return [];
  }

  const queryVector = vectorLiteral(queryEmbedding);
  const distanceExpr = sql<number>`${telegramMessageEmbeddings.embedding} <=> ${queryVector}::vector`;

  const rows = await db
    .select({
      chatPeerId: telegramMessages.chatPeerId,
      messageId: telegramMessages.messageId,
      date: telegramMessages.date,
      text: telegramMessages.text,
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
    .where(
      sql`${telegramMessageEmbeddings.model} = ${embeddingProvider.model} and ${telegramMessages.text} is not null and length(trim(${telegramMessages.text})) > 0 and ${telegramMessages.isService} = false and ${telegramMessages.isDeleted} = false`
    )
    .orderBy(distanceExpr, desc(telegramMessages.date))
    .limit(48);

  return chooseRelevantCandidates(
    rows
      .filter((row) => Boolean(row.text) && Number.isFinite(row.distance))
      .map((row) => ({
        chatPeerId: row.chatPeerId,
        messageId: row.messageId,
        date: row.date,
        text: row.text ?? "",
        chatTitle: row.chatTitle,
        distance: row.distance
      }))
  );
}

function renderEvidence(candidates: CandidateRow[]): string {
  return candidates
    .slice(0, 24)
    .map((row, index) => {
      const ref = `[ref:${index + 1} chat=${row.chatPeerId.toString()} msg=${row.messageId}]`;
      const when = row.date.toISOString();
      const score = (1 - row.distance).toFixed(3);
      return `${ref} ${when} | ${row.chatTitle} | score=${score}\n${row.text}`;
    })
    .join("\n\n");
}

export async function answerQuestionFromSyncedChats(question: string): Promise<RagAnswer> {
  const trimmed = question.trim();
  if (trimmed.length < 2) {
    throw new Error("Question is too short");
  }

  const candidates = await searchRelevantMessages(trimmed);
  if (candidates.length === 0) {
    return {
      answer:
        "I could not find relevant embedded chat evidence for that question. Please sync and embed more messages, then try again.",
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
