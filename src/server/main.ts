// Entry point: configuration, database, migrations, HTTP server, daily cleanup, graceful shutdown.
import path from "node:path";
import pg from "pg";
import { buildApp } from "./app.js";
import { startCleanup } from "./cleanup.js";
import { type Config, parseConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";

let config: Config;
try {
  config = parseConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000 });
// Built before migrating so its pool error handler is attached; nothing listens yet.
const app = await buildApp(config, { pool, webRoot: path.resolve("dist/web") });

// Signals are handled from here on, before the migrations: in the container node is PID 1, and PID 1
// ignores a signal without a handler, so a stop while waiting for the migration lock hung until killed.
let stopCleanup: (() => void) | null = null;
let shutdown: Promise<void> | null = null;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // Before listening there is nothing to drain; an open migration transaction rolls back with the connection.
    if (!stopCleanup) process.exit(0);
    shutdown ??= (async () => {
      app.log.info(`${signal} received, shutting down`);
      stopCleanup!();
      await app.close();
      await pool.end();
      process.exit(0);
    })();
  });
}

await runMigrations(pool);
await app.listen({ port: config.port, host: "0.0.0.0" });
stopCleanup = startCleanup(pool, config.retentionDays, app.log, app.live);
