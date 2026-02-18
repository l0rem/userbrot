import { db, mtprotoSessions, sql } from "@userbrot/core";
import { getOwnerTelegramId, requireMtprotoApiCredentials } from "@userbrot/core/env";
import { MemoryStorage, TelegramClient } from "@mtcute/node";
import { eq } from "drizzle-orm";

const ownerTelegramId = getOwnerTelegramId();

const session = ownerTelegramId
  ? await db.query.mtprotoSessions.findFirst({
      where: eq(mtprotoSessions.ownerTelegramId, ownerTelegramId)
    })
  : await db.query.mtprotoSessions.findFirst();

if (!session) {
  console.log("No persisted MTProto session found yet. Complete setup flow first.");
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(0);
}

const { apiId, apiHash } = requireMtprotoApiCredentials();

const client = new TelegramClient({
  apiId,
  apiHash,
  storage: new MemoryStorage()
});

let exitCode = 0;

try {
  await client.importSession(session.sessionString, true);
  const me = await client.getMe();
  const accountLabel = me.username ? `@${me.username}` : `${me.id}`;
  console.log(`Reused MTProto session from DB. Authorized as ${accountLabel}.`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Stored session could not be reused: ${message}`);
  console.error("Reset setup from the web page and run login flow again.");
  exitCode = 1;
} finally {
  await client.destroy().catch(() => undefined);
  await sql.end({ timeout: 5 }).catch(() => undefined);
}

process.exit(exitCode);
