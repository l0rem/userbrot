# Runbook

## Install

```bash
bun install
```

## Database

```bash
bun run db:generate
bun run db:migrate
```

## Development

```bash
bun run dev:web
bun run dev:bot
bun run dev:userbot
```

## Validation

```bash
bun run check
bun run build
```

## Setup flow checks

1. Open `http://localhost:3000/setup`
2. Submit phone
3. Submit code
4. Submit 2FA password only if prompted
5. Confirm status is `configured`
6. Run `bun run dev:userbot` and verify session reuse output

## Local behavior notes

- Telegram Mini App buttons require HTTPS URLs.
- With `WEB_APP_URL=http://localhost:3000`, the bot sends a manual setup link instead of a Mini App button.
- `SETUP_PHONE` (optional) pre-fills phone input on setup page load.
- Sync debugging helpers and safety rules: `ai/SYNC_DEBUG_NOTES.md` and `ai/SYNC_RESEARCH.md`.
- Sync estimate display semantics on `/sync`:
  - exact estimate: `N msgs` with ETA
  - lower-bound estimate: `N+ msgs` with no ETA
  - synced chats: no ETA shown

## Handoff (2026-02-19)

Use this section to resume quickly tomorrow.

### Current sync state

- Checkpoint model now uses dedicated `next_offset` for pagination resume.
- Legacy `next_max_id` is kept for compatibility/boundary data, not primary offset cursor.
- DB migration for that change is `packages/core/drizzle/0003_known_roughhouse.sql`.
- Estimate API now reports mode internally (`exact` or `lower_bound`); UI renders lower bound as `N+ msgs`.
- Synced rows now hide ETA.
- Catalog excludes bot accounts and deleted accounts.
- Re-sync includes new-message catch-up for chats that were already fully backfilled.
- Worker recovers from peer-cache misses (`not found in local cache`) by warming dialog cache.
- Embeddings pipeline is now active: `/embeddings` UI + queue/runs/logs/checkpoints + per-chat reset.
- `dev:userbot` now processes both sync runs and embedding runs in one worker process.
- Embedding API endpoint resolution now preserves provider path prefixes (e.g. `/v1`) and logs non-JSON provider responses with body preview.
- Embeddings run handling is restart-safe: worker picks up existing `running` run on startup.
- Embeddings runs can be stopped from UI (`Stop run`) and restarted later from checkpoints.
- Embeddings UI now shows throughput + activity timestamp (ETA removed for embeddings).
- Runtime owner is now resolved from persisted MTProto session instead of `OWNER_TELEGRAM_ID` env.
- Added backup helpers for chats/messages/media export and per-chat import recovery.
- All currently synced private chats are embedded.

### Verified on real data

- Small chat `256212219` probe confirms full history size `214` and sparse/non-count-like message IDs.
- Estimate debug on `256212219` returns exact mode via bounded probe and remaining `0` when already synced.
- Sync verification script confirms stored count/checkpoint coherence for `256212219`.

### Useful debug commands

```bash
# pagination probe (lightweight)
SYNC_PROBE_CHAT_ID=256212219 SYNC_PROBE_PAGES=3 bun run --filter @userbrot/userbot debug:probe-history

# estimate behavior + mode diagnostics
SYNC_ESTIMATE_CHAT_ID=256212219 bun run --filter @userbrot/userbot debug:estimate-chat

# DB/run/checkpoint coherence for one chat
SYNC_VERIFY_CHAT_ID=256212219 bun run --filter @userbrot/userbot debug:verify-sync

# embeddings provider probe on one chat (set EMBEDDINGS_PROBE_WRITE=1 to store sampled vectors)
EMBEDDINGS_PROBE_CHAT_ID=479829705 bun run --filter @userbrot/userbot debug:probe-embeddings

# embeddings DB/run/checkpoint coherence for one chat
EMBEDDINGS_VERIFY_CHAT_ID=479829705 bun run --filter @userbrot/userbot debug:verify-embeddings

# export full sync data backup (chats + messages + media)
bun run --filter @userbrot/userbot backup:export-sync

# import one chat from a backup snapshot directory
SYNC_BACKUP_DIR=data/backups/<snapshot-dir> IMPORT_CHAT_PEER_ID=479829705 bun run --filter @userbrot/userbot backup:import-chat
```

### First steps tomorrow

1. Run `bun run db:migrate` (if not already applied in target DB).
2. Restart web + userbot dev processes.
3. Smoke-test small chat (`256212219`): estimate -> start sync -> verify UI and `debug:verify-sync` output.
4. Controlled large chat test (`752041694`) to validate flood-wait recovery and monotonic checkpoint progress.

### Embeddings implementation status

1. Added embeddings schema + migration (`pgvector` extension, per-message vectors, embedding run/checkpoint tables).
2. Added embeddings worker loop (claim queued/running run, batch generate, retry/backoff, resumable checkpoints).
3. Added `/embeddings` UI page with per-chat status, progress, stop/reset actions, and run activity feedback.
4. Remaining next: wire hybrid retrieval (vector + FTS) into `ragService` behind feature gating.

## RAG + Sync implementation tracker

This section is the working checklist for the Telegram chat sync + RAG feature.
If work pauses mid-way, resume from the first unchecked item.

### Scope for current implementation pass

- [x] Restrict sync selection to private 1:1 chats for v1.
- [x] Show synced chats with a green status on `/sync` when revisiting the page.
- [x] Make sync resumable via DB checkpoints and idempotent message upserts.
- [x] Show ETA estimates for selected chats and running sync jobs.
- [x] Add minimal natural-language Q&A flow in bot threads/topics.
- [x] Add configurable model provider base URL + model names via env.

### Phase 1: schema and core services

- [x] Add sync tables: discovered chats, targets, runs, run logs, checkpoints.
- [x] Add message storage tables: raw messages + media references.
- [x] Generate and commit additive Drizzle migration for new tables.
- [x] Add `syncService` APIs for queueing runs, claiming runs, logs, checkpoints, and status.
- [x] Add `ragService` API for minimal grounded Q&A over synced messages.

### Phase 2: web sync flow

- [x] Add `/sync` page with folders + chats list and unchecked-by-default checkboxes.
- [x] Add sync endpoints: catalog, estimate, start, status.
- [x] Show per-chat status badges (`unsynced`, `syncing`, `synced`, `error`) and counts.
- [x] Show active run progress bar + short rolling logs + ETA.

### Phase 3: userbot worker

- [x] Replace one-shot userbot validation with run worker loop.
- [x] Claim queued runs, process selected chats newest->oldest, write checkpoints per batch.
- [x] Handle `FLOOD_WAIT_%d` and transient errors with safe backoff.
- [x] Resume from checkpoint on restart/failure.

### Phase 4: minimal bot Q&A

- [x] Add owner-only message handling for natural-language questions.
- [x] Preserve topic/thread context in replies (`message_thread_id` / direct-messages topic).
- [x] Retrieve relevant synced messages and answer with grounded context.

### Future track (after current pass)

- [ ] Add dedicated job management page (history, retry, cancel, inspect logs) for sync + embeddings.
- [ ] Upgrade queue runtime to robust background jobs engine (recommended: Postgres-native `pg-boss`).
- [ ] Wire hybrid retrieval (`pgvector` + FTS) in `ragService` and optional reranker.
- [ ] Add ingestion pipeline for media content (voice transcription, OCR, documents).
- [ ] Add continuous sync via updates diff reconciliation for edits/deletes parity.
