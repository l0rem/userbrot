import { getEnv } from "../env";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const env = getEnv();

const sql = postgres(env.DATABASE_URL, {
  max: 10,
  prepare: false
});

export const db = drizzle(sql, { schema });
export { sql };
