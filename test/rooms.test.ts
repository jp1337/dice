// Rooms, lobby and the room WebSocket (spec 4.2, 4.9, 4.10, 7, 13) against a real PostgreSQL and a listening server.
import { randomBytes, randomInt } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo, Socket as NetSocket } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, sessionIdFor } from "../src/server/auth.js";
import { parseConfig } from "../src/server/config.js";
import { runMigrations } from "../src/server/db/migrate.js";
import { MAX_STRIKES, type Member, type Room, roomView } from "../src/server/rooms.js";
import { type GameEvent, MAX_CLIENT_MESSAGE_BYTES, NICKNAME_MAX, type RoomView, type ServerMessage, defaultSettings } from "../src/shared/contracts.js";
import { initialGameState } from "../src/shared/game/reduce.js";
import { baseEnv, makeApp } from "./helpers.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const ORIGIN = "https://dice.example.org";
const HOST_ID = "100000000000000002";
const HOST2_ID = "100000000000000003";
const env = { HOST_DISCORD_IDS: `${HOST_ID},${HOST2_ID}` };

type App = Awaited<ReturnType<typeof makeApp>>["app"];
type User = { id: string; discordId: string; token: string; name: string };

let ip = 0;
const nextIp = () => `10.2.${(++ip >> 8) & 255}.${ip & 255}`;
const newDiscordId = () => `1${String(randomInt(2 ** 47)).padStart(17, "0")}`;

class Client {
  messages: ServerMessage[] = [];
  closed: Promise<number>;
  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => this.messages.push(JSON.parse(String(e.data))));
    this.closed = new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
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

describe("guest view (spec 4.8)", () => {
  it("shows only players and placed people, no avatars, Discord names or moderation", () => {
    const config = parseConfig({ ...baseEnv, ...env });
    const member = (userId: string, participation: "player" | "spectator", discordId: string | null): Member => ({
      userId,
      discordId,
      username: `user-${userId}`,
      displayName: `Name ${userId}`,
      nickname: null,
      avatarHash: "a".repeat(32),
      isSimulated: false,
      participation,
      isCohost: false,
    });
    const history: GameEvent[] = [
      { seq: 1, type: "participation_changed", actorUserId: "h", payload: { userId: "s", participation: "spectator" }, createdAt: "2026-12-01T18:00:00.000Z" },
    ];
    const room: Room = {
      id: "r",
      slug: "secret-slug",
      name: "Feier",
      isTest: false,
      settings: defaultSettings,
      watchToken: "w",
      members: new Map([
        ["h", member("h", "spectator", HOST_ID)],
        ["p", member("p", "player", newDiscordId())],
        ["s", member("s", "spectator", newDiscordId())],
      ]),
      sockets: new Map(),
      events: history,
      game: { ...initialGameState(), history },
      queue: Promise.resolve(),
    };
    const view = roomView(room, null, config);
    expect(view.viewer).toEqual({ kind: "guest" });
    expect(view.room.slug).toBe("");
    expect(view.room).not.toHaveProperty("watchUrl");
    expect(view.members.map((m) => m.userId)).toEqual(["p"]);
    expect(view.members[0]).toMatchObject({ avatarUrl: null, displayName: "Name p" });
    expect(view.members[0]).not.toHaveProperty("discordName");
    expect(view.game.history).toEqual([]);
    const host = roomView(room, room.members.get("h")!, config);
    expect(host.room.watchUrl).toBe(`${ORIGIN}/z/w`);
    expect(host.members).toHaveLength(3);
    expect(host.game.history).toHaveLength(1);
  });
});

