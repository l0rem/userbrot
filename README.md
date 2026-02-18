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
| `OWNER_TELEGRAM_ID` | Optional | Lock setup to one Telegram user ID | Your Telegram numeric ID |
| `SETUP_PHONE` | Optional | Prefills setup page phone input | Your phone in international format |
| `OPENROUTER_API_KEY` | Optional | Reserved for future RAG feature | [openrouter.ai](https://openrouter.ai/) |

Notes:

- Telegram Mini App buttons require HTTPS. With localhost HTTP, bot falls back to text link.
- Never commit `.env` or session strings.

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
6. Run `bun run dev:userbot` to verify session reuse from DB

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
```

---

## Current status

Implemented:

- real Telegram auth (code + optional password)
- setup state machine and persistent MTProto session storage
- SvelteKit setup UI and API routes

Planned next:

- long-running message ingestion in userbot
- vector storage and retrieval
- OpenRouter-powered grounded answers over chat history
