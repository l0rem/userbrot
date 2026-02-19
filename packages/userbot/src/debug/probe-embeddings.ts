import {
  countPendingEmbeddingsForChat,
  db,
  listPendingMessagesForEmbedding,
  mtprotoSessions,
  sql,
  upsertMessageEmbeddings
} from "@userbrot/core";
import { requireEmbeddingProviderConfig } from "@userbrot/core/env";
import { desc, eq } from "drizzle-orm";

const rawChatId = process.env.EMBEDDINGS_PROBE_CHAT_ID;
if (!rawChatId || !/^\d+$/.test(rawChatId)) {
  console.error("Set EMBEDDINGS_PROBE_CHAT_ID=<numeric chat id>");
  process.exit(1);
}

const parsedLimit = Number.parseInt(process.env.EMBEDDINGS_PROBE_LIMIT ?? "8", 10);
const batchLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 64) : 8;
const shouldWrite = process.env.EMBEDDINGS_PROBE_WRITE === "1";

const inferredSession = await db.query.mtprotoSessions.findFirst({
  orderBy: [desc(mtprotoSessions.createdAt)]
});
const ownerTelegramId = inferredSession?.ownerTelegramId;

if (!ownerTelegramId) {
  console.error("Could not resolve owner Telegram ID. Complete setup first.");
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}

const provider = requireEmbeddingProviderConfig();

function buildEmbeddingsEndpoint(baseUrl: string): URL {
  const base = new URL(baseUrl);
  if (/\/embeddings\/?$/i.test(base.pathname)) {
    return base;
  }

  return new URL("embeddings", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  const endpoint = buildEmbeddingsEndpoint(provider.baseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify({
      model: provider.model,
      input: texts
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Embedding provider status ${response.status}: ${raw.slice(0, 220)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const contentType = response.headers.get("content-type") ?? "unknown";
    throw new Error(
      `Embedding provider returned non-JSON response (content-type ${contentType}): ${raw.slice(0, 220)}`
    );
  }

  const payload = parsed as {
    data?: Array<{ embedding?: unknown }>;
  };

  if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
    throw new Error("Embedding provider returned invalid batch shape");
  }

  return payload.data.map((item) => {
    if (!Array.isArray(item.embedding)) {
      throw new Error("Embedding provider returned non-array vector");
    }

    const vector = item.embedding
      .map((value) => (typeof value === "number" && Number.isFinite(value) ? value : null))
      .filter((value): value is number => value !== null);

    if (vector.length === 0) {
      throw new Error("Embedding provider returned empty vector");
    }

    return vector;
  });
}

const chatPeerId = BigInt(rawChatId);

try {
  const pendingBefore = await countPendingEmbeddingsForChat(ownerTelegramId, chatPeerId, provider.model);
  const rows = await listPendingMessagesForEmbedding(ownerTelegramId, chatPeerId, provider.model, 0, batchLimit);

  if (rows.length === 0) {
    console.log({
      ownerTelegramId: ownerTelegramId.toString(),
      chatPeerId: chatPeerId.toString(),
      model: provider.model,
      pendingBefore,
      message: "No pending messages for embeddings"
    });
    process.exit(0);
  }

  const vectors = await fetchEmbeddings(rows.map((row) => row.text));
  const dimensions = vectors[0]?.length ?? 0;

  if (shouldWrite) {
    await upsertMessageEmbeddings(
      ownerTelegramId,
      rows.map((row, index) => ({
        chatPeerId,
        messageId: row.messageId,
        model: provider.model,
        embedding: vectors[index],
        sourceUpdatedAt: row.updatedAt,
        sourceText: row.text
      }))
    );
  }

  const pendingAfter = shouldWrite
    ? await countPendingEmbeddingsForChat(ownerTelegramId, chatPeerId, provider.model)
    : pendingBefore;

  console.log({
    ownerTelegramId: ownerTelegramId.toString(),
    chatPeerId: chatPeerId.toString(),
    model: provider.model,
    endpoint: buildEmbeddingsEndpoint(provider.baseUrl).toString(),
    probeBatchSize: rows.length,
    firstMessageId: rows[0]?.messageId ?? null,
    lastMessageId: rows[rows.length - 1]?.messageId ?? null,
    vectorDimensions: dimensions,
    wroteToDatabase: shouldWrite,
    pendingBefore,
    pendingAfter
  });
} finally {
  await sql.end({ timeout: 5 }).catch(() => undefined);
}

process.exit(0);
