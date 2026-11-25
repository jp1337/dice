// A WebSocket test client and the users behind it, shared by rooms.test.ts and game.test.ts.
import { randomBytes, randomInt } from "node:crypto";
import type pg from "pg";
import { vi } from "vitest";
import { SESSION_COOKIE, sessionIdFor } from "../src/server/auth.js";
import type { RoomView, ServerMessage } from "../src/shared/contracts.js";
import { baseEnv } from "./helpers.js";

export const ORIGIN = "https://dice.example.org";
export const HOST_ID = "100000000000000002";
export const HOST2_ID = "100000000000000003";
export const env = { HOST_DISCORD_IDS: `${HOST_ID},${HOST2_ID}` };

export type User = { id: string; discordId: string; token: string; name: string };

// Presence updates are throttled (PRESENCE_DELAY_MS), so waits are longer than Vitest's default second.
export const until = <T>(check: () => T | Promise<T>, timeout = 4000) => vi.waitFor(check, { timeout, interval: 20 });
export const newDiscordId = () => `1${String(randomInt(2 ** 47)).padStart(17, "0")}`;

export async function makeUser(pool: pg.Pool, discordId = newDiscordId(), name = "Erika", sessionLifetime = "1 day"): Promise<User> {
  const { rows } = await pool.query(
    `insert into users (discord_id, username, display_name, avatar_hash) values ($1, $2, $3, $4)
     on conflict (discord_id) do update set nickname = null returning id`,
    [discordId, `${name.toLowerCase()}-${discordId.slice(-4)}`, name, "b".repeat(32)],
  );
  const token = randomBytes(32).toString("base64url");
  await pool.query("insert into sessions (id, user_id, expires_at) values ($1, $2, now() + $3::interval)", [
    sessionIdFor(baseEnv.SESSION_SECRET, token),
    rows[0].id,
    sessionLifetime,
  ]);
  return { id: rows[0].id, discordId, token, name };
}

export class Client {
  messages: ServerMessage[] = [];
  bytes = 0;
  closed: Promise<{ code: number; reason: string }>;
  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      this.bytes += String(e.data).length;
      this.messages.push(JSON.parse(String(e.data)));
    });
    this.closed = new Promise((resolve) => ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason })));
  }
  // user: a member's socket; without, a guest's.
  static open(port: number, path: string, user?: User, headers: Record<string, string> = {}) {
    // Node's WebSocket client takes extra headers; the DOM type does not know them.
    const init = { headers: { origin: ORIGIN, ...(user && { cookie: `${SESSION_COOKIE}=${user.token}` }), ...headers } };
    return new Client(new WebSocket(`ws://127.0.0.1:${port}${path}`, init as unknown as string[]));
  }
  get state(): RoomView {
    const last = this.messages.findLast((m) => m.type === "state");
    if (!last) throw new Error("no state yet");
    return last.state;
  }
  get errors() {
    return this.messages.flatMap((m) => (m.type === "error" ? [m.code] : []));
  }
  member(userId: string) {
    return this.state.members.find((m) => m.userId === userId);
  }
  send(message: unknown) {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }
  async close() {
    this.ws.close();
    await this.closed;
  }
}
