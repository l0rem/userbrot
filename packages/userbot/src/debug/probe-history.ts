import { db, mtprotoSessions, requireMtprotoApiCredentials, sql } from "@userbrot/core";
import { MemoryStorage, TelegramClient } from "@mtcute/node";
import { desc } from "drizzle-orm";

const rawChatId = process.env.SYNC_PROBE_CHAT_ID;
if (!rawChatId || !/^\d+$/.test(rawChatId)) {
  console.error("Set SYNC_PROBE_CHAT_ID=<numeric chat id>");
  process.exit(1);
}

const parsedPages = Number.parseInt(process.env.SYNC_PROBE_PAGES ?? "3", 10);
const maxPages = Number.isFinite(parsedPages) ? Math.min(Math.max(parsedPages, 1), 20) : 3;

const session = await db.query.mtprotoSessions.findFirst({
  orderBy: [desc(mtprotoSessions.updatedAt)]
});

if (!session) {
  console.error("No MTProto session found. Complete setup first.");
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}

const { apiId, apiHash } = requireMtprotoApiCredentials();
const client = new TelegramClient({
  apiId,
  apiHash,
  storage: new MemoryStorage(),
  disableUpdates: true
});

try {
  await client.importSession(session.sessionString, true);

  const peer = Number.parseInt(rawChatId, 10);
  const first = await client.getHistory(peer, { limit: 1 });
  const anchor = (first[0]?.id ?? 0) + 1;

  let offset = 0;
  let totalFetched = 0;
  const limit = 100;

  for (let index = 0; index < maxPages; index += 1) {
    const page = await client.getHistory(peer, {
      limit,
      addOffset: offset,
      offsetId: anchor
    } as any);

    const ids = page.map((message) => message.id);
    console.log({
      page: index + 1,
      fetched: page.length,
      minId: ids.length > 0 ? Math.min(...ids) : null,
      maxId: ids.length > 0 ? Math.max(...ids) : null,
      nextOffset: offset + page.length
    });

    if (page.length === 0) {
      break;
    }

    totalFetched += page.length;
    offset += page.length;

    if (page.length < limit) {
      break;
    }
  }

  console.log({
    chatPeerId: rawChatId,
    anchor,
    totalFetched,
    pagesExecuted: maxPages
  });
} finally {
  await client.destroy().catch(() => undefined);
  await sql.end({ timeout: 5 }).catch(() => undefined);
}

process.exit(0);
