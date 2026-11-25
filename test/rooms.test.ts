// Rooms, lobby and the room WebSocket (spec 4.2, 4.9, 4.10, 7, 13) against a real PostgreSQL and a listening server.
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo, Socket as NetSocket } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_GRACE_MS } from "../src/server/app.js";
import { SESSION_COOKIE } from "../src/server/auth.js";
import { parseConfig } from "../src/server/config.js";
import { runMigrations } from "../src/server/db/migrate.js";
import { runCleanup } from "../src/server/cleanup.js";
import { CommandError } from "../src/server/game-commands.js";
import { MAX_SOCKETS_PER_USER, MAX_STRIKES, MESSAGE_BURST, type Member, NICKNAME_LIMIT_PER_MINUTE, checkSettingsChange, roomView } from "../src/server/rooms.js";
import { type GameEvent, MAX_CLIENT_MESSAGE_BYTES, NICKNAME_MAX, type RoomView, defaultSettings } from "../src/shared/contracts.js";
import { initialGameState } from "../src/shared/game/reduce.js";
import { baseEnv, makeApp, ownDatabase } from "./helpers.js";
import { Client, HOST_ID, ORIGIN, type User, env, makeUser as makeUserIn, newDiscordId, until } from "./ws.js";

const dbUrl = await ownDatabase();

type App = Awaited<ReturnType<typeof makeApp>>["app"];

let ip = 0;
const nextIp = () => `10.2.${(++ip >> 8) & 255}.${ip & 255}`;

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
    const room: Parameters<typeof roomView>[0] = {
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
      guests: new Set([{}, {}] as never[]),
      events: history,
      game: { ...initialGameState(), history },
    };
    const view = roomView(room, "guest", config);
    expect(view.room.slug).toBe("");
    expect(view.room).not.toHaveProperty("watchUrl");
    expect(view.members.map((m) => m.userId)).toEqual(["p"]);
    expect(view.members[0]).toMatchObject({ avatarUrl: null, displayName: "Name p" });
    expect(view.members[0]).not.toHaveProperty("discordName");
    expect(view.game.history).toEqual([]);
    expect(view.room).not.toHaveProperty("guestCount");
    const host = roomView(room, "host", config);
    expect(host.room.watchUrl).toBe(`${ORIGIN}/z/w`);
    expect(host.members).toHaveLength(3);
    expect(host.game.history).toHaveLength(1);
    expect(host.room.guestCount).toBe(2);
  });
});

describe("settings during a game (spec 4.6, 4.11)", () => {
  it("allows only switching reactions outside the lobby", () => {
    expect(() => checkSettingsChange("running", { reactions: false })).not.toThrow();
    expect(() => checkSettingsChange("finished", { reactions: true })).not.toThrow();
    expect(() => checkSettingsChange("running", { reactions: false, bonusChains: false })).toThrow(CommandError);
    expect(() => checkSettingsChange("running", { sixMessage: "x" })).toThrow(CommandError);
    expect(() => checkSettingsChange("lobby", { sixMessage: "x", bonusChains: false, lastPlayer: "auto" })).not.toThrow();
  });
});

