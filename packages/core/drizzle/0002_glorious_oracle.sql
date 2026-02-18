CREATE TYPE "public"."sync_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sync_target_status" AS ENUM('pending', 'syncing', 'synced', 'error');--> statement-breakpoint
CREATE TABLE "sync_checkpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"chat_peer_id" bigint NOT NULL,
	"next_max_id" integer,
	"newest_message_id" integer,
	"oldest_message_id" integer,
	"backfill_complete" boolean DEFAULT false NOT NULL,
	"last_processed_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_run_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"status" "sync_run_status" DEFAULT 'queued' NOT NULL,
	"chat_peer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_chats" integer DEFAULT 0 NOT NULL,
	"completed_chats" integer DEFAULT 0 NOT NULL,
	"estimated_messages" integer DEFAULT 0 NOT NULL,
	"processed_messages" integer DEFAULT 0 NOT NULL,
	"eta_seconds" integer,
	"current_chat_peer_id" bigint,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"chat_peer_id" bigint NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" "sync_target_status" DEFAULT 'pending' NOT NULL,
	"estimated_messages" integer,
	"estimated_eta_seconds" integer,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"peer_id" bigint NOT NULL,
	"peer_type" text DEFAULT 'user' NOT NULL,
	"title" text NOT NULL,
	"username" text,
	"is_bot" boolean DEFAULT false NOT NULL,
	"folder_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_message_id" integer,
	"last_message_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_message_media" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"chat_peer_id" bigint NOT NULL,
	"message_id" integer NOT NULL,
	"media_type" text NOT NULL,
	"file_id" text,
	"file_unique_id" text,
	"mime_type" text,
	"file_name" text,
	"duration_seconds" integer,
	"width" integer,
	"height" integer,
	"size_bytes" bigint,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"chat_peer_id" bigint NOT NULL,
	"message_id" integer NOT NULL,
	"sender_peer_id" bigint,
	"date" timestamp with time zone NOT NULL,
	"edit_date" timestamp with time zone,
	"text" text,
	"is_outgoing" boolean DEFAULT false NOT NULL,
	"is_service" boolean DEFAULT false NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"has_media" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sync_checkpoints_owner_chat_uq" ON "sync_checkpoints" USING btree ("owner_telegram_id","chat_peer_id");--> statement-breakpoint
CREATE INDEX "sync_checkpoints_owner_idx" ON "sync_checkpoints" USING btree ("owner_telegram_id");--> statement-breakpoint
CREATE INDEX "sync_run_logs_run_id_idx" ON "sync_run_logs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "sync_run_logs_owner_created_at_idx" ON "sync_run_logs" USING btree ("owner_telegram_id","created_at");--> statement-breakpoint
CREATE INDEX "sync_runs_owner_status_idx" ON "sync_runs" USING btree ("owner_telegram_id","status");--> statement-breakpoint
CREATE INDEX "sync_runs_owner_created_at_idx" ON "sync_runs" USING btree ("owner_telegram_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_targets_owner_chat_uq" ON "sync_targets" USING btree ("owner_telegram_id","chat_peer_id");--> statement-breakpoint
CREATE INDEX "sync_targets_owner_status_idx" ON "sync_targets" USING btree ("owner_telegram_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_chats_owner_peer_uq" ON "telegram_chats" USING btree ("owner_telegram_id","peer_id");--> statement-breakpoint
CREATE INDEX "telegram_chats_owner_idx" ON "telegram_chats" USING btree ("owner_telegram_id");--> statement-breakpoint
CREATE INDEX "telegram_chats_owner_title_idx" ON "telegram_chats" USING btree ("owner_telegram_id","title");--> statement-breakpoint
CREATE INDEX "telegram_message_media_owner_chat_message_idx" ON "telegram_message_media" USING btree ("owner_telegram_id","chat_peer_id","message_id");--> statement-breakpoint
CREATE INDEX "telegram_message_media_owner_media_type_idx" ON "telegram_message_media" USING btree ("owner_telegram_id","media_type");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_messages_owner_chat_message_uq" ON "telegram_messages" USING btree ("owner_telegram_id","chat_peer_id","message_id");--> statement-breakpoint
CREATE INDEX "telegram_messages_owner_chat_date_idx" ON "telegram_messages" USING btree ("owner_telegram_id","chat_peer_id","date");--> statement-breakpoint
CREATE INDEX "telegram_messages_owner_date_idx" ON "telegram_messages" USING btree ("owner_telegram_id","date");