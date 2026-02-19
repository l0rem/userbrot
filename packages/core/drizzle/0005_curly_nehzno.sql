DROP INDEX "embedding_checkpoints_owner_chat_uq";--> statement-breakpoint
DROP INDEX "embedding_checkpoints_owner_idx";--> statement-breakpoint
DROP INDEX "embedding_run_logs_owner_created_at_idx";--> statement-breakpoint
DROP INDEX "embedding_runs_owner_status_idx";--> statement-breakpoint
DROP INDEX "embedding_runs_owner_created_at_idx";--> statement-breakpoint
DROP INDEX "embedding_targets_owner_chat_uq";--> statement-breakpoint
DROP INDEX "embedding_targets_owner_status_idx";--> statement-breakpoint
DROP INDEX "setup_state_owner_telegram_id_uq";--> statement-breakpoint
DROP INDEX "sync_checkpoints_owner_chat_uq";--> statement-breakpoint
DROP INDEX "sync_checkpoints_owner_idx";--> statement-breakpoint
DROP INDEX "sync_run_logs_owner_created_at_idx";--> statement-breakpoint
DROP INDEX "sync_runs_owner_status_idx";--> statement-breakpoint
DROP INDEX "sync_runs_owner_created_at_idx";--> statement-breakpoint
DROP INDEX "sync_targets_owner_chat_uq";--> statement-breakpoint
DROP INDEX "sync_targets_owner_status_idx";--> statement-breakpoint
DROP INDEX "telegram_chats_owner_peer_uq";--> statement-breakpoint
DROP INDEX "telegram_chats_owner_idx";--> statement-breakpoint
DROP INDEX "telegram_chats_owner_title_idx";--> statement-breakpoint
DROP INDEX "telegram_message_embeddings_owner_chat_idx";--> statement-breakpoint
DROP INDEX "telegram_message_embeddings_owner_model_idx";--> statement-breakpoint
DROP INDEX "telegram_message_media_owner_media_type_idx";--> statement-breakpoint
DROP INDEX "telegram_messages_owner_chat_date_idx";--> statement-breakpoint
DROP INDEX "telegram_messages_owner_date_idx";--> statement-breakpoint
DROP INDEX "telegram_message_embeddings_owner_chat_message_uq";--> statement-breakpoint
DROP INDEX "telegram_message_media_owner_chat_message_idx";--> statement-breakpoint
DROP INDEX "telegram_messages_owner_chat_message_uq";--> statement-breakpoint
DELETE FROM "telegram_chats"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "peer_id" ORDER BY "updated_at" DESC, "id" DESC) AS rn
    FROM "telegram_chats"
  ) ranked
  WHERE ranked.rn > 1
);--> statement-breakpoint
DELETE FROM "sync_targets"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "chat_peer_id" ORDER BY "updated_at" DESC, "id" DESC) AS rn
    FROM "sync_targets"
  ) ranked
  WHERE ranked.rn > 1
);--> statement-breakpoint
DELETE FROM "sync_checkpoints"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "chat_peer_id" ORDER BY "updated_at" DESC, "id" DESC) AS rn
    FROM "sync_checkpoints"
  ) ranked
  WHERE ranked.rn > 1
);--> statement-breakpoint
DELETE FROM "embedding_targets"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "chat_peer_id" ORDER BY "updated_at" DESC, "id" DESC) AS rn
    FROM "embedding_targets"
  ) ranked
  WHERE ranked.rn > 1
);--> statement-breakpoint
DELETE FROM "embedding_checkpoints"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "chat_peer_id" ORDER BY "updated_at" DESC, "id" DESC) AS rn
    FROM "embedding_checkpoints"
  ) ranked
  WHERE ranked.rn > 1
);--> statement-breakpoint
DELETE FROM "telegram_messages"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "chat_peer_id", "message_id" ORDER BY "updated_at" DESC, "id" DESC) AS rn
    FROM "telegram_messages"
  ) ranked
  WHERE ranked.rn > 1
);--> statement-breakpoint
DELETE FROM "telegram_message_embeddings"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "chat_peer_id", "message_id" ORDER BY "updated_at" DESC, "id" DESC) AS rn
    FROM "telegram_message_embeddings"
  ) ranked
  WHERE ranked.rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_checkpoints_chat_uq" ON "embedding_checkpoints" USING btree ("chat_peer_id");--> statement-breakpoint
