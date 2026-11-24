// Tests against a real PostgreSQL (spec 13). Set TEST_DATABASE_URL to run them.
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/server/db/migrate.js";
import { makeApp } from "./helpers.js";

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
