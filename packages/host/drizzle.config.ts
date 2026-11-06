import { defineConfig } from "drizzle-kit";

// `pnpm -C packages/host db:generate` writes a new migration after a schema change; the host applies
// pending migrations on start, against PGlite or DATABASE_URL.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
