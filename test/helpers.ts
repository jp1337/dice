import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import pg from "pg";
import { buildApp } from "../src/server/app.js";
import { parseConfig } from "../src/server/config.js";

// Fictitious values only: the repository is public.
export const baseEnv = {
  NODE_ENV: "test",
  BASE_URL: "https://dice.example.org",
  DATABASE_URL: "postgres://dice@127.0.0.1:1/dice",
  DISCORD_GUILD_ID: "100000000000000001",
  SESSION_SECRET: "test-session-secret-0123456789abcdef",
  DISCORD_CLIENT_ID: "100000000000000009",
  DISCORD_CLIENT_SECRET: "test-client-secret",
};

export const legalEnv = {
  LEGAL_NAME: "Erika <Muster>",
  LEGAL_ADDRESS: "c/o Beispiel & Co|Musterstraße 1|12345 Musterstadt",
  LEGAL_EMAIL: "dice@example.org",
};

// A stand-in for the Vite build output.
export function makeWebRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "dice-web-"));
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "index.html"), "<!doctype html><title>Würfel</title>");
  writeFileSync(path.join(root, "assets", "index-abc123.js"), "console.log(1)");
  return root;
}

export async function makeApp(env: Record<string, string> = {}, databaseUrl = baseEnv.DATABASE_URL) {
  const config = parseConfig({ ...baseEnv, ...env });
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
  const logs: Record<string, unknown>[] = [];
  const logStream = new PassThrough();
  logStream.on("data", (line: Buffer) => logs.push(JSON.parse(line.toString())));
  // Log level "info" so the request log can be checked.
  const app = await buildApp({ ...config, nodeEnv: "development" }, { pool, webRoot: makeWebRoot(), logStream });
  app.addHook("onClose", () => pool.end());
  return { app, logs };
}
