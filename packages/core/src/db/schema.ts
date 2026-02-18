import {
  bigint,
  boolean,
  integer,
  index,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";

export const setupStatusEnum = pgEnum("setup_status", [
  "not_configured",
  "awaiting_code",
  "awaiting_password",
  "configured"
]);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    telegramUserId: bigint("telegram_user_id", { mode: "bigint" }).notNull(),
    username: text("username"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [uniqueIndex("users_telegram_user_id_uq").on(table.telegramUserId)]
);

export const setupState = pgTable(
  "setup_state",
  {
    id: serial("id").primaryKey(),
    ownerTelegramId: bigint("owner_telegram_id", { mode: "bigint" }).notNull(),
    status: setupStatusEnum("status").default("not_configured").notNull(),
    phone: text("phone"),
    phoneCodeHash: text("phone_code_hash"),
    authSessionString: text("auth_session_string"),
    requiresPassword: boolean("requires_password").default(false).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [uniqueIndex("setup_state_owner_telegram_id_uq").on(table.ownerTelegramId)]
);

export const mtprotoSessions = pgTable(
  "mtproto_sessions",
  {
    id: serial("id").primaryKey(),
    ownerTelegramId: bigint("owner_telegram_id", { mode: "bigint" }).notNull(),
    sessionString: text("session_string").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("mtproto_sessions_owner_telegram_id_uq").on(table.ownerTelegramId),
    index("mtproto_sessions_owner_telegram_id_idx").on(table.ownerTelegramId)
  ]
);

export const syncTargetStatusEnum = pgEnum("sync_target_status", [
  "pending",
  "syncing",
  "synced",
  "error"
]);

export const syncRunStatusEnum = pgEnum("sync_run_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

export const telegramChats = pgTable(
  "telegram_chats",
  {
    id: serial("id").primaryKey(),
    ownerTelegramId: bigint("owner_telegram_id", { mode: "bigint" }).notNull(),
    peerId: bigint("peer_id", { mode: "bigint" }).notNull(),
    peerType: text("peer_type").default("user").notNull(),
    title: text("title").notNull(),
    username: text("username"),
    isBot: boolean("is_bot").default(false).notNull(),
    folderIds: jsonb("folder_ids").$type<number[]>().default([]).notNull(),
    lastMessageId: integer("last_message_id"),
    lastMessageDate: timestamp("last_message_date", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("telegram_chats_owner_peer_uq").on(table.ownerTelegramId, table.peerId),
    index("telegram_chats_owner_idx").on(table.ownerTelegramId),
    index("telegram_chats_owner_title_idx").on(table.ownerTelegramId, table.title)
  ]
);

export const syncTargets = pgTable(
  "sync_targets",
  {
    id: serial("id").primaryKey(),
    ownerTelegramId: bigint("owner_telegram_id", { mode: "bigint" }).notNull(),
    chatPeerId: bigint("chat_peer_id", { mode: "bigint" }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    status: syncTargetStatusEnum("status").default("pending").notNull(),
    estimatedMessages: integer("estimated_messages"),
    estimatedEtaSeconds: integer("estimated_eta_seconds"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("sync_targets_owner_chat_uq").on(table.ownerTelegramId, table.chatPeerId),
    index("sync_targets_owner_status_idx").on(table.ownerTelegramId, table.status)
  ]
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: serial("id").primaryKey(),
    ownerTelegramId: bigint("owner_telegram_id", { mode: "bigint" }).notNull(),
    status: syncRunStatusEnum("status").default("queued").notNull(),
    chatPeerIds: jsonb("chat_peer_ids").$type<string[]>().default([]).notNull(),
    totalChats: integer("total_chats").default(0).notNull(),
    completedChats: integer("completed_chats").default(0).notNull(),
    estimatedMessages: integer("estimated_messages").default(0).notNull(),
    processedMessages: integer("processed_messages").default(0).notNull(),
    etaSeconds: integer("eta_seconds"),
    currentChatPeerId: bigint("current_chat_peer_id", { mode: "bigint" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("sync_runs_owner_status_idx").on(table.ownerTelegramId, table.status),
    index("sync_runs_owner_created_at_idx").on(table.ownerTelegramId, table.createdAt)
  ]
);

export const syncRunLogs = pgTable(
  "sync_run_logs",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id").notNull(),
    ownerTelegramId: bigint("owner_telegram_id", { mode: "bigint" }).notNull(),
    level: text("level").default("info").notNull(),
    message: text("message").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("sync_run_logs_run_id_idx").on(table.runId),
    index("sync_run_logs_owner_created_at_idx").on(table.ownerTelegramId, table.createdAt)
  ]
);

export const syncCheckpoints = pgTable(
  "sync_checkpoints",
  {
    id: serial("id").primaryKey(),
    ownerTelegramId: bigint("owner_telegram_id", { mode: "bigint" }).notNull(),
    chatPeerId: bigint("chat_peer_id", { mode: "bigint" }).notNull(),
    nextMaxId: integer("next_max_id"),
    nextOffset: integer("next_offset"),
    newestMessageId: integer("newest_message_id"),
    oldestMessageId: integer("oldest_message_id"),
    backfillComplete: boolean("backfill_complete").default(false).notNull(),
    lastProcessedAt: timestamp("last_processed_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("sync_checkpoints_owner_chat_uq").on(table.ownerTelegramId, table.chatPeerId),
    index("sync_checkpoints_owner_idx").on(table.ownerTelegramId)
  ]
);

export const telegramMessages = pgTable(
  "telegram_messages",
  {
    id: serial("id").primaryKey(),
    ownerTelegramId: bigint("owner_telegram_id", { mode: "bigint" }).notNull(),
    chatPeerId: bigint("chat_peer_id", { mode: "bigint" }).notNull(),
    messageId: integer("message_id").notNull(),
    senderPeerId: bigint("sender_peer_id", { mode: "bigint" }),
    date: timestamp("date", { withTimezone: true }).notNull(),
    editDate: timestamp("edit_date", { withTimezone: true }),
    text: text("text"),
    isOutgoing: boolean("is_outgoing").default(false).notNull(),
    isService: boolean("is_service").default(false).notNull(),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    hasMedia: boolean("has_media").default(false).notNull(),
    raw: jsonb("raw").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("telegram_messages_owner_chat_message_uq").on(
      table.ownerTelegramId,
      table.chatPeerId,
      table.messageId
    ),
    index("telegram_messages_owner_chat_date_idx").on(
      table.ownerTelegramId,
      table.chatPeerId,
      table.date
    ),
    index("telegram_messages_owner_date_idx").on(table.ownerTelegramId, table.date)
  ]
);

export const telegramMessageMedia = pgTable(
  "telegram_message_media",
  {
    id: serial("id").primaryKey(),
    ownerTelegramId: bigint("owner_telegram_id", { mode: "bigint" }).notNull(),
    chatPeerId: bigint("chat_peer_id", { mode: "bigint" }).notNull(),
    messageId: integer("message_id").notNull(),
    mediaType: text("media_type").notNull(),
    fileId: text("file_id"),
    fileUniqueId: text("file_unique_id"),
    mimeType: text("mime_type"),
    fileName: text("file_name"),
    durationSeconds: integer("duration_seconds"),
    width: integer("width"),
    height: integer("height"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    raw: jsonb("raw").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("telegram_message_media_owner_chat_message_idx").on(
      table.ownerTelegramId,
      table.chatPeerId,
      table.messageId
    ),
    index("telegram_message_media_owner_media_type_idx").on(table.ownerTelegramId, table.mediaType)
  ]
);

export type SetupStatus = (typeof setupStatusEnum.enumValues)[number];
export type SyncTargetStatus = (typeof syncTargetStatusEnum.enumValues)[number];
export type SyncRunStatus = (typeof syncRunStatusEnum.enumValues)[number];
