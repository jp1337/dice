// Daily deletion of old data (spec 9.3). Runs at startup and then every 24 hours; logs only counts.
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

const DAY_MS = 86_400_000;

// What the rooms module has in use right now: never deleted, however old (rooms with connections and
// the people connected).
export type LiveRooms = { roomIds(): string[]; userIds(): string[] };
const nothingLive: LiveRooms = { roomIds: () => [], userIds: () => [] };

// In this order: deleting a room first frees its members for the user rules. $1 = retention cutoff,
// $2 = ids in use.
const statements = {
  sessions: "delete from sessions where expires_at <= now()",
  rooms: "delete from rooms where last_activity_at < $1 and id <> all($2::uuid[])", // members and events cascade
  // A simulated player belongs to exactly one test room and is created with its membership in one
  // transaction, so one without a room is one whose room is gone (spec 9.3).
  simulated: "delete from users u where u.is_simulated and not exists (select 1 from room_members m where m.user_id = u.id)",
  // Not while a session is valid: with RETENTION_DAYS under the 7-day session, people were logged out mid-week.
  users: `delete from users u where not u.is_simulated and u.last_login_at < $1 and u.id <> all($2::uuid[])
    and not exists (select 1 from room_members m where m.user_id = u.id)
    and not exists (select 1 from sessions s where s.user_id = u.id and s.expires_at > now())`, // sessions cascade
};

export async function runCleanup(pool: Pool, retentionDays: number, live: LiveRooms = nothingLive) {
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  const params = { sessions: [], rooms: [cutoff, live.roomIds()], simulated: [], users: [cutoff, live.userIds()] };
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
