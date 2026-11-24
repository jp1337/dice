// Applies the SQL migrations in /drizzle. Runs at every start, before the server listens.
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

// Relative to the working directory: the repository root locally, /app in the container.
export const runMigrations = (pool: Pool) =>
  migrate(drizzle({ client: pool }), { migrationsFolder: path.resolve("drizzle") });
