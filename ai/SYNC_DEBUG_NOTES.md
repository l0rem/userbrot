# Sync Debug Notes

This file tracks safe debugging patterns for Telegram sync so we avoid accidental long runs.

## Rules

- Use small chat IDs for runtime probes (e.g. `256212219`).
- Do not run ad-hoc probes on very large chats (e.g. `752041694`) unless explicitly needed.
- Keep debug page limits low (1-3 pages max) when testing pagination behavior.
- Always close DB/socket handles in one-off scripts (`await client.destroy()`, `await sql.end(...)`, `process.exit(0)`) to avoid stuck terminals.

## Lightweight probe template

```ts
import { db, getOwnerTelegramId, mtprotoSessions, requireMtprotoApiCredentials, sql } from "@userbrot/core";
import { MemoryStorage, TelegramClient } from "@mtcute/node";
import { eq } from "drizzle-orm";

const owner = getOwnerTelegramId();
const session = owner
  ? await db.query.mtprotoSessions.findFirst({ where: eq(mtprotoSessions.ownerTelegramId, owner) })
  : await db.query.mtprotoSessions.findFirst();

if (!session) {
  throw new Error("No MTProto session");
}

const { apiId, apiHash } = requireMtprotoApiCredentials();
const client = new TelegramClient({ apiId, apiHash, storage: new MemoryStorage(), disableUpdates: true });

await client.importSession(session.sessionString, true);

const peer = 256212219; // small chat
const page = await client.getHistory(peer, { limit: 100 });
console.log({ count: page.length, total: page.total, topId: page[0]?.id ?? null });

await client.destroy();
await sql.end({ timeout: 5 });
process.exit(0);
```

## Built-in probe command

Use the userbot probe helper instead of ad-hoc scripts:

```bash
SYNC_PROBE_CHAT_ID=256212219 SYNC_PROBE_PAGES=3 bun run --filter @userbrot/userbot debug:probe-history
```

Notes:

- `SYNC_PROBE_PAGES` defaults to `3` and is capped at `20`.
- Keep it on small chats unless explicitly debugging high-volume behavior.

## Built-in estimate and verification commands

Use these for faster, repeatable diagnostics:

```bash
SYNC_ESTIMATE_CHAT_ID=256212219 bun run --filter @userbrot/userbot debug:estimate-chat
SYNC_VERIFY_CHAT_ID=256212219 bun run --filter @userbrot/userbot debug:verify-sync
```

Notes:

- `debug:estimate-chat` reports estimate mode (`exact` or `lower_bound`) and shows whether the cap was hit.
- `SYNC_ESTIMATE_MAX_PAGES` can tune probe depth (default `12`, max `50`).
- `debug:verify-sync` dumps current target/checkpoint/run state so regressions are visible without opening SQL manually.