describe.skipIf(!dbUrl)("rooms with PostgreSQL", () => {
  let pool: pg.Pool;
  let app: App;
  let logs: Record<string, unknown>[];
  let port: number;
  const clients: Client[] = [];

  async function makeUser(discordId = newDiscordId(), name = "Erika"): Promise<User> {
    const { rows } = await pool.query(
      `insert into users (discord_id, username, display_name, avatar_hash) values ($1, $2, $3, $4)
       on conflict (discord_id) do update set nickname = null returning id`,
      [discordId, `${name.toLowerCase()}-${discordId.slice(-4)}`, name, "b".repeat(32)],
    );
    const token = randomBytes(32).toString("base64url");
    await pool.query("insert into sessions (id, user_id, expires_at) values ($1, $2, now() + interval '1 day')", [
      sessionIdFor(baseEnv.SESSION_SECRET, token),
      rows[0].id,
    ]);
    return { id: rows[0].id, discordId, token, name };
  }

  const cookies = (user: User) => ({ [SESSION_COOKIE]: user.token });

  async function createRoom(user: User, body: unknown = { name: "Jahresabschluss", isTest: false }, target: App = app) {
    return target.inject({ method: "POST", url: "/api/rooms", cookies: cookies(user), headers: { origin: ORIGIN }, payload: body as object, remoteAddress: nextIp() });
  }

  async function newRoom(host: User, target: App = app) {
    const res = await createRoom(host, undefined, target);
    expect(res.statusCode).toBe(201);
    return res.json().slug as string;
  }

  async function connect(slug: string, user: User, targetPort = port) {
    // Node's WebSocket client takes extra headers; the DOM type does not know them.
    const init = { headers: { cookie: `${SESSION_COOKIE}=${user.token}`, origin: ORIGIN } };
    const client = new Client(new WebSocket(`ws://127.0.0.1:${targetPort}/ws/rooms/${slug}`, init as unknown as string[]));
    clients.push(client);
    await vi.waitFor(() => client.state);
    return client;
  }

  // The status of an upgrade request that is refused before the upgrade (101 if it was accepted).
  function upgrade(path: string, headers: Record<string, string>) {
    return new Promise<{ status: number; socket?: NetSocket }>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        path,
        headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), ...headers },
      });
      req.on("response", (res) => {
        res.resume();
        resolve({ status: res.statusCode! });
      });
      req.on("upgrade", (_res, socket) => resolve({ status: 101, socket }));
      req.on("error", reject);
      req.end();
    });
  }

  const eventsOf = async (slug: string) =>
    (await pool.query("select e.seq, e.type, e.payload from game_events e join rooms r on r.id = e.room_id where r.slug = $1 order by e.seq", [slug])).rows;

  let host: User;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: dbUrl });
    await runMigrations(pool);
    ({ app, logs } = await makeApp(env, dbUrl, { pingIntervalMs: 200 }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
    host = await makeUser(HOST_ID, "Henrike");
  });
  afterAll(async () => {
    for (const c of clients) c.ws.close();
    await app.close();
    await pool.end();
  });

  describe("HTTP", () => {
    it("lets only hosts create rooms, with an unguessable slug, the creator as spectator", async () => {
      const user = await makeUser();
      expect((await createRoom(user)).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/rooms", headers: { origin: ORIGIN }, payload: {} })).statusCode).toBe(401);
      const crossSite = await app.inject({ method: "POST", url: "/api/rooms", cookies: cookies(host), headers: { origin: "https://evil.example" }, payload: { name: "x", isTest: false } });
      expect(crossSite.statusCode).toBe(403);
      for (const body of [{ name: "", isTest: false }, { name: "x" }, { name: "x".repeat(61), isTest: false }, { name: "x", isTest: false, extra: 1 }]) {
        expect((await createRoom(host, body)).statusCode).toBe(400);
      }

      const res = await createRoom(host, { name: "  Probe  ", isTest: true });
      expect(res.statusCode).toBe(201);
      expect(res.headers["cache-control"]).toBe("no-store");
      const { slug } = res.json();
      expect(slug).toMatch(/^[\w-]{22}$/); // 128 bit
      expect(await newRoom(host)).not.toBe(slug);
      const { rows } = await pool.query(
        "select r.name, r.is_test, r.settings, m.user_id, m.participation, m.is_cohost from rooms r join room_members m on m.room_id = r.id where r.slug = $1",
        [slug],
      );
      expect(rows).toEqual([{ name: "Probe", is_test: true, settings: defaultSettings, user_id: host.id, participation: "spectator", is_cohost: false }]);

      const summary = await app.inject({ url: `/api/rooms/${slug}`, cookies: cookies(user) });
      expect(summary.json()).toEqual({ slug, name: "Probe", isTest: true, status: "lobby" });
      expect((await app.inject({ url: `/api/rooms/${slug}` })).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/rooms/unknown", cookies: cookies(user) })).statusCode).toBe(404);
    });

    it("limits room creation per IP", async () => {
      const { app: limited } = await makeApp(env, dbUrl);
      try {
        const create = () => limited.inject({ method: "POST", url: "/api/rooms", cookies: cookies(host), headers: { origin: ORIGIN }, payload: { name: "x", isTest: false }, remoteAddress: "192.0.2.7" });
        for (let i = 0; i < 10; i++) expect((await create()).statusCode).toBe(201);
        expect((await create()).statusCode).toBe(429);
      } finally {
        await limited.close();
      }
    });

    it("serves the app shell for /r/:slug without a session and without room data", async () => {
      const slug = await newRoom(host);
      for (const target of [slug, "does-not-exist"]) {
        const res = await app.inject({ url: `/r/${target}` });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toMatch(/text\/html/);
        expect(res.body).toBe("<!doctype html><title>Würfel</title>");
        expect(res.headers["x-robots-tag"]).toBeDefined();
      }
    });

    it("validates and resets nicknames (spec 4.10)", async () => {
      const user = await makeUser(undefined, "Max");
      const patch = (nickname: unknown, origin = ORIGIN) =>
        app.inject({ method: "PATCH", url: "/api/me", cookies: cookies(user), headers: { origin }, payload: { nickname } });
      for (const bad of ["", "   ", "x".repeat(NICKNAME_MAX + 1), "a\u0000b", "a\nb", "‮evil", "a​b", 5]) {
        expect((await patch(bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect((await patch("Kapitän", "https://evil.example")).statusCode).toBe(403);
      expect((await app.inject({ method: "PATCH", url: "/api/me", headers: { origin: ORIGIN }, payload: { nickname: "x" } })).statusCode).toBe(401);
      const me = async () => (await app.inject({ url: "/api/me", cookies: cookies(user) })).json().displayName;
      expect((await patch(`  ${"k".repeat(NICKNAME_MAX)}  `)).statusCode).toBe(204);
      expect(await me()).toBe("k".repeat(NICKNAME_MAX));
      expect((await patch("Kapitän 🎉")).statusCode).toBe(204);
      expect(await me()).toBe("Kapitän 🎉");
      expect((await patch(null)).statusCode).toBe(204);
      expect(await me()).toBe("Max");
    });
  });

  describe("WebSocket access", () => {
    it("refuses the upgrade without a session, with a foreign Origin and for an unknown room", async () => {
      const slug = await newRoom(host);
      const user = await makeUser();
      const cookie = `${SESSION_COOKIE}=${user.token}`;
      expect((await upgrade(`/ws/rooms/${slug}`, { origin: ORIGIN })).status).toBe(401);
      expect((await upgrade(`/ws/rooms/${slug}`, { origin: ORIGIN, cookie: `${SESSION_COOKIE}=forged` })).status).toBe(401);
      expect((await upgrade(`/ws/rooms/${slug}`, { cookie, origin: "https://evil.example" })).status).toBe(403);
      expect((await upgrade(`/ws/rooms/${slug}`, { cookie })).status).toBe(403);
      expect((await upgrade("/ws/rooms/unknown", { cookie, origin: ORIGIN })).status).toBe(404);
      const { rows } = await pool.query("select 1 from room_members where user_id = $1", [user.id]);
      expect(rows).toEqual([]);
    });
  });

  describe("lobby", () => {
    it("sends the same state to three clients; joiners are players, the creator a spectator", async () => {
      const slug = await newRoom(host);
      const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
      const ca = await connect(slug, a);
      const cb = await connect(slug, b);
      const cc = await connect(slug, c);
      for (const client of [ca, cb, cc]) await vi.waitFor(() => expect(client.state.members.filter((m) => m.connected)).toHaveLength(3));
      const strip = (view: RoomView) => ({ ...view, viewer: null });
      expect(strip(ca.state)).toEqual(strip(cb.state));
      expect(strip(cb.state)).toEqual(strip(cc.state));
      expect(ca.state.members.map((m) => [m.userId, m.participation, m.connected])).toEqual([
        [host.id, "spectator", false],
        [a.id, "player", true],
        [b.id, "player", true],
        [c.id, "player", true],
      ]);
      expect(cb.state.viewer).toEqual({ kind: "member", userId: b.id, isHost: false, canModerate: false });
      expect(cb.state.room).toMatchObject({ slug, name: "Jahresabschluss", status: "lobby", watchLinkActive: false });
      expect(cb.member(a.id)).toMatchObject({ displayName: "Erika", avatarUrl: `/avatars/${a.id}/${"b".repeat(32)}`, isHost: false });
      expect(cb.member(host.id)?.isHost).toBe(true);
      const { rows } = await pool.query("select count(*)::int as n from room_members m join rooms r on r.id = m.room_id where r.slug = $1", [slug]);
      expect(rows[0].n).toBe(4);
    });

    it("tracks presence across two tabs", async () => {
      const slug = await newRoom(host);
      const watcher = await connect(slug, await makeUser());
      const user = await makeUser();
      const tab1 = await connect(slug, user);
      const tab2 = await connect(slug, user);
      await vi.waitFor(() => expect(watcher.member(user.id)?.connected).toBe(true));
      await tab1.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(watcher.member(user.id)?.connected).toBe(true);
      expect(tab2.member(user.id)?.connected).toBe(true);
      await tab2.close();
      await vi.waitFor(() => expect(watcher.member(user.id)?.connected).toBe(false));
      expect(watcher.state.members.filter((m) => m.userId === user.id)).toHaveLength(1);
    });

    it("keeps participation and co-host across a reconnect (spec 4.9)", async () => {
      const slug = await newRoom(host);
      const ch = await connect(slug, host);
      const user = await makeUser();
      let cu = await connect(slug, user);
      ch.send({ type: "set_cohost", userId: user.id, isCohost: true });
      cu.send({ type: "set_participation", userId: user.id, participation: "spectator" });
      await vi.waitFor(() => expect(cu.member(user.id)).toMatchObject({ isCohost: true, participation: "spectator" }));
      await cu.close();
      await vi.waitFor(() => expect(ch.member(user.id)?.connected).toBe(false));
      cu = await connect(slug, user);
      expect(cu.member(user.id)).toMatchObject({ isCohost: true, participation: "spectator", connected: true });
      expect(cu.state.viewer).toEqual({ kind: "member", userId: user.id, isHost: false, canModerate: true });
    });

    // reduce is a stub until step 4 and throws on game_started, so a running room cannot be loaded yet.
    it.todo("makes a latecomer to a running game a spectator, and refuses set_participation outside the lobby");

    it("lets everyone switch only themselves; hosts and co-hosts switch anyone", async () => {
      const slug = await newRoom(host);
      const ch = await connect(slug, host);
      const [u1, u2] = [await makeUser(), await makeUser()];
      const c1 = await connect(slug, u1);
      const c2 = await connect(slug, u2);

      c1.send({ type: "set_participation", userId: u1.id, participation: "spectator" });
      await vi.waitFor(() => expect(c2.member(u1.id)?.participation).toBe("spectator"));
      c1.send({ type: "set_participation", userId: u2.id, participation: "spectator" });
      await vi.waitFor(() => expect(c1.errors).toEqual(["forbidden"]));
      expect(c2.member(u2.id)?.participation).toBe("player");

      ch.send({ type: "set_participation", userId: u2.id, participation: "spectator" });
      await vi.waitFor(() => expect(c2.member(u2.id)?.participation).toBe("spectator"));
      ch.send({ type: "set_participation", userId: crypto.randomUUID(), participation: "player" });
      await vi.waitFor(() => expect(ch.errors).toEqual(["unknown_member"]));

      expect(await eventsOf(slug)).toEqual([
        { seq: 1, type: "participation_changed", payload: { userId: u1.id, participation: "spectator" } },
        { seq: 2, type: "participation_changed", payload: { userId: u2.id, participation: "spectator" } },
      ]);
      const { rows } = await pool.query("select user_id, participation from room_members where user_id = any($1)", [[u1.id, u2.id]]);
      expect(rows.every((r) => r.participation === "spectator")).toBe(true);
    });

    it("gives co-hosts the host tools except appointing co-hosts", async () => {
      const slug = await newRoom(host);
      const ch = await connect(slug, host);
      const [co, other] = [await makeUser(), await makeUser()];
      const cco = await connect(slug, co);
      const cother = await connect(slug, other);

      for (const message of [
        { type: "update_settings", settings: { reactions: false } },
        { type: "set_cohost", userId: other.id, isCohost: true },
        { type: "reset_nickname", userId: co.id },
      ]) {
        cother.send(message);
      }
      await vi.waitFor(() => expect(cother.errors).toEqual(["forbidden", "forbidden", "forbidden"]));

      ch.send({ type: "set_cohost", userId: co.id, isCohost: true });
      await vi.waitFor(() => expect(cco.state.viewer).toMatchObject({ canModerate: true, isHost: false }));
      cco.send({ type: "set_cohost", userId: other.id, isCohost: true });
      await vi.waitFor(() => expect(cco.errors).toEqual(["forbidden"]));
      ch.send({ type: "set_cohost", userId: host.id, isCohost: true });
      await vi.waitFor(() => expect(ch.errors).toEqual(["invalid_target"]));

      cco.send({ type: "update_settings", settings: { reactions: false, sixMessage: "  {name} hat Platz {platz}!  " } });
      await vi.waitFor(() => expect(cother.state.room.settings).toEqual({ ...defaultSettings, reactions: false, sixMessage: "{name} hat Platz {platz}!" }));
      cco.send({ type: "set_participation", userId: other.id, participation: "spectator" });
      await vi.waitFor(() => expect(cother.member(other.id)?.participation).toBe("spectator"));
      cco.send({ type: "update_settings", settings: { sixMessage: "" } });
      await vi.waitFor(() => expect(cco.errors).toEqual(["forbidden", "invalid_message"]));

      const { rows } = await pool.query("select settings from rooms where slug = $1", [slug]);
      expect(rows[0].settings.reactions).toBe(false);
      expect(rows[0].settings.bonusChains).toBe(true);
    });

    it("sends moderation history to hosts and co-hosts only, and Discord names to hosts only", async () => {
      const slug = await newRoom(host);
      const ch = await connect(slug, host);
      const [co, plain] = [await makeUser(), await makeUser()];
      const cco = await connect(slug, co);
      const cplain = await connect(slug, plain);
      ch.send({ type: "set_cohost", userId: co.id, isCohost: true });
      cplain.send({ type: "set_participation", userId: plain.id, participation: "spectator" });
      await vi.waitFor(() => expect(cplain.member(plain.id)?.participation).toBe("spectator"));
      await vi.waitFor(() => expect(cco.state.game.history.map((e) => e.type)).toEqual(["cohost_changed", "participation_changed"]));
      expect(ch.state.game.history).toEqual(cco.state.game.history);
      for (const message of cplain.messages) if (message.type === "state") expect(message.state.game.history).toEqual([]);

      expect(ch.member(plain.id)?.discordName).toBe(`erika-${plain.discordId.slice(-4)}`);
      for (const client of [cco, cplain]) expect(client.state.members.every((m) => !("discordName" in m))).toBe(true);
    });

    it("resets a nickname everywhere and shows changed nicknames live", async () => {
      const slug = await newRoom(host);
      const otherSlug = await newRoom(host);
      const ch = await connect(slug, host);
      const user = await makeUser(undefined, "Max");
      const cu = await connect(slug, user);
      const elsewhere = await connect(otherSlug, user);
      const patched = await app.inject({ method: "PATCH", url: "/api/me", cookies: cookies(user), headers: { origin: ORIGIN }, payload: { nickname: "Kapitän" } });
      expect(patched.statusCode).toBe(204);
      await vi.waitFor(() => expect(ch.member(user.id)?.displayName).toBe("Kapitän"));
      await vi.waitFor(() => expect(elsewhere.member(user.id)?.displayName).toBe("Kapitän"));

      ch.send({ type: "reset_nickname", userId: user.id });
      await vi.waitFor(() => expect(cu.member(user.id)?.displayName).toBe("Max"));
      await vi.waitFor(() => expect(elsewhere.member(user.id)?.displayName).toBe("Max"));
      expect((await pool.query("select nickname from users where id = $1", [user.id])).rows[0].nickname).toBeNull();
      expect(ch.state.game.history.map((e) => e.type)).toEqual(["nickname_reset"]);
      expect(cu.state.game.history).toEqual([]);
    });

    it("answers game commands with not_implemented until step 4", async () => {
      const slug = await newRoom(host);
      const ch = await connect(slug, host);
      ch.send({ type: "start" });
      await vi.waitFor(() => expect(ch.messages.at(-1)).toEqual({ type: "error", code: "not_implemented", message: "Diese Aktion gibt es noch nicht." }));
    });
  });

  describe("robustness", () => {
    it("rejects invalid messages without closing, and closes on oversized ones", async () => {
      const slug = await newRoom(host);
      const watcher = await connect(slug, await makeUser());
      const user = await makeUser();
      const client = await connect(slug, user);
      for (const bad of ["not json", "null", "{}", '{"type":"nope"}', '{"type":"set_participation"}', JSON.stringify({ type: "set_participation", userId: user.id, participation: "host" })]) {
        client.send(bad);
      }
      client.ws.send(new Uint8Array([1, 2, 3]));
      await vi.waitFor(() => expect(client.errors).toHaveLength(7));
      expect(new Set(client.errors)).toEqual(new Set(["invalid_message"]));
      const error = client.messages.at(-1);
      expect(error).toMatchObject({ type: "error", message: "Diese Nachricht versteht der Server nicht." });

      client.send({ type: "set_participation", userId: user.id, participation: "spectator", padding: "x".repeat(MAX_CLIENT_MESSAGE_BYTES) });
      expect(await client.closed).toBe(1009);
      await vi.waitFor(() => expect(watcher.member(user.id)?.connected).toBe(false));
      expect(watcher.member(user.id)?.participation).toBe("player");
      expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
    });

    it("rate-limits messages per connection and closes on repeated violations", async () => {
      const slug = await newRoom(host);
      const client = await connect(slug, await makeUser());
      for (let i = 0; i < 25; i++) client.send("{}");
      await vi.waitFor(() => expect(client.errors).toHaveLength(25));
      expect(client.errors.filter((e) => e === "rate_limited")).toHaveLength(5);
      expect(client.errors.filter((e) => e === "invalid_message")).toHaveLength(20);
      for (let i = 0; i < MAX_STRIKES + 5; i++) client.send("{}");
      expect(await client.closed).toBe(1008);
      await vi.waitFor(() => expect(logs.some((l) => l.msg === "ws closed" && l.reason === "rate limit")).toBe(true));
    });

    it("serializes concurrent messages: 50 changes, seq without gaps", async () => {
      const slug = await newRoom(host);
      const users = await Promise.all(Array.from({ length: 5 }, () => makeUser()));
      const cs = await Promise.all(users.map((u) => connect(slug, u)));
      cs.forEach((c, i) => {
        for (let n = 0; n < 10; n++) c.send({ type: "set_participation", userId: users[i]!.id, participation: n % 2 === 0 ? "spectator" : "player" });
      });
      await vi.waitFor(async () => expect(await eventsOf(slug)).toHaveLength(50), { timeout: 5000 });
      const events = await eventsOf(slug);
      expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      await vi.waitFor(() => expect(cs[0]!.state.members.filter((m) => m.participation === "player")).toHaveLength(5));
      for (const c of cs) expect(c.errors).toEqual([]);
    });

    it("cuts off a socket that does not answer pings", async () => {
      const slug = await newRoom(host);
      const watcher = await connect(slug, await makeUser());
      const user = await makeUser();
      // A raw upgrade: nothing answers the server's pings.
      const { status, socket } = await upgrade(`/ws/rooms/${slug}`, { cookie: `${SESSION_COOKIE}=${user.token}`, origin: ORIGIN });
      expect(status).toBe(101);
      socket!.resume(); // read the pings, so the server's close is noticed
      await vi.waitFor(() => expect(watcher.member(user.id)?.connected).toBe(true));
      await new Promise((resolve) => socket!.on("close", resolve));
      await vi.waitFor(() => expect(watcher.member(user.id)?.connected).toBe(false));
      expect(watcher.ws.readyState).toBe(WebSocket.OPEN); // Node's client answers pings
      expect(logs.some((l) => l.msg === "ws closed" && l.reason === "ping timeout" && l.userId === user.id)).toBe(true);
    });

    it("logs connects and closes with user ids, never names or payloads", async () => {
      const slug = await newRoom(host);
      const user = await makeUser(undefined, "Geheimname");
      logs.length = 0;
      const client = await connect(slug, user);
      client.send({ type: "set_participation", userId: user.id, participation: "spectator" });
      await vi.waitFor(() => expect(client.member(user.id)?.participation).toBe("spectator"));
      await client.close();
      await vi.waitFor(() => expect(logs.some((l) => l.msg === "ws closed")).toBe(true));
      expect(logs.find((l) => l.msg === "ws connected")).toMatchObject({ userId: user.id });
      const text = JSON.stringify(logs);
      for (const value of ["Geheimname", user.discordId, user.token, "set_participation", slug]) expect(text).not.toContain(value);
    });
  });

  it("rebuilds the same state after a restart", async () => {
    const first = await makeApp(env, dbUrl);
    await first.app.listen({ port: 0, host: "127.0.0.1" });
    const firstPort = (first.app.server.address() as AddressInfo).port;
    const slug = await newRoom(host, first.app);
    const [co, user] = [await makeUser(), await makeUser()];
    const ch = await connect(slug, host, firstPort);
    const cco = await connect(slug, co, firstPort);
    const cu = await connect(slug, user, firstPort);
    ch.send({ type: "set_cohost", userId: co.id, isCohost: true });
    cu.send({ type: "set_participation", userId: user.id, participation: "spectator" });
    cco.send({ type: "update_settings", settings: { bonusChains: false } });
    await vi.waitFor(() => expect(ch.state.room.settings.bonusChains).toBe(false));
    await vi.waitFor(() => expect(ch.state.game.history).toHaveLength(2));
    await cco.close();
    await cu.close();
    await vi.waitFor(() => expect(ch.state.members.filter((m) => m.connected)).toHaveLength(1));
    const before = ch.state;
    await ch.close();
    await first.app.close();

    const again = await connect(slug, host); // the shared app has never loaded this room
    expect(again.state).toEqual(before);
  });
});
