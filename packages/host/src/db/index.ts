// Postgres, two ways: a real server when DATABASE_URL is set (deployments), or PGlite, Postgres
// compiled to WebAssembly running in this process with its files under data/host/pg (local and LAN
// demos, nothing extra to run). Same schema, same migrations, same queries.
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzleLite } from "drizzle-orm/pglite";
import { migrate as migrateLite } from "drizzle-orm/pglite/migrator";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as schema from "./schema.js";

export const DATA_DIR = fileURLToPath(new URL("../../../../data/host", import.meta.url));
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export type Db = PgDatabase<any, typeof schema>;

export async function openDb(): Promise<{ db: Db; where: string }> {
  if (process.env.DATABASE_URL) {
    const db = drizzlePg(new pg.Pool({ connectionString: process.env.DATABASE_URL }), { schema });
    await migratePg(db, { migrationsFolder });
    return { db: db as unknown as Db, where: "Postgres at DATABASE_URL" };
  }
  mkdirSync(`${DATA_DIR}/pg`, { recursive: true });
  const db = drizzleLite(new PGlite(`${DATA_DIR}/pg`), { schema });
  await migrateLite(db, { migrationsFolder });
  return { db: db as unknown as Db, where: `embedded Postgres (PGlite) in ${DATA_DIR}/pg` };
}

export { schema };
