import { countStoredChatMessages, db, mtprotoSessions, requireMtprotoApiCredentials, sql } from "@userbrot/core";
import { getOwnerTelegramId } from "@userbrot/core/env";
import { MemoryStorage, TelegramClient, tl } from "@mtcute/node";
import { eq } from "drizzle-orm";

const rawChatId = process.env.SYNC_ESTIMATE_CHAT_ID;
if (!rawChatId || !/^\d+$/.test(rawChatId)) {
  console.error("Set SYNC_ESTIMATE_CHAT_ID=<numeric chat id>");
  process.exit(1);
}

const parsedMaxPages = Number.parseInt(process.env.SYNC_ESTIMATE_MAX_PAGES ?? "12", 10);
const maxPages = Number.isFinite(parsedMaxPages) ? Math.min(Math.max(parsedMaxPages, 1), 50) : 12;

const ownerTelegramId = getOwnerTelegramId();
const session = ownerTelegramId
  ? await db.query.mtprotoSessions.findFirst({
      where: eq(mtprotoSessions.ownerTelegramId, ownerTelegramId)
    })
  : await db.query.mtprotoSessions.findFirst();

if (!session) {
  console.error("No MTProto session found. Complete setup first.");
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}

const resolvedOwnerTelegramId = ownerTelegramId ?? session.ownerTelegramId;
const { apiId, apiHash } = requireMtprotoApiCredentials();
const client = new TelegramClient({
  apiId,
  apiHash,
  storage: new MemoryStorage(),
  disableUpdates: true
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeGetHistory<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;

  while (attempt < 5) {
    try {
      return await fn();
    } catch (error) {
      if (tl.RpcError.is(error, "FLOOD_WAIT_%d")) {
        const waitMs = Math.ceil(error.seconds * 1000 * 1.1 + Math.random() * 500);
        await sleep(waitMs);
        attempt += 1;
        continue;
      }

      if (error instanceof Error) {
        const match = error.message.match(/wait of\s+(\d+)\s+seconds/i);
        if (match) {
          const waitSeconds = Number.parseInt(match[1], 10);
          if (Number.isFinite(waitSeconds) && waitSeconds > 0) {
            await sleep(Math.ceil(waitSeconds * 1000 * 1.1));
            attempt += 1;
            continue;
          }
        }
      }

      throw error;
    }
  }

  throw new Error("Estimate probe exceeded retry policy");
}

try {
  await client.importSession(session.sessionString, true);

  const chatPeerId = Number.parseInt(rawChatId, 10);
  const firstPage = await safeGetHistory(() => client.getHistory(chatPeerId, { limit: 1 }));
  const storedMessages = await countStoredChatMessages(resolvedOwnerTelegramId, BigInt(chatPeerId));

  if (firstPage.length === 0) {
    console.log({
      chatPeerId,
      mode: "exact",
      reason: "empty_history",
      storedMessages,
      estimatedMessages: 0,
      estimatedEtaSeconds: 0
    });
    process.exit(0);
  }

  const rawTotal = (firstPage as unknown as { total?: unknown }).total;
  const totalMessages = typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : null;
  const TELEGRAM_TOTAL_SENTINEL = 2_147_483_647;
  const hasUsableTotal =
    totalMessages !== null &&
    totalMessages >= 0 &&
    totalMessages < TELEGRAM_TOTAL_SENTINEL &&
    totalMessages <= 1_000_000_000;

  if (hasUsableTotal) {
    const estimatedMessages = Math.max(totalMessages - storedMessages, 0);
    console.log({
      chatPeerId,
      mode: "exact",
      reason: "history_total",
      rawTotal: totalMessages,
      storedMessages,
      estimatedMessages,
      estimatedEtaSeconds: estimatedMessages > 0 ? Math.ceil(estimatedMessages / 35) : 0
    });
    process.exit(0);
  }

  const anchor = (firstPage[0]?.id ?? 0) + 1;
  const limit = 100;
  let offset = 0;
  let fetched = 0;
  let reachedEnd = false;

  for (let index = 0; index < maxPages; index += 1) {
    const page = await safeGetHistory(() =>
      client.getHistory(chatPeerId, {
        limit,
        offsetId: anchor,
        addOffset: offset
      } as any)
    );

    if (page.length === 0) {
      reachedEnd = true;
      break;
    }

    fetched += page.length;
    offset += page.length;

    console.log({
      page: index + 1,
      fetched: page.length,
      nextOffset: offset
    });

    if (page.length < limit) {
      reachedEnd = true;
      break;
    }
  }

  const estimatedMessages = Math.max(fetched - storedMessages, 0);
  const mode = reachedEnd ? "exact" : "lower_bound";

  console.log({
    chatPeerId,
    mode,
    reason: "history_probe",
    rawTotal,
    storedMessages,
    fetchedByProbe: fetched,
    maxProbePages: maxPages,
    reachedEnd,
    estimatedMessages,
    estimatedEtaSeconds: mode === "exact" ? (estimatedMessages > 0 ? Math.ceil(estimatedMessages / 35) : 0) : null
  });
} finally {
  await client.destroy().catch(() => undefined);
  await sql.end({ timeout: 5 }).catch(() => undefined);
}

process.exit(0);
