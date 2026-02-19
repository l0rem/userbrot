# Userbrot

Userbrot is a private, single-owner Telegram automation stack.

It combines:

- a Telegram **bot** (for control and entrypoint)
- a Telegram **userbot** (MTProto account access)
- a **web setup wizard** (phone/code/password auth flow)
- a shared **PostgreSQL + Drizzle** core layer

---

## Monorepo layout

```text
packages/
  bot/        GramIO bot runtime
  userbot/    MTCute runtime and session reuse
  web/        SvelteKit setup UI + setup API
  core/       env loading, DB schema/client, setup services, migrations

ai/           Agent context docs (structure, guidelines, runbook)
```

---

## Prerequisites

- Bun 1.3+
- PostgreSQL 16+
- Telegram bot token
- Telegram API credentials (`api_id` + `api_hash`)

---

## Environment variables

Copy `.env.example` to `.env` and fill values.

| Variable | Required | Description | Where to get it |
|---|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string | Your local/hosted Postgres instance |
| `BOT_TOKEN` | Yes | Telegram bot token | [@BotFather](https://t.me/BotFather) |
| `TG_API_ID` | Yes | Telegram app API ID | [my.telegram.org/apps](https://my.telegram.org/apps) |
| `TG_API_HASH` | Yes | Telegram app API hash | [my.telegram.org/apps](https://my.telegram.org/apps) |
| `WEB_APP_URL` | Yes | Web app base URL | `http://localhost:3000` for local dev |
| `SETUP_PHONE` | Optional | Prefills setup page phone input | Your phone in international format |
| `LLM_BASE_URL` | Optional | OpenAI-compatible base URL for answers | Provider endpoint |
| `LLM_API_KEY` | Optional | API key for `LLM_BASE_URL` | Provider dashboard |
| `LLM_MODEL` | Optional | Chat model slug for RAG answers | Provider model list |
| `EMBEDDING_BASE_URL` | Optional | OpenAI-compatible base URL for embeddings | Provider endpoint |
| `EMBEDDING_API_KEY` | Optional | API key for embedding provider | Provider dashboard |
| `EMBEDDING_MODEL` | Optional | Embedding model slug | Provider model list |

Notes:

- Telegram Mini App buttons require HTTPS. With localhost HTTP, bot falls back to text link.
- Never commit `.env` or session strings.
- `LLM_API_KEY` is required for bot Q&A.

---

## Install and bootstrap

```bash
bun install
bun run db:generate
bun run db:migrate
```

---

## Run locally

Terminal 1:

```bash
bun run dev:web
```

Terminal 2:

```bash
bun run dev:bot
```

Terminal 3 (after auth is complete):

```bash
bun run dev:userbot
```

---

## Setup and auth flow

1. Open `http://localhost:3000/setup`
2. Enter phone and click **Send code**
3. Enter Telegram login code
4. If required, enter 2FA password
5. Setup status becomes `configured`
6. Open `http://localhost:3000/sync`, choose private chats, and start synchronization
7. Open `http://localhost:3000/embeddings`, select synced chats, and queue embedding runs
8. Run `bun run dev:userbot` to process queued/running sync + embedding jobs

Embeddings run controls:

- The worker resumes interrupted embedding runs from saved checkpoints when restarted.
- The `/embeddings` page exposes **Stop run**; stopping a run preserves checkpoints, so starting again continues remaining messages.
- Run status shows processed messages + throughput + recent activity timestamp (ETA removed for embeddings).

If you need to start over, click **Reset setup** on `/setup`.

---

## Common commands

```bash
bun run dev
bun run dev:web
bun run dev:bot
bun run dev:userbot
bun run check
bun run build
bun run db:generate
bun run db:migrate
bun run db:studio

# backup/export/import (messages + media)
bun run --filter @userbrot/userbot backup:export-sync
SYNC_BACKUP_DIR=data/backups/<snapshot-dir> IMPORT_CHAT_PEER_ID=479829705 bun run --filter @userbrot/userbot backup:import-chat
```

---

## Current status

Implemented:

- real Telegram auth (code + optional password)
- setup state machine and persistent MTProto session storage
- SvelteKit setup UI and API routes
- private chat sync UI (`/sync`) with resumable run tracking, logs, bulk select, and bot/deleted-account filtering
- userbot worker loop with checkpoint-based history backfill + new-message catch-up + peer cache recovery
- embeddings operations UI (`/embeddings`) with per-chat estimates, run logs, reset selected chats, and full debug clear
- embeddings worker loop in `dev:userbot` (single process handling both sync and embeddings queues) with retry/backoff, resumable checkpoints, and restart-safe run pickup
- embeddings run controls: stop active run from UI and resume remaining messages on next start
- minimal bot Q&A over synced messages (`/ask` or plain text) with thread/topic reply context preserved

Progress snapshot (2026-02-19):

- all currently synced private chats are fully embedded

Planned next:

- iterate on RAG and chat quality (hybrid retrieval, ranking, and answer generation improvements)
- media enrichment pipeline (voice/document understanding)
