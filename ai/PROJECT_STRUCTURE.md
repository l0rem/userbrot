# Project Structure

## Monorepo shape

All runnable services and shared code live under `packages/`.

```text
packages/
  bot/          Telegram bot (GramIO)
  userbot/      MTProto runtime (MTCute)
  web/          SvelteKit setup UI + setup API
  core/         Shared env, DB schema/client, setup services
```

## Core ownership

- `packages/core/src/env.ts` - validated environment loading
- `packages/core/src/db/schema.ts` - Drizzle schema
- `packages/core/src/db/client.ts` - DB client bootstrap
- `packages/core/src/services/setupService.ts` - setup state machine

## Web ownership

- `packages/web/src/routes/setup/+page.svelte` - onboarding UI
- `packages/web/src/routes/setup/+page.server.ts` - initial setup status + prefill
- `packages/web/src/routes/api/setup/*` - setup API endpoints
- `packages/web/src/lib/server/mtprotoGateway.ts` - Telegram auth gateway

## Bot and userbot ownership

- `packages/bot/src/index.ts` - `/start`, web-app URL behavior, onboarding entrypoint
- `packages/userbot/src/index.ts` - reuse stored session and validate account access

## Migrations

- `packages/core/drizzle/` holds SQL migrations and Drizzle metadata snapshots
- `packages/core/drizzle.config.ts` is the migration config used from repo root scripts
