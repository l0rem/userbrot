CREATE TYPE "public"."setup_status" AS ENUM('not_configured', 'awaiting_code', 'awaiting_password', 'configured');--> statement-breakpoint
CREATE TABLE "mtproto_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"session_string" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_telegram_id" bigint NOT NULL,
	"status" "setup_status" DEFAULT 'not_configured' NOT NULL,
	"phone" text,
	"phone_code_hash" text,
	"requires_password" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mtproto_sessions_owner_telegram_id_uq" ON "mtproto_sessions" USING btree ("owner_telegram_id");--> statement-breakpoint
CREATE INDEX "mtproto_sessions_owner_telegram_id_idx" ON "mtproto_sessions" USING btree ("owner_telegram_id");--> statement-breakpoint
CREATE UNIQUE INDEX "setup_state_owner_telegram_id_uq" ON "setup_state" USING btree ("owner_telegram_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_telegram_user_id_uq" ON "users" USING btree ("telegram_user_id");