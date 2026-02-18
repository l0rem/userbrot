# Engineering Guidelines

## Architecture rules

- Keep shared domain logic in `packages/core`; keep service-specific logic inside each runtime package.
- Avoid circular dependencies between packages.
- Prefer explicit service boundaries over convenience imports.

## Coding standards

- Use TypeScript strict mode and keep `bun run check` green.
- Add comments only where behavior is non-obvious.
- Follow existing naming patterns and file placement before introducing new abstractions.

## Security and secrets

- Never commit `.env` values, tokens, phone codes, or session strings.
- Treat MTProto session strings as credentials.
- Keep logs free of secrets and personally sensitive data.

## Data and migrations

- Schema changes must include a generated Drizzle migration.
- Prefer additive migrations unless explicitly cleaning old columns.
- Validate migration + runtime compatibility after schema changes.

## PR readiness

- Always run `bun run check` and `bun run build` before finalizing changes.
- Smoke-test changed runtime paths (web routes, bot start, userbot startup).
- Update docs when commands, layout, or setup behavior changes.
