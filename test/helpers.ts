import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import pg from "pg";
import { afterAll } from "vitest";
import { type Deps, buildApp } from "../src/server/app.js";
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

// A stand-in for the Vite build output, with the real index.html: Vite keeps its meta tags as they are.
export function makeWebRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "dice-web-"));
  mkdirSync(path.join(root, "assets"));
  copyFileSync(new URL("../src/web/index.html", import.meta.url), path.join(root, "index.html"));
  writeFileSync(path.join(root, "assets", "index-abc123.js"), "console.log(1)");
  return root;
}

export async function makeApp(env: Record<string, string> = {}, databaseUrl = baseEnv.DATABASE_URL, deps: Partial<Deps> = {}) {
  const config = parseConfig({ ...baseEnv, ...env });
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
  const logs: Record<string, unknown>[] = [];
  const logStream = new PassThrough();
  logStream.on("data", (line: Buffer) => logs.push(JSON.parse(line.toString())));
  // Log level "info" so the request log can be checked.
  const app = await buildApp({ ...config, nodeEnv: "development" }, { pool, webRoot: makeWebRoot(), logStream, ...deps });
  app.addHook("onClose", () => pool.end());
  return { app, logs };
}

// A database of its own for a test file that runs runCleanup: that deletes across the whole database, so
// files sharing one deleted each other's deliberately aged rooms mid-test (in CI, every run). Dropped after
// the file. Undefined without TEST_DATABASE_URL, so the file's skipIf still works.
export async function ownDatabase(url = process.env.TEST_DATABASE_URL) {
  if (!url) return undefined;
  const name = `dice_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  afterAll(async () => {
    const dropper = new pg.Client({ connectionString: url });
    await dropper.connect();
    await dropper.query(`drop database if exists ${name} with (force)`);
    await dropper.end();
  });
  const own = new URL(url);
  own.pathname = `/${name}`;
  return own.href;
}
