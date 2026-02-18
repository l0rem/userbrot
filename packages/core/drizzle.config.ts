import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set before running drizzle commands");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/core/src/db/schema.ts",
  out: "./packages/core/drizzle",
  dbCredentials: {
    url: databaseUrl
  },
  verbose: true,
  strict: true
});
