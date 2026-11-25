// Tests against a real PostgreSQL (spec 13). Set TEST_DATABASE_URL to run them.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/server/db/migrate.js";
import { makeApp, ownDatabase } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("with PostgreSQL", () => {
  it("applies the migrations, also a second time", async () => {
    const pool = new pg.Pool({ connectionString: url });
    try {
      await runMigrations(pool);
      await runMigrations(pool);
      const { rows } = await pool.query("select table_name from information_schema.tables where table_schema = 'public' order by 1");
      expect(rows.map((r) => r.table_name)).toEqual(["game_events", "room_members", "rooms", "sessions", "users"]);
    } finally {
      await pool.end();
    }
  });

  it("migrates a fresh database from several callers at once (test files, two containers)", async () => {
    const name = `dice_migrate_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const fresh = new URL(url!);
    fresh.pathname = `/${name}`;
    const pools = Array.from({ length: 5 }, () => new pg.Pool({ connectionString: fresh.href }));
    try {
      await Promise.all(pools.map((pool) => runMigrations(pool)));
      const { rows } = await pools[0]!.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'");
      expect(rows[0].n).toBe(5);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await admin.query(`drop database ${name}`);
      await admin.end();
    }
  }, 20_000); // creates and migrates a database while other files create theirs (helpers.ts ownDatabase): 0.5 s alone, over 5 s under that load

  it("makes rooms from before the public switch public only where their guest link was on", async () => {
    // The database as the first release left it: only 0000_init applied.
    const old = mkdtempSync(path.join(tmpdir(), "dice-migrations-"));
    mkdirSync(path.join(old, "meta"));
    copyFileSync("drizzle/0000_init.sql", path.join(old, "0000_init.sql"));
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    writeFileSync(path.join(old, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
    const pool = new pg.Pool({ connectionString: await ownDatabase() });
    try {
      await migrate(drizzle({ client: pool }), { migrationsFolder: old });
      const { rows } = await pool.query(
        `insert into rooms (slug, name, is_test, settings, watch_token) values ('with-link', 'a', false, '{}', 'token'), ('without', 'b', false, '{}', null) returning id`,
      );
      await pool.query(`insert into game_events (room_id, seq, type, payload) values ($1, 1, 'watch_link_changed', '{"enabled": true}')`, [rows[0].id]);

      await runMigrations(pool);
      expect((await pool.query("select slug, is_public from rooms order by slug")).rows).toEqual([
        { slug: "with-link", is_public: true },
        { slug: "without", is_public: false },
      ]);
      expect((await pool.query("select type, payload from game_events")).rows).toEqual([{ type: "public_changed", payload: { isPublic: true } }]);
    } finally {
      await pool.end();
      rmSync(old, { recursive: true });
    }
  });

  it("/healthz returns 200 ok", async () => {
    const { app } = await makeApp({}, url);
    const res = await app.inject({ url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("ok");
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive, nosnippet, noimageindex");
    await app.close();
  });

  it("survives an idle database client losing its connection", async () => {
    const tagged = new URL(url!);
    tagged.searchParams.set("application_name", "dice-idle-test");
    const { app, logs } = await makeApp({}, tagged.href);
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200); // leaves an idle client
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'dice-idle-test'");
    await admin.end();
    await vi.waitFor(() => expect(logs.some((l) => l.msg === "idle database client failed")).toBe(true));
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
    expect(JSON.stringify(logs)).not.toContain("password");
    await app.close();
  });
});
