import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  BOT_TOKEN: z.string().min(1).optional(),
  TG_API_ID: z.coerce.number().int().positive().optional(),
  TG_API_HASH: z.string().min(1).optional(),
  SETUP_PHONE: z.string().trim().min(7).max(32).optional(),
  WEB_APP_URL: z.string().url().default("http://localhost:3000"),
  OWNER_TELEGRAM_ID: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().min(1).optional(),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().min(1).optional()
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;
let envLoaded = false;

function loadWorkspaceEnv() {
  if (envLoaded) {
    return;
  }

  const start = dirname(fileURLToPath(import.meta.url));
  let current = start;

  for (let i = 0; i < 8; i += 1) {
    const envPath = join(current, ".env");
    if (existsSync(envPath)) {
      loadDotenv({ path: envPath, override: false, quiet: true });
      const localPath = join(current, ".env.local");
      if (existsSync(localPath)) {
        loadDotenv({ path: localPath, override: true, quiet: true });
      }
      envLoaded = true;
      return;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  envLoaded = true;
}

export function getEnv(): Env {
  loadWorkspaceEnv();

  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}

export function getOwnerTelegramId(): bigint | null {
  const env = getEnv();
  if (!env.OWNER_TELEGRAM_ID) {
    return null;
  }
  return BigInt(env.OWNER_TELEGRAM_ID);
}

export function requireBotToken(): string {
  const token = getEnv().BOT_TOKEN;
  if (!token) {
    throw new Error("BOT_TOKEN must be set in environment");
  }
  return token;
}

export function requireMtprotoApiCredentials(): { apiId: number; apiHash: string } {
  const env = getEnv();
  if (!env.TG_API_ID || !env.TG_API_HASH) {
    throw new Error("TG_API_ID and TG_API_HASH must be set in environment");
  }

  return {
    apiId: env.TG_API_ID,
    apiHash: env.TG_API_HASH
  };
}

export type LlmProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export function requireLlmProviderConfig(): LlmProviderConfig {
  const env = getEnv();

  const apiKey = env.LLM_API_KEY ?? env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY or OPENROUTER_API_KEY must be set in environment");
  }

  return {
    baseUrl: env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey,
    model: env.LLM_MODEL ?? "openai/gpt-4o-mini"
  };
}

export function requireEmbeddingProviderConfig(): LlmProviderConfig {
  const llm = requireLlmProviderConfig();
  const env = getEnv();

  return {
    baseUrl: env.EMBEDDING_BASE_URL ?? llm.baseUrl,
    apiKey: env.EMBEDDING_API_KEY ?? llm.apiKey,
    model: env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small"
  };
}
