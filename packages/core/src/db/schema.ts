import {
  bigint,
  boolean,
  index,
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

export type SetupStatus = (typeof setupStatusEnum.enumValues)[number];
