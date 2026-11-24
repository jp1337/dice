// Applies the SQL migrations in /drizzle. Runs at every start, before the server listens.
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

// Any fixed number; only this app takes it. Session-level, so it is held on one dedicated client.
const MIGRATION_LOCK = 7_340_000_001;

// One migration at a time per database: two containers starting at once, or several test files, would
// otherwise race on CREATE SCHEMA and the migrations table.
export async function runMigrations(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    // Relative to the working directory: the repository root locally, /app in the container.
    await migrate(drizzle({ client }), { migrationsFolder: path.resolve("drizzle") });
  } finally {
    // Also released when the connection ends; a failed unlock must not hide the migration's error.
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}