CREATE INDEX "embedding_run_logs_created_at_idx" ON "embedding_run_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "embedding_runs_status_idx" ON "embedding_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "embedding_runs_created_at_idx" ON "embedding_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_targets_chat_uq" ON "embedding_targets" USING btree ("chat_peer_id");--> statement-breakpoint
CREATE INDEX "embedding_targets_status_idx" ON "embedding_targets" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_checkpoints_chat_uq" ON "sync_checkpoints" USING btree ("chat_peer_id");--> statement-breakpoint
CREATE INDEX "sync_run_logs_created_at_idx" ON "sync_run_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_runs_status_idx" ON "sync_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sync_runs_created_at_idx" ON "sync_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_targets_chat_uq" ON "sync_targets" USING btree ("chat_peer_id");--> statement-breakpoint
CREATE INDEX "sync_targets_status_idx" ON "sync_targets" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_chats_peer_uq" ON "telegram_chats" USING btree ("peer_id");--> statement-breakpoint
CREATE INDEX "telegram_chats_title_idx" ON "telegram_chats" USING btree ("title");--> statement-breakpoint
CREATE INDEX "telegram_message_embeddings_chat_idx" ON "telegram_message_embeddings" USING btree ("chat_peer_id");--> statement-breakpoint
CREATE INDEX "telegram_message_embeddings_model_idx" ON "telegram_message_embeddings" USING btree ("model");--> statement-breakpoint
CREATE INDEX "telegram_message_media_media_type_idx" ON "telegram_message_media" USING btree ("media_type");--> statement-breakpoint
CREATE INDEX "telegram_messages_chat_date_idx" ON "telegram_messages" USING btree ("chat_peer_id","date");--> statement-breakpoint
CREATE INDEX "telegram_messages_date_idx" ON "telegram_messages" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_message_embeddings_owner_chat_message_uq" ON "telegram_message_embeddings" USING btree ("chat_peer_id","message_id");--> statement-breakpoint
CREATE INDEX "telegram_message_media_owner_chat_message_idx" ON "telegram_message_media" USING btree ("chat_peer_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_messages_owner_chat_message_uq" ON "telegram_messages" USING btree ("chat_peer_id","message_id");--> statement-breakpoint
ALTER TABLE "embedding_checkpoints" DROP COLUMN "owner_telegram_id";--> statement-breakpoint
ALTER TABLE "embedding_run_logs" DROP COLUMN "owner_telegram_id";--> statement-breakpoint
ALTER TABLE "embedding_runs" DROP COLUMN "owner_telegram_id";--> statement-breakpoint
ALTER TABLE "embedding_targets" DROP COLUMN "owner_telegram_id";--> statement-breakpoint
ALTER TABLE "setup_state" DROP COLUMN "owner_telegram_id";--> statement-breakpoint
ALTER TABLE "sync_checkpoints" DROP COLUMN "owner_telegram_id";--> statement-breakpoint
ALTER TABLE "sync_run_logs" DROP COLUMN "owner_telegram_id";--> statement-breakpoint
ALTER TABLE "sync_runs" DROP COLUMN "owner_telegram_id";--> statement-breakpoint
ALTER TABLE "sync_targets" DROP COLUMN "owner_telegram_id";--> statement-breakpoint
ALTER TABLE "telegram_chats" DROP COLUMN "owner_telegram_id";--> statement-breakpoint
ALTER TABLE "telegram_message_embeddings" DROP COLUMN "owner_telegram_id";--> statement-breakpoint
ALTER TABLE "telegram_message_media" DROP COLUMN "owner_telegram_id";--> statement-breakpoint
ALTER TABLE "telegram_messages" DROP COLUMN "owner_telegram_id";
