// Daily deletion of old data (spec 9.3). Runs at startup and then every 24 hours; logs only counts.
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

const DAY_MS = 86_400_000;

// What the rooms module has in use right now: never deleted, however old (rooms with connections and
// the people connected).
export type LiveRooms = { roomIds(): string[]; userIds(): string[] };
const nothingLive: LiveRooms = { roomIds: () => [], userIds: () => [] };

// In this order: deleting a room first frees its members for the user rule. $1 = retention cutoff,
// $2 = ids in use. Step 5 adds simulated players here.
const statements = {
  sessions: "delete from sessions where expires_at <= now()",
  rooms: "delete from rooms where last_activity_at < $1 and id <> all($2::uuid[])", // members and events cascade
  users: `delete from users u where not u.is_simulated and u.last_login_at < $1 and u.id <> all($2::uuid[])
    and not exists (select 1 from room_members m where m.user_id = u.id)`, // sessions cascade
};

export async function runCleanup(pool: Pool, retentionDays: number, live: LiveRooms = nothingLive) {
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  const params = { sessions: [], rooms: [cutoff, live.roomIds()], users: [cutoff, live.userIds()] };
  const counts: Record<string, number> = {};
  for (const [name, sql] of Object.entries(statements)) {
    counts[name] = (await pool.query(sql, params[name as keyof typeof statements])).rowCount ?? 0;
  }
  return counts as Record<keyof typeof statements, number>;
}

export function startCleanup(pool: Pool, retentionDays: number, log: FastifyBaseLogger, live: LiveRooms = nothingLive) {
  const run = () =>
    runCleanup(pool, retentionDays, live).then(
      (deleted) => log.info({ deleted }, "cleanup done"),
      (err) => log.error({ err }, "cleanup failed"),
    );
  void run();
  const timer = setInterval(run, DAY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
