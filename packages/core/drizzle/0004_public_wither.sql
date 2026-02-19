CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."embedding_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."embedding_target_status" AS ENUM('pending', 'embedding', 'embedded', 'error');--> statement-breakpoint
CREATE TABLE "embedding_checkpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"chat_peer_id" bigint NOT NULL,
	"next_message_id" integer,
	"backfill_complete" boolean DEFAULT false NOT NULL,
	"last_processed_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding_run_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"status" "embedding_run_status" DEFAULT 'queued' NOT NULL,
	"model" text NOT NULL,
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
CREATE TABLE "embedding_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"chat_peer_id" bigint NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" "embedding_target_status" DEFAULT 'pending' NOT NULL,
	"estimated_messages" integer,
	"estimated_eta_seconds" integer,
	"last_embedded_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_message_embeddings" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"chat_peer_id" bigint NOT NULL,
	"message_id" integer NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"source_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_checkpoints_owner_chat_uq" ON "embedding_checkpoints" USING btree ("owner_telegram_id","chat_peer_id");--> statement-breakpoint
CREATE INDEX "embedding_checkpoints_owner_idx" ON "embedding_checkpoints" USING btree ("owner_telegram_id");--> statement-breakpoint
CREATE INDEX "embedding_run_logs_run_id_idx" ON "embedding_run_logs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "embedding_run_logs_owner_created_at_idx" ON "embedding_run_logs" USING btree ("owner_telegram_id","created_at");--> statement-breakpoint
CREATE INDEX "embedding_runs_owner_status_idx" ON "embedding_runs" USING btree ("owner_telegram_id","status");--> statement-breakpoint
CREATE INDEX "embedding_runs_owner_created_at_idx" ON "embedding_runs" USING btree ("owner_telegram_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_targets_owner_chat_uq" ON "embedding_targets" USING btree ("owner_telegram_id","chat_peer_id");--> statement-breakpoint
CREATE INDEX "embedding_targets_owner_status_idx" ON "embedding_targets" USING btree ("owner_telegram_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_message_embeddings_owner_chat_message_uq" ON "telegram_message_embeddings" USING btree ("owner_telegram_id","chat_peer_id","message_id");--> statement-breakpoint
CREATE INDEX "telegram_message_embeddings_owner_chat_idx" ON "telegram_message_embeddings" USING btree ("owner_telegram_id","chat_peer_id");--> statement-breakpoint
CREATE INDEX "telegram_message_embeddings_owner_model_idx" ON "telegram_message_embeddings" USING btree ("owner_telegram_id","model");
