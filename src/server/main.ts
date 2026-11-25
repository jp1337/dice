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
await runMigrations(pool);
await app.listen({ port: config.port, host: "0.0.0.0" });
const stopCleanup = startCleanup(pool, config.retentionDays, app.log, app.live);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    stopCleanup();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
// TEMP measure 1, removed before merge
