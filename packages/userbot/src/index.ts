import {
  appendEmbeddingRunLog,
  appendSyncRunLog,
  claimQueuedEmbeddingRun,
  claimQueuedSyncRun,
  db,
  failEmbeddingRun,
  failSyncRun,
  mtprotoSessions,
  sql
} from "@userbrot/core";
import {
  requireMtprotoApiCredentials
} from "@userbrot/core/env";
import { MemoryStorage, TelegramClient } from "@mtcute/node";
import { desc } from "drizzle-orm";

import { sleep, normalizeErrorMessage } from "./utils";
import { SyncWorker } from "./syncWorker";
import { processEmbeddingRun, EmbeddingRunStoppedError } from "./embeddingWorker";

const IDLE_SLEEP_MS = 4000;

const session = await db.query.mtprotoSessions.findFirst({
  orderBy: [desc(mtprotoSessions.updatedAt)]
});

if (!session) {
  console.log("No persisted MTProto session found yet. Complete setup flow first.");
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(0);
}

const resolvedOwnerTelegramId = session.ownerTelegramId;
const { apiId, apiHash } = requireMtprotoApiCredentials();

const client = new TelegramClient({
  apiId,
  apiHash,
  storage: new MemoryStorage()
});

const syncWorker = new SyncWorker(client);

let exitCode = 0;

try {
  await client.importSession(session.sessionString, true);
  const me = await client.getMe();
  const accountLabel = me.username ? `@${me.username}` : `${me.id}`;
  console.log(`Userbot worker authorized as ${accountLabel}. Polling sync queue...`);

  while (true) {
    const run = await claimQueuedSyncRun(resolvedOwnerTelegramId);

    if (run) {
      try {
        await syncWorker.processRun(run);
        await appendSyncRunLog(run.id, run.ownerTelegramId, "Run completed", "info");
      } catch (error) {
        const message = normalizeErrorMessage(error);
        await appendSyncRunLog(run.id, run.ownerTelegramId, `Run failed: ${message}`, "error");
        await failSyncRun(run.id, run.ownerTelegramId, message);
      }
      continue;
    }

    const embeddingRun = await claimQueuedEmbeddingRun(resolvedOwnerTelegramId);

    if (embeddingRun) {
      try {
        await processEmbeddingRun(embeddingRun);
        await appendEmbeddingRunLog(embeddingRun.id, embeddingRun.ownerTelegramId, "Embedding run completed", "info");
      } catch (error) {
        if (error instanceof EmbeddingRunStoppedError) {
          await appendEmbeddingRunLog(embeddingRun.id, embeddingRun.ownerTelegramId, "Embedding run cancelled", "warn");
          continue;
        }
        const message = normalizeErrorMessage(error);
        console.error("[embeddings] run failed", {
          runId: embeddingRun.id,
          ownerTelegramId: embeddingRun.ownerTelegramId.toString(),
          error: message
        });
        await appendEmbeddingRunLog(embeddingRun.id, embeddingRun.ownerTelegramId, `Run failed: ${message}`, "error");
        await failEmbeddingRun(embeddingRun.id, embeddingRun.ownerTelegramId, message);
      }
      continue;
    }

    await sleep(IDLE_SLEEP_MS);
  }
} catch (error) {
  const message = normalizeErrorMessage(error);
  console.error(`Userbot worker failed to start: ${message}`);
  exitCode = 1;
} finally {
  await client.destroy().catch(() => undefined);
  await sql.end({ timeout: 5 }).catch(() => undefined);
}

process.exit(exitCode);
