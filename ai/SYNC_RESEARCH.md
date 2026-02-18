# Telegram Sync Research Notes

Date: 2026-02-18

## Problem observed

- `messages.getHistory(...).total` can return sentinel-like values (`2147483647`) in private chats.
- Using message ID as fallback count is invalid for private chats because IDs are not reliable as per-chat message count.
- High request rate causes frequent flood waits.

## Cross-library patterns (Telethon / Pyrogram / GramJS)

- Use history iterators/pagination based on `offset_id` + `add_offset` (or equivalent offset params).
- Avoid assuming `total` is exact in all contexts.
- Treat flood waits as normal control flow: catch, sleep, continue.
- Add intentional spacing between history requests (`wait_time` / delay) for long backfills.

## Design direction adopted

- Backfill via `getHistory(limit, offsetId=anchor, addOffset=cursor)` with cursor checkpointing.
- Keep a fixed anchor (`newest message at sync start + 1`) to avoid drift while new messages arrive.
- Store resumable cursor (`next offset`) and boundary (`oldest processed message id`) in checkpoints.
- On legacy checkpoints from the old `maxId` model, fall back safely and continue idempotent upserts.
- For estimates:
  - if API returns sentinel/unknown totals, mark estimate as unknown (`null`) instead of fake numbers.
  - show accurate counts for synced chats from DB aggregate counts.

## Practical flood-wait strategy

- Request spacing (`INTER_BATCH_DELAY_MS`) increased to reduce flood frequency.
- Flood waits are retried with explicit wait + jitter.
- Textual fallback detection for errors like "A wait of X seconds is required".
