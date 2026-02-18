# Userbrot Copilot Instructions

## Project summary

Userbrot is a Bun + TypeScript monorepo for a private single-owner Telegram automation stack.
Runtimes live in `packages/bot`, `packages/userbot`, and `packages/web`; shared code is in `packages/core`.

## Always follow this workflow

1. Install dependencies with `bun install`.
2. Run checks with `bun run check` after code changes.
3. Run `bun run build` when web/runtime behavior is changed.
4. If schema changes are made, run `bun run db:generate` and `bun run db:migrate`.

## Key paths

- Setup UI: `packages/web/src/routes/setup/+page.svelte`
- Setup API: `packages/web/src/routes/api/setup/*`
- Telegram auth gateway: `packages/web/src/lib/server/mtprotoGateway.ts`
- Setup state machine: `packages/core/src/services/setupService.ts`
- DB schema: `packages/core/src/db/schema.ts`
- Migrations: `packages/core/drizzle/`

## Guardrails

- Do not log secrets, phone codes, bot tokens, or session strings.
- Do not change environment variable names without updating docs.
- Keep changes minimal and aligned with existing architecture.