describe.skipIf(!dbUrl)("rooms with PostgreSQL", () => {
  let pool: pg.Pool;
  let app: App;
  let logs: Record<string, unknown>[];
  let port: number;
  const clients: Client[] = [];

  const makeUser = (discordId?: string, name?: string, sessionLifetime?: string) => makeUserIn(pool, discordId, name, sessionLifetime);

  const cookies = (user: User) => ({ [SESSION_COOKIE]: user.token });

  async function createRoom(user: User, body: unknown = { name: "Jahresabschluss", isTest: false }, target: App = app) {
    return target.inject({ method: "POST", url: "/api/rooms", cookies: cookies(user), headers: { origin: ORIGIN }, payload: body as object, remoteAddress: nextIp() });
  }

  async function newRoom(host: User, target: App = app) {
    const res = await createRoom(host, undefined, target);
    expect(res.statusCode).toBe(201);
    return res.json().slug as string;
  }

  function open(slug: string, user: User, targetPort = port) {
    const client = Client.open(targetPort, `/ws/rooms/${slug}`, user);
    clients.push(client);
    return client;
  }

  async function connect(slug: string, user: User, targetPort = port) {
    const client = open(slug, user, targetPort);
    await until(() => client.state);
    return client;
  }

  const roomIdOf = async (slug: string) => (await pool.query("select id from rooms where slug = $1", [slug])).rows[0]?.id as string | undefined;

  // The status of an upgrade request that is refused before the upgrade (101 if it was accepted).
  function upgrade(path: string, headers: Record<string, string>, targetPort = port) {
    return new Promise<{ status: number; socket?: NetSocket }>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: targetPort,
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
      const shell = (await app.inject({ url: "/" })).body;
      const slugs = [await newRoom(host), await newRoom(host), randomBytes(16).toString("base64url")]; // the last one does not exist
      for (const slug of slugs) {
        expect(slug).toMatch(/^[A-Za-z0-9_-]{16,64}$/); // what SPA_ROUTES accepts
        const res = await app.inject({ url: `/r/${slug}` });
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(shell);
        expect(res.body).not.toContain("Jahresabschluss");
      }
    });

    it("validates and resets nicknames (spec 4.10)", async () => {
      const user = await makeUser(undefined, "Max");
      const patch = (nickname: unknown, origin = ORIGIN) =>
        app.inject({ method: "PATCH", url: "/api/me", cookies: cookies(user), headers: { origin }, payload: { nickname }, remoteAddress: nextIp() });
      for (const bad of ["", "   ", "x".repeat(NICKNAME_MAX + 1), "a\u0000b", "a\nb", "\u202Eevil", "a\u200Bb", "\u3164", 5]) {
        expect((await patch(bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect((await patch("Kapitän", "https://evil.example")).statusCode).toBe(403);
      expect((await app.inject({ method: "PATCH", url: "/api/me", headers: { origin: ORIGIN }, payload: { nickname: "x" } })).statusCode).toBe(401);
      const me = async () => (await app.inject({ url: "/api/me", cookies: cookies(user) })).json().displayName;
      const own = async () => (await app.inject({ url: "/api/me", cookies: cookies(user) })).json().nickname;
      expect(await own()).toBeNull();
      expect((await patch(`  ${"k".repeat(NICKNAME_MAX)}  `)).statusCode).toBe(204);
      expect(await me()).toBe("k".repeat(NICKNAME_MAX));
      expect((await patch("Kapitän 🎉")).statusCode).toBe(204);
      expect(await me()).toBe("Kapitän 🎉");
      expect(await own()).toBe("Kapitän 🎉");
      expect((await patch(null)).statusCode).toBe(204);
      expect(await me()).toBe("Max");
      expect(await own()).toBeNull();
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
      for (const client of [ca, cb, cc]) await until(() => expect(client.state.members.filter((m) => m.connected)).toHaveLength(3));
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
      await until(() => expect(watcher.member(user.id)?.connected).toBe(true));
      await tab1.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(watcher.member(user.id)?.connected).toBe(true);
      expect(tab2.member(user.id)?.connected).toBe(true);
      await tab2.close();
      await until(() => expect(watcher.member(user.id)?.connected).toBe(false));
      expect(watcher.state.members.filter((m) => m.userId === user.id)).toHaveLength(1);
    });

    it("keeps participation and co-host across a reconnect (spec 4.9)", async () => {
      const slug = await newRoom(host);
      const ch = await connect(slug, host);
      const user = await makeUser();
      let cu = await connect(slug, user);
      ch.send({ type: "set_cohost", userId: user.id, isCohost: true });
      cu.send({ type: "set_participation", userId: user.id, participation: "spectator" });
      await until(() => expect(cu.member(user.id)).toMatchObject({ isCohost: true, participation: "spectator" }));
      await cu.close();
      await until(() => expect(ch.member(user.id)?.connected).toBe(false));
      cu = await connect(slug, user);
      expect(cu.member(user.id)).toMatchObject({ isCohost: true, participation: "spectator", connected: true });
      expect(cu.state.viewer).toEqual({ kind: "member", userId: user.id, isHost: false, canModerate: true });
    });

    it("makes a latecomer to a running game a spectator and allows only reactions to change outside the lobby", async () => {
      const slug = await newRoom(host);
      const player = await makeUser();
      await connect(slug, player).then((c) => c.close());
      await until(async () => expect(app.live.roomIds()).not.toContain(await roomIdOf(slug)));
      await pool.query(
        "insert into game_events (room_id, seq, type, actor_user_id, payload) select id, 1, 'game_started', $2, $3 from rooms where slug = $1",
        [slug, host.id, { order: [player.id] }],
      );
      const ch = await connect(slug, host);
      const late = await makeUser();
      const cl = await connect(slug, late);
      expect(cl.state.room.status).toBe("running");
      expect(cl.member(late.id)?.participation).toBe("spectator");
      cl.send({ type: "set_participation", userId: late.id, participation: "player" });
      ch.send({ type: "set_participation", userId: late.id, participation: "player" });
      ch.send({ type: "update_settings", settings: { bonusChains: false } });
      ch.send({ type: "update_settings", settings: { reactions: false } });
      await until(() => expect(cl.state.room.settings.reactions).toBe(false));
      expect(cl.errors).toEqual(["not_in_lobby"]);
      expect(ch.errors).toEqual(["not_in_lobby", "not_in_lobby"]);
      expect(cl.state.room.settings.bonusChains).toBe(true);
      expect(cl.member(late.id)?.participation).toBe("spectator");
    });

    it("lets everyone switch only themselves; hosts and co-hosts switch anyone", async () => {
      const slug = await newRoom(host);
      const ch = await connect(slug, host);
      const [u1, u2] = [await makeUser(), await makeUser()];
      const c1 = await connect(slug, u1);
      const c2 = await connect(slug, u2);

      c1.send({ type: "set_participation", userId: u1.id, participation: "spectator" });
      await until(() => expect(c2.member(u1.id)?.participation).toBe("spectator"));
      c1.send({ type: "set_participation", userId: u2.id, participation: "spectator" });
      await until(() => expect(c1.errors).toEqual(["forbidden"]));
      expect(c2.member(u2.id)?.participation).toBe("player");

      ch.send({ type: "set_participation", userId: u2.id, participation: "spectator" });
      await until(() => expect(c2.member(u2.id)?.participation).toBe("spectator"));
      ch.send({ type: "set_participation", userId: crypto.randomUUID(), participation: "player" });
      await until(() => expect(ch.errors).toEqual(["unknown_member"]));

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
      await until(() => expect(cother.errors).toEqual(["forbidden", "forbidden", "forbidden"]));

      ch.send({ type: "set_cohost", userId: co.id, isCohost: true });
      await until(() => expect(cco.state.viewer).toMatchObject({ canModerate: true, isHost: false }));
      cco.send({ type: "set_cohost", userId: other.id, isCohost: true });
      await until(() => expect(cco.errors).toEqual(["forbidden"]));
      ch.send({ type: "set_cohost", userId: host.id, isCohost: true });
      await until(() => expect(ch.errors).toEqual(["invalid_target"]));

      cco.send({ type: "update_settings", settings: { reactions: false, sixMessage: "  {name} hat Platz {platz}!  " } });
      await until(() => expect(cother.state.room.settings).toEqual({ ...defaultSettings, reactions: false, sixMessage: "{name} hat Platz {platz}!" }));
      cco.send({ type: "set_participation", userId: other.id, participation: "spectator" });
      await until(() => expect(cother.member(other.id)?.participation).toBe("spectator"));
      cco.send({ type: "update_settings", settings: { sixMessage: "" } });
      await until(() => expect(cco.errors).toEqual(["forbidden", "invalid_message"]));

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
      await until(() => expect(cplain.member(plain.id)?.participation).toBe("spectator"));
      await until(() => expect(cco.state.game.history.map((e) => e.type)).toEqual(["cohost_changed", "participation_changed"]));
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
      await until(() => expect(ch.member(user.id)?.displayName).toBe("Kapitän"));
      await until(() => expect(elsewhere.member(user.id)?.displayName).toBe("Kapitän"));
      expect(ch.member(user.id)?.hasNickname).toBe(true); // hosts see whether there is one to reset
      expect(ch.member(host.id)?.hasNickname).toBe(false);
      expect(cu.member(user.id)).not.toHaveProperty("hasNickname");

      ch.send({ type: "reset_nickname", userId: user.id });
      await until(() => expect(cu.member(user.id)?.displayName).toBe("Max"));
      await until(() => expect(elsewhere.member(user.id)?.displayName).toBe("Max"));
      await until(() => expect(ch.member(user.id)?.hasNickname).toBe(false));
      expect((await pool.query("select nickname from users where id = $1", [user.id])).rows[0].nickname).toBeNull();
      expect(ch.state.game.history.map((e) => e.type)).toEqual(["nickname_reset"]);
      expect(cu.state.game.history).toEqual([]);
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
      await until(() => expect(client.errors).toHaveLength(7));
      expect(new Set(client.errors)).toEqual(new Set(["invalid_message"]));
      const error = client.messages.at(-1);
      expect(error).toMatchObject({ type: "error", message: "Diese Nachricht versteht der Server nicht." });

      client.send({ type: "set_participation", userId: user.id, participation: "spectator", padding: "x".repeat(MAX_CLIENT_MESSAGE_BYTES) });
      expect((await client.closed).code).toBe(1009);
      await until(() => expect(watcher.member(user.id)?.connected).toBe(false));
      expect(watcher.member(user.id)?.participation).toBe("player");
      expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
    });

    it("rate-limits messages per connection and closes on repeated violations", async () => {
      const slug = await newRoom(host);
      const client = await connect(slug, await makeUser());
      for (let i = 0; i < 25; i++) client.send("{}");
      await until(() => expect(client.errors).toHaveLength(25));
      // The connect took one message from the budget.
      expect(client.errors.filter((e) => e === "invalid_message")).toHaveLength(MESSAGE_BURST - 1);
      expect(client.errors.filter((e) => e === "rate_limited")).toHaveLength(26 - MESSAGE_BURST);
      for (let i = 0; i < MAX_STRIKES + 5; i++) client.send("{}");
      expect((await client.closed).code).toBe(1008);
      await until(() => expect(logs.some((l) => l.msg === "ws closed" && l.reason === "rate limit")).toBe(true));
    });

    it("serializes concurrent messages: 50 changes, seq without gaps", async () => {
      const slug = await newRoom(host);
      const users = await Promise.all(Array.from({ length: 5 }, () => makeUser()));
      const cs = await Promise.all(users.map((u) => connect(slug, u)));
      cs.forEach((c, i) => {
        for (let n = 0; n < 10; n++) c.send({ type: "set_participation", userId: users[i]!.id, participation: n % 2 === 0 ? "spectator" : "player" });
      });
      await until(async () => expect(await eventsOf(slug)).toHaveLength(50));
      const events = await eventsOf(slug);
      expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      await until(() => expect(cs[0]!.state.members.filter((m) => m.participation === "player")).toHaveLength(5));
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
      const closed = new Promise((resolve) => socket!.on("close", resolve));
      // It joined (presence is batched, so a socket this short-lived may never show as connected).
      await until(() => expect(watcher.member(user.id)).toBeDefined());
      await closed;
      await until(() => expect(watcher.member(user.id)?.connected).toBe(false));
      expect(watcher.ws.readyState).toBe(WebSocket.OPEN); // Node's client answers pings
      expect(logs.some((l) => l.msg === "ws closed" && l.reason === "ping timeout" && l.userId === user.id)).toBe(true);
    });

    it("logs connects and closes with user ids, never names or payloads", async () => {
      const slug = await newRoom(host);
      const user = await makeUser(undefined, "Geheimname");
      logs.length = 0;
      const client = await connect(slug, user);
      client.send({ type: "set_participation", userId: user.id, participation: "spectator" });
      await until(() => expect(client.member(user.id)?.participation).toBe("spectator"));
      await client.close();
      await until(() => expect(logs.some((l) => l.msg === "ws closed")).toBe(true));
      expect(logs.find((l) => l.msg === "ws connected")).toMatchObject({ userId: user.id });
      const text = JSON.stringify(logs);
      for (const value of ["Geheimname", user.discordId, user.token, "set_participation", slug]) expect(text).not.toContain(value);
    });
  });

  describe("abuse limits", () => {
    it("shares one message budget among all sockets of a person in a room", async () => {
      const slug = await newRoom(host);
      const user = await makeUser();
      const tabs = [await connect(slug, user), await connect(slug, user), await connect(slug, user)];
      for (const tab of tabs) for (let i = 0; i < 8; i++) tab.send("{}");
      await until(() => expect(tabs.flatMap((t) => t.errors)).toHaveLength(24));
      expect(tabs.flatMap((t) => t.errors).filter((e) => e === "rate_limited").length).toBeGreaterThanOrEqual(4);
    });

    it(`allows ${MAX_SOCKETS_PER_USER} sockets per person and room and closes the next one`, async () => {
      const slug = await newRoom(host);
      const user = await makeUser();
      for (let i = 0; i < MAX_SOCKETS_PER_USER; i++) await connect(slug, user);
      const extra = open(slug, user);
      expect(await extra.closed).toEqual({ code: 1008, reason: "Zu viele offene Tabs in diesem Raum." });
      expect(extra.messages).toEqual([]);
      const other = await connect(slug, await makeUser()); // others are not affected
      expect(other.state.room.slug).toBe(slug);
    });

    it("limits nickname changes per IP", async () => {
      const user = await makeUser();
      const patch = () =>
        app.inject({ method: "PATCH", url: "/api/me", cookies: cookies(user), headers: { origin: ORIGIN }, payload: { nickname: "Max" }, remoteAddress: "192.0.2.9" });
      for (let i = 0; i < NICKNAME_LIMIT_PER_MINUTE; i++) expect((await patch()).statusCode).toBe(204);
      expect((await patch()).statusCode).toBe(429);
    });
  });

  describe("memory and database stay in step", () => {
    it("reloads a room whose memory fell behind the database instead of wedging it", async () => {
      const slug = await newRoom(host);
      const ch = await connect(slug, host);
      const user = await makeUser();
      const cu = await connect(slug, user);
      // A write the server did not see, as if a COMMIT succeeded but its reply was lost.
      await pool.query(
        "insert into game_events (room_id, seq, type, actor_user_id, payload) select id, 1, 'participation_changed', $2, $3 from rooms where slug = $1",
        [slug, host.id, { userId: host.id, participation: "player" }],
      );
      const toSpectator = { type: "set_participation", userId: user.id, participation: "spectator" };
      cu.send(toSpectator);
      await until(() => expect(cu.errors).toEqual(["internal"]));
      cu.send(toSpectator);
      await until(() => expect(cu.member(user.id)?.participation).toBe("spectator"));
      expect((await eventsOf(slug)).map((e) => e.seq)).toEqual([1, 2]);
      await until(() => expect(ch.state.game.history.map((e) => e.seq)).toEqual([1, 2]));
    });

    it("closes the room's sockets with 1012 when it cannot be reloaded", async () => {
      const timeout = new URL(dbUrl!);
      timeout.searchParams.set("options", "-c statement_timeout=300");
      const { app: slow } = await makeApp(env, timeout.href);
      await slow.listen({ port: 0, host: "127.0.0.1" });
      const admin = new pg.Client({ connectionString: dbUrl });
      await admin.connect();
      try {
        const slug = await newRoom(host, slow);
        const user = await makeUser();
        const client = await connect(slug, user, (slow.server.address() as AddressInfo).port);
        await admin.query("begin");
        await admin.query("lock table game_events in access exclusive mode");
        client.send({ type: "set_participation", userId: user.id, participation: "spectator" });
        expect(await client.closed).toEqual({ code: 1012, reason: "Der Raum wird neu geladen. Bitte verbinde dich neu." });
      } finally {
        await admin.query("rollback");
        await admin.end();
        await slow.close();
      }
    });

    // Found by the acceptance harness: a client that did not answer the close handshake held the shutdown for
    // ws's 30 s close timeout, so `podman restart` / `docker compose up` killed the app after 10 s.
    it("closes every socket with 1012 on shutdown without waiting for clients that never answer", async () => {
      const { app: stopping } = await makeApp(env, dbUrl);
      await stopping.listen({ port: 0, host: "127.0.0.1" });
      const stoppingPort = (stopping.server.address() as AddressInfo).port;
      const slug = await newRoom(host, stopping);
      const polite = await connect(slug, await makeUser(), stoppingPort);
      const silent = await makeUser();
      const { status, socket } = await upgrade(`/ws/rooms/${slug}`, { cookie: `${SESSION_COOKIE}=${silent.token}`, origin: ORIGIN }, stoppingPort);
      expect(status).toBe(101);
      socket!.resume(); // reads the close frame, never answers it
      const cut = new Promise((resolve) => socket!.on("close", resolve));
      await until(() => expect(stopping.live.userIds()).toContain(silent.id));
      const started = Date.now();
      await stopping.close();
      expect(Date.now() - started).toBeLessThan(SHUTDOWN_GRACE_MS + 1000);
      expect(await polite.closed).toEqual({ code: 1012, reason: "Der Server startet neu. Bitte verbinde dich neu." });
      await cut;
    });

    it("closes the sockets of a room that was deleted underneath", async () => {
      const slug = await newRoom(host);
      const roomId = await roomIdOf(slug);
      const user = await makeUser();
      const client = await connect(slug, user);
      await pool.query("delete from rooms where id = $1", [roomId]);
      client.send({ type: "set_participation", userId: user.id, participation: "spectator" });
      expect(await client.closed).toEqual({ code: 4004, reason: "Raum existiert nicht mehr." });
      expect(app.live.roomIds()).not.toContain(roomId);
      expect((await upgrade(`/ws/rooms/${slug}`, { cookie: `${SESSION_COOKIE}=${user.token}`, origin: ORIGIN })).status).toBe(404);
    });

    it("forgets a room when its last socket closes and reads it again on the next join", async () => {
      const slug = await newRoom(host);
      const roomId = await roomIdOf(slug);
      const user = await makeUser();
      const first = await connect(slug, user);
      expect(app.live.roomIds()).toContain(roomId);
      expect(app.live.userIds()).toContain(user.id);
      await first.close();
      await until(() => expect(app.live.roomIds()).not.toContain(roomId));
      expect(app.live.userIds()).not.toContain(user.id);
      await pool.query("update rooms set name = 'Umbenannt' where id = $1", [roomId]);
      const again = await connect(slug, user);
      expect(again.state.room.name).toBe("Umbenannt");
    });

    it("cleanup spares rooms with connections and the people connected", async () => {
      const slug = await newRoom(host);
      const roomId = await roomIdOf(slug);
      const user = await makeUser();
      const client = await connect(slug, user);
      await pool.query("update rooms set last_activity_at = now() - interval '400 days' where id = $1", [roomId]);
      await pool.query("update users set last_login_at = now() - interval '400 days' where id = $1", [user.id]);
      // A login 400 days ago has no valid session left; a valid one keeps the user (cleanup.ts).
      await pool.query("update sessions set expires_at = now() - interval '1 second' where user_id = $1", [user.id]);
      await runCleanup(pool, 90, app.live);
      expect(await roomIdOf(slug)).toBe(roomId);
      await client.close();
      await until(() => expect(app.live.roomIds()).not.toContain(roomId));
      await runCleanup(pool, 90, app.live);
      expect(await roomIdOf(slug)).toBeUndefined();
      expect((await pool.query("select 1 from users where id = $1", [user.id])).rows).toEqual([]);
    });
  });

  describe("sessions end their sockets", () => {
    it("closes the sockets of a session on logout, and only those", async () => {
      const slug = await newRoom(host);
      const user = await makeUser();
      const mine = await connect(slug, user);
      const other = await connect(slug, await makeUser());
      const res = await app.inject({ method: "POST", url: "/auth/logout", cookies: cookies(user), headers: { origin: ORIGIN } });
      expect(res.statusCode).toBe(204);
      expect(await mine.closed).toEqual({ code: 4001, reason: "Du hast dich abgemeldet. Melde dich wieder an, um weiterzumachen." });
      expect(other.ws.readyState).toBe(WebSocket.OPEN);
    });

    it("closes a socket when its session expires", async () => {
      const slug = await newRoom(host);
      const client = await connect(slug, await makeUser(undefined, "Erika", "1 second"));
      expect(await client.closed).toEqual({ code: 4001, reason: "Sitzung abgelaufen. Bitte melde dich neu an." });
    });
  });

  it("joins 100 sockets into a room with a long history without a broadcast storm", { timeout: 60_000 }, async () => {
    const n = 100;
    const slug = await newRoom(host);
    const roomId = await roomIdOf(slug);
    const users = await Promise.all(Array.from({ length: n }, () => makeUser()));
    // Co-hosts see the moderation history, so every state carries all 600 events.
    await pool.query("insert into room_members (room_id, user_id, participation, is_cohost) select $1, unnest($2::uuid[]), 'player', true", [roomId, users.map((u) => u.id)]);
    await pool.query(
      `insert into game_events (room_id, seq, type, actor_user_id, payload)
       select $1, g, 'participation_changed', $2::uuid, jsonb_build_object('userId', $2::text, 'participation', 'spectator') from generate_series(1, 600) g`,
      [roomId, host.id],
    );
    const stringify = vi.spyOn(JSON, "stringify");
    const renders = () => stringify.mock.calls.filter(([v]) => typeof v === "object" && v !== null && ("members" in v || "state" in v)).length;
    try {
      const started = performance.now();
      const cs = users.map((u) => open(slug, u));
      await until(() => {
        for (const c of cs) expect(c.messages.findLast((m) => m.type === "state")?.state.members.filter((m) => m.connected)).toHaveLength(n);
      });
      const ms = Math.round(performance.now() - started);
      const states = cs.reduce((sum, c) => sum + c.messages.filter((m) => m.type === "state").length, 0);
      const megabytes = (cs.reduce((sum, c) => sum + c.bytes, 0) / 1e6).toFixed(1);
      console.info(`${n} joins: ${states} state messages, ${megabytes} MB, ${ms} ms, ${renders()} renders`);
      expect(states).toBeLessThanOrEqual(2 * n);
      expect(ms).toBeLessThan(15_000);

      // One change: one rendering per audience (all are co-hosts here), shared by all sockets.
      stringify.mockClear();
      cs[0]!.send({ type: "set_participation", userId: users[0]!.id, participation: "spectator" });
      await until(() => {
        for (const c of cs) expect(c.state.members.find((m) => m.userId === users[0]!.id)?.participation).toBe("spectator");
      });
      expect(renders()).toBe(1);
      for (const c of cs) c.ws.close();
    } finally {
      stringify.mockRestore();
    }
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
    await until(() => expect(ch.state.room.settings.bonusChains).toBe(false));
    await until(() => expect(ch.state.game.history).toHaveLength(2));
    await cco.close();
    await cu.close();
    await until(() => expect(ch.state.members.filter((m) => m.connected)).toHaveLength(1));
    const before = ch.state;
    await ch.close();
    await first.app.close();

    const again = await connect(slug, host); // the shared app has never loaded this room
    expect(again.state).toEqual(before);
  });
});
