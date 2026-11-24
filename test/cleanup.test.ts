import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/server/cleanup.js";
import { runMigrations } from "../src/server/db/migrate.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("daily cleanup (spec 9.3)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
  });
  afterAll(() => pool.end());

  const tag = randomUUID().slice(0, 8);
  async function user(name: string, lastLoginDaysAgo: number) {
    const { rows } = await pool.query(
      "insert into users (discord_id, username, display_name, last_login_at) values ($1, $2, $2, now() - make_interval(days => $3)) returning id",
      [`1${String(Math.floor(Math.random() * 1e15)).padStart(17, "0")}`, `${tag}-${name}`, lastLoginDaysAgo],
    );
    return rows[0].id as string;
  }
  const exists = async (table: string, id: string) => (await pool.query(`select 1 from ${table} where id = $1`, [id])).rowCount === 1;

  it("deletes expired sessions, old users and old rooms, and keeps everything younger or still in a room", async () => {
    const fresh = await user("fresh", 89);
    const old = await user("old", 91);
    const oldInRoom = await user("old-in-room", 200);
    const oldInOldRoom = await user("old-in-old-room", 200);
    const room = (await pool.query("insert into rooms (slug, name, is_test, settings) values ($1, 'r', false, '{}') returning id", [`${tag}-r`])).rows[0].id;
    const oldRoom = (
      await pool.query("insert into rooms (slug, name, is_test, settings, last_activity_at) values ($1, 'r', false, '{}', now() - interval '91 days') returning id", [`${tag}-o`])
    ).rows[0].id;
    await pool.query("insert into room_members (room_id, user_id, participation) values ($1, $2, 'player'), ($3, $4, 'player')", [room, oldInRoom, oldRoom, oldInOldRoom]);
    await pool.query(
      "insert into sessions (id, user_id, expires_at) values ($1, $3, now() - interval '1 second'), ($2, $3, now() + interval '1 day')",
      [`${tag}-expired`, `${tag}-valid`, fresh],
    );

    const counts = await runCleanup(pool, 90);
    expect(counts.sessions).toBeGreaterThanOrEqual(1);
    expect(counts.users).toBeGreaterThanOrEqual(2);
    expect(counts.rooms).toBeGreaterThanOrEqual(1);

    expect(await exists("sessions", `${tag}-expired`)).toBe(false);
    expect(await exists("sessions", `${tag}-valid`)).toBe(true);
    expect(await exists("users", fresh)).toBe(true);
    expect(await exists("users", old)).toBe(false);
    expect(await exists("users", oldInRoom)).toBe(true);
    expect(await exists("rooms", room)).toBe(true);
    expect(await exists("rooms", oldRoom)).toBe(false);
    expect(await exists("users", oldInOldRoom)).toBe(false); // its room went first
  });
});
