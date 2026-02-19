# Project Structure

## Monorepo shape

All runnable services and shared code live under `packages/`.

```text
packages/
  ai/            LangGraph orchestration (shared AI brain)
  bot/           Telegram bot (GramIO)
  userbot/       MTProto runtime (MTCute)
  web/           SvelteKit setup UI + setup API
  core/          Shared env, DB schema/client, setup services
```

## AI ownership (NEW)

The `@userbrot/ai` package is the shared AI orchestration layer used by all interfaces (bot, web, future API):

- `packages/ai/src/chat/index.ts` - main `runConversationTurn()` API
- `packages/ai/src/graph/state.ts` - LangGraph state annotation
- `packages/ai/src/graph/nodes/` - graph nodes (loadContext, generateResponse, persistResponse)
- `packages/ai/src/memory/index.ts` - context assembly + LangChain message conversion
- `packages/ai/src/prompts/index.ts` - system prompts
- `packages/ai/src/tools/index.ts` - tool registry (placeholder for future tools)
- `packages/ai/src/telemetry/index.ts` - graph step logging

## Core ownership

- `packages/core/src/env.ts` - validated environment loading
- `packages/core/src/db/schema.ts` - Drizzle schema
- `packages/core/src/db/client.ts` - DB client bootstrap
- `packages/core/src/services/setupService.ts` - setup state machine
- `packages/core/src/services/syncService.ts` - sync targets/runs/checkpoints/messages
- `packages/core/src/services/embeddingsService.ts` - embeddings targets/runs/checkpoints/vector storage
- `packages/core/src/services/ragService.ts` - minimal grounded Q&A retrieval/answering
- `packages/core/src/services/aiRepo.ts` - AI conversation/message repositories

## Web ownership

- `packages/web/src/routes/setup/+page.svelte` - onboarding UI
- `packages/web/src/routes/setup/+page.server.ts` - initial setup status + prefill
- `packages/web/src/routes/sync/+page.svelte` - sync operations UI
- `packages/web/src/routes/embeddings/+page.svelte` - embeddings operations UI
- `packages/web/src/routes/api/setup/*` - setup API endpoints
- `packages/web/src/routes/api/sync/*` - sync catalog/estimate/start/status endpoints
- `packages/web/src/routes/api/embeddings/*` - embeddings catalog/estimate/start/status/stop/reset endpoints
- `packages/web/src/lib/server/mtprotoGateway.ts` - Telegram auth gateway
- `packages/web/src/lib/server/syncGateway.ts` - dialog catalog + estimate gateway

## Bot and userbot ownership

- `packages/bot/src/index.ts` - `/start`, web-app URL behavior, onboarding entrypoint
- `packages/userbot/src/index.ts` - combined sync + embeddings worker loop, checkpoint resume, flood/backoff handling

## Migrations

- `packages/core/drizzle/` holds SQL migrations and Drizzle metadata snapshots
- `packages/core/drizzle.config.ts` is the migration config used from repo root scripts
