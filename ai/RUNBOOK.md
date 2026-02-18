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
