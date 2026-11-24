// The game over the room WebSocket (spec 4.3 to 4.11, 7, 13, 16) against a real PostgreSQL and a listening
// server: turns, host tools, the roll cooldown, test rooms, the guest link, reactions, restart recovery.
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/server/auth.js";
import { runCleanup } from "../src/server/cleanup.js";
import { runMigrations } from "../src/server/db/migrate.js";
import { CommandError, type GameCommandContext, handleGameCommand } from "../src/server/game-commands.js";
import { MAX_GUESTS_PER_IP, MAX_GUESTS_PER_ROOM, MAX_SIMULATED_PLAYERS } from "../src/server/rooms.js";
import { type GameEvent, type Participation, type RoomView, type Settings, defaultSettings } from "../src/shared/contracts.js";
import { reduce } from "../src/shared/game/reduce.js";
import { makeApp } from "./helpers.js";
import { Client, HOST2_ID, HOST_ID, ORIGIN, type User, env, makeUser as makeUserIn, until } from "./ws.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const COOLDOWN = 150; // injected instead of ROLL_COOLDOWN_MS
const BOT_DELAY = 30; // injected instead of SIMULATED_ROLL_DELAY_MS
const timing = { pingIntervalMs: 200, rollCooldownMs: COOLDOWN, simulatedRollDelayMs: BOT_DELAY };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type App = Awaited<ReturnType<typeof makeApp>>["app"];
type Players = Map<string, Client>; // by user id

let ip = 0;
const nextIp = () => `10.3.${(++ip >> 8) & 255}.${ip & 255}`;

// Every `rolled` a client got must come after a state that already holds that roll (spec 7, 4.3).
function expectRolledAfterState(client: Client) {
  let rolls: GameEvent[] = [];
  let matched = 0;
  let count = 0;
  for (const m of client.messages) {
    if (m.type === "state") rolls = m.state.game.history.filter((e) => e.type === "rolled");
    if (m.type !== "rolled") continue;
    const hit = rolls.find(
      (e) => e.type === "rolled" && e.seq > matched && e.payload.userId === m.userId && e.payload.dice.join() === m.dice.join() && e.payload.rolledBy === m.rolledBy,
    );
    expect(hit, `rolled ${JSON.stringify(m)} before its state`).toBeDefined();
    matched = hit!.seq;
    count++;
  }
  return count;
}

describe("handleGameCommand: what decide cannot see", () => {
  const [A, B, S] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const ctx = (members: [string, Participation][], over: Partial<GameCommandContext> = {}): GameCommandContext => ({
    actor: { userId: A, canModerate: true },
    room: { game: reduce([], defaultSettings), members: new Map(members.map(([id, participation]) => [id, { participation }])), lastRollAt: 0 },
    rollCooldownMs: 2000,
    now: 10_000,
    ...over,
  });
  const running = (members: [string, Participation][]) => {
    const c = ctx(members);
    const started: GameEvent = { seq: 1, type: "game_started", actorUserId: A, payload: { order: [A, B] }, createdAt: "2026-12-01T18:00:00.000Z" };
    return { ...c, room: { ...c.room, game: reduce([started], defaultSettings) } };
  };
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (err) {
      return err instanceof CommandError ? err.code : String(err);
    }
    return "ok";
  };

  it("starts with the members who are players", () => {
    const { events } = handleGameCommand(ctx([[A, "player"], [B, "spectator"], [S, "player"]]), { type: "start" });
    expect(events).toHaveLength(1);
    expect(events[0]!.type === "game_started" && [...events[0]!.payload.order].sort()).toEqual([A, S].sort());
  });

  it("adds spectators who are members, and moves participation along", () => {
    const c = running([[A, "player"], [B, "player"], [S, "spectator"]]);
    expect(code(() => handleGameCommand(c, { type: "add_player", userId: crypto.randomUUID() }))).toBe("unknown_member");
    expect(handleGameCommand(c, { type: "add_player", userId: S }).participation).toEqual({ userId: S, participation: "player" });
    expect(handleGameCommand(c, { type: "remove_player", userId: B }).participation).toEqual({ userId: B, participation: "spectator" });
    const odd = running([[A, "player"], [B, "player"], [S, "player"]]); // a player outside the game: not a latecomer
    expect(code(() => handleGameCommand(odd, { type: "add_player", userId: S }))).toBe("not_spectator");
  });

  it("refuses a roll within the cooldown, and only a roll", () => {
    const c = running([[A, "player"], [B, "player"]]);
    const cooling = { ...c, room: { ...c.room, lastRollAt: 9_000 } };
    expect(code(() => handleGameCommand(cooling, { type: "roll" }))).toBe("cooldown");
    expect(code(() => handleGameCommand(cooling, { type: "roll_for" }))).toBe("cooldown");
    expect(code(() => handleGameCommand(cooling, { type: "skip" }))).toBe("ok");
    expect(code(() => handleGameCommand({ ...cooling, now: 11_000 }, { type: "roll" }))).toBe("ok");
    expect(code(() => handleGameCommand({ ...cooling, actor: { userId: B, canModerate: false } }, { type: "roll" }))).toBe("not_your_turn");
  });
});

describe.skipIf(!dbUrl)("the game with PostgreSQL", () => {
  let pool: pg.Pool;
  let app: App;
  let port: number;
  let host: User;
  let host2: User;
  const clients: Client[] = [];

  const makeUser = (name?: string) => makeUserIn(pool, undefined, name);

  async function newRoom(isTest = false, target: App = app) {
    const res = await target.inject({ method: "POST", url: "/api/rooms", cookies: { [SESSION_COOKIE]: host.token }, headers: { origin: ORIGIN }, payload: { name: "Feier", isTest }, remoteAddress: nextIp() });
    expect(res.statusCode).toBe(201);
    return res.json().slug as string;
  }
  function open(path: string, user?: User, headers: Record<string, string> = {}, targetPort = port) {
    const client = Client.open(targetPort, path, user, headers);
    clients.push(client);
    return client;
  }
  async function connect(slug: string, user: User, targetPort = port) {
    const client = open(`/ws/rooms/${slug}`, user, {}, targetPort);
    await until(() => client.state);
    return client;
  }
  async function watch(token: string, headers: Record<string, string> = {}, targetPort = port) {
    const client = open(`/ws/watch/${token}`, undefined, headers, targetPort);
    await until(() => client.state);
    return client;
  }
  const eventsOf = async (slug: string) =>
    (
      await pool.query(
        "select e.seq, e.type, e.actor_user_id as actor, e.payload, e.created_at from game_events e join rooms r on r.id = e.room_id where r.slug = $1 order by e.seq",
        [slug],
      )
    ).rows as { seq: number; type: string; actor: string | null; payload: Record<string, unknown>; created_at: Date }[];
  const historyLength = (c: Client) => c.state.game.history.length;
  const tokenOf = (view: RoomView) => new URL(view.room.watchUrl!).pathname.split("/").at(-1)!;

  // A room with real players (and simulated ones in a test room) and a running game; the host watches.
  async function startGame(n: number, options: { isTest?: boolean; sims?: number; settings?: Partial<Settings> } = {}) {
    const slug = await newRoom(options.isTest ?? false);
    const ch = await connect(slug, host);
    const users = await Promise.all(Array.from({ length: n }, (_, i) => makeUser(`Spieler ${i + 1}`)));
    const players: Players = new Map();
    for (const user of users) players.set(user.id, await connect(slug, user));
    if (options.sims) ch.send({ type: "add_simulated_players", count: options.sims });
    if (options.settings) ch.send({ type: "update_settings", settings: options.settings });
    await until(() => expect(ch.state.members.filter((m) => m.participation === "player")).toHaveLength(n + (options.sims ?? 0)));
    if (options.settings) await until(() => expect(ch.state.room.settings).toMatchObject(options.settings!));
    ch.send({ type: "start" });
    await until(() => expect(ch.state.room.status).toBe("running"));
    return { slug, ch, players, users };
  }

  // Plays until the end: the active real player rolls, simulated players roll by themselves, the host
  // continues after every six. claimLast: the last real player takes the last place instead of rolling.
  async function play(ch: Client, players: Players, claimLast = false) {
    for (let step = 0; step < 1000; step++) {
      const game = ch.state.game;
      if (game.status === "finished") return;
      const before = game.history.length;
      const active = players.get(game.activeUserId!);
      if (game.pause) ch.send({ type: "continue" });
      else if (active && claimLast && game.turnOrder.length === 1) active.send({ type: "claim_last_place" });
      else active?.send({ type: "roll" }); // nobody: a simulated player's turn
      await until(() => expect(historyLength(ch)).toBeGreaterThan(before), 10_000);
      if (ch.state.game.history.at(-1)?.type === "rolled") await sleep(COOLDOWN + 10);
    }
    throw new Error("the game did not end");
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: dbUrl });
    await runMigrations(pool);
    ({ app } = await makeApp(env, dbUrl, timing));
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
    host = await makeUserIn(pool, HOST_ID, "Henrike");
    host2 = await makeUserIn(pool, HOST2_ID, "Hanna");
  });
  afterAll(async () => {
    for (const c of clients) c.ws.close();
    await app.close();
    await pool.end();
  });

  describe("turns and rights (spec 4.1, 7, 16)", () => {
    it("plays a complete game with three real clients to a complete gift order", { timeout: 60_000 }, async () => {
      const { slug, ch, players, users } = await startGame(3);
      ch.send({ type: "set_watch_link", action: "enable" }); // a guest watches the whole game too
      await until(() => expect(ch.state.room.watchUrl).toBeDefined());
      const guest = await watch(tokenOf(ch.state));
      await play(ch, players, true);
      const ids = users.map((u) => u.id);
      for (const c of [ch, guest, ...players.values()]) {
        await until(() => expect(c.state.room.status).toBe("finished"));
        expect([...c.state.game.giftOrder].sort()).toEqual([...ids].sort());
        expect(c.state.game.giftOrder).toEqual(ch.state.game.giftOrder);
      }
      // Every client got every roll as `rolled`, never before the state holding it.
      const rolls = (await eventsOf(slug)).filter((e) => e.type === "rolled").length;
      for (const c of [ch, guest, ...players.values()]) await until(() => expect(expectRolledAfterState(c)).toBe(rolls));
      expect(rolls).toBeGreaterThanOrEqual(2);
    });

    it("refuses a roll outside one's turn, also from manipulated messages", async () => {
      const { slug, ch, players } = await startGame(3);
      const active = ch.state.game.activeUserId!;
      const [other] = [...players].filter(([id]) => id !== active).map(([, c]) => c);
      for (const message of [
        { type: "roll" },
        { type: "roll", userId: active }, // there is no "roll for" field to fake
        { type: "roll_for" },
        { type: "claim_last_place" },
        { type: "rolled", userId: active, dice: [6] },
      ]) {
        other!.send(message);
      }
      // Schema errors are answered at once, the rest from the room queue: compare without order.
      await until(() => expect([...other!.errors].sort()).toEqual(["invalid_message", "invalid_message", "not_host", "not_last_player", "not_your_turn"]));
      expect((await eventsOf(slug)).map((e) => e.type)).toEqual(["game_started"]);
      players.get(active)!.send({ type: "roll" });
      await until(async () => expect((await eventsOf(slug)).map((e) => e.type)).toEqual(["game_started", "rolled"]));
      const [, rolled] = await eventsOf(slug);
      expect(rolled).toMatchObject({ actor: active, payload: { userId: active } });
    });

    it("refuses host actions from players", async () => {
      const { slug, ch, players } = await startGame(2);
      const [first, second] = [...players.keys()];
      const player = players.get(first!)!;
      const hostOnly = [
        { type: "start" },
        { type: "pause" },
        { type: "continue" },
        { type: "skip" },
        { type: "roll_for" },
        { type: "remove_player", userId: second },
        { type: "add_player", userId: host.id },
        { type: "assign_last_place" },
        { type: "undo" },
        { type: "end" },
        { type: "reset" },
      ];
      for (const message of hostOnly) player.send(message);
      for (const message of [{ type: "set_watch_link", action: "enable" }, { type: "add_simulated_players", count: 1 }]) player.send(message);
      await until(() => expect(player.errors).toHaveLength(hostOnly.length + 2));
      expect(player.errors).toEqual([...hostOnly.map(() => "not_host"), "forbidden", "forbidden"]);
      expect((await eventsOf(slug)).map((e) => e.type)).toEqual(["game_started"]);
      expect(ch.state.room.watchLinkActive).toBe(false);
    });

    it("refuses rolls during a pause", async () => {
      const { slug, ch, players } = await startGame(2);
      const active = players.get(ch.state.game.activeUserId!)!;
      ch.send({ type: "pause" });
      await until(() => expect(ch.state.game.pause).toBe("host"));
      active.send({ type: "roll" });
      ch.send({ type: "roll_for" });
      await until(() => expect([...active.errors, ...ch.errors]).toEqual(["paused", "paused"]));
      ch.send({ type: "continue" });
      await until(() => expect(ch.state.game.pause).toBeNull());
      active.send({ type: "roll" });
      await until(async () => expect((await eventsOf(slug)).map((e) => e.type)).toEqual(["game_started", "paused", "continued", "rolled"]));
    });

    it("lets a second host carry on after the first one disconnects (spec 4.2, 16)", async () => {
      const { slug, ch, players } = await startGame(2);
      await ch.close();
      const ch2 = await connect(slug, host2);
      expect(ch2.state.viewer).toMatchObject({ isHost: true });
      ch2.send({ type: "pause" });
      await until(() => expect(ch2.state.game.pause).toBe("host"));
      ch2.send({ type: "continue" });
      ch2.send({ type: "skip" });
      await until(() => expect(ch2.state.game.history.map((e) => e.type)).toEqual(["game_started", "paused", "continued", "skipped"]));
      players.get(ch2.state.game.activeUserId!)!.send({ type: "roll" });
      await until(() => expect(ch2.state.game.lastRoll).not.toBeNull());
      expect(ch2.errors).toEqual([]);
    });

    it(`accepts no roll for ${COOLDOWN} ms after a roll (spec 7)`, async () => {
      const { slug, ch } = await startGame(3);
      for (let attempt = 0; attempt < 20 && !ch.errors.includes("cooldown"); attempt++) {
        if (ch.state.game.pause) {
          ch.send({ type: "continue" });
          await until(() => expect(ch.state.game.pause).toBeNull());
        }
        const rolls = (await eventsOf(slug)).filter((e) => e.type === "rolled").length;
        ch.send({ type: "roll_for" });
        ch.send({ type: "roll_for" });
        await until(async () => expect((await eventsOf(slug)).filter((e) => e.type === "rolled")).toHaveLength(rolls + 1));
        await until(() => expect(ch.errors.length).toBeGreaterThan(0));
        await sleep(COOLDOWN + 10);
      }
      expect(ch.errors).toContain("cooldown"); // the second of a pair, unless the first was a six ("paused")
      expect(ch.messages.find((m) => m.type === "error" && m.code === "cooldown")).toMatchObject({ message: "Der Würfel rollt noch. Bitte warte einen Moment." });
    });

    it("adds latecomers and removes players: members only, participation follows (spec 4.2, 4.9)", async () => {
      const { slug, ch, players } = await startGame(2);
      const [first] = [...players.keys()];
      const late = await makeUser("Nachzügler");
      const cl = await connect(slug, late);
      expect(cl.member(late.id)?.participation).toBe("spectator");
      ch.send({ type: "add_player", userId: crypto.randomUUID() });
      ch.send({ type: "remove_player", userId: crypto.randomUUID() });
      ch.send({ type: "add_player", userId: first });
      await until(() => expect(ch.errors).toEqual(["unknown_member", "not_in_game", "already_in_game"]));
      ch.send({ type: "add_player", userId: late.id });
      await until(() => expect(cl.state.game.turnOrder.at(-1)).toBe(late.id));
      expect(cl.member(late.id)?.participation).toBe("player");
      ch.send({ type: "remove_player", userId: first });
      await until(() => expect(cl.state.game.removed).toEqual([first]));
      expect(cl.member(first!)?.participation).toBe("spectator");
      const { rows } = await pool.query("select user_id, participation from room_members where user_id = any($1)", [[first, late.id]]);
      expect(Object.fromEntries(rows.map((r) => [r.user_id, r.participation]))).toEqual({ [first!]: "spectator", [late.id]: "player" });
      expect(ch.state.game.history.map((e) => e.type)).toEqual(["game_started", "player_added", "player_removed"]);
      expect(cl.state.game.history).toEqual([]); // moderation stays with the hosts
    });
  });

  describe("test rooms (spec 4.7)", () => {
    it("refuses simulated players in normal rooms", async () => {
      const slug = await newRoom(false);
      const ch = await connect(slug, host);
      ch.send({ type: "add_simulated_players", count: 2 });
      ch.send({ type: "remove_simulated_player", userId: crypto.randomUUID() });
      await until(() => expect(ch.errors).toEqual(["not_test_room", "not_test_room"]));
      expect(ch.state.members).toHaveLength(1);
    });

    it("adds and removes simulated players in the lobby, named uniquely, as users without Discord", async () => {
      const slug = await newRoom(true);
      const ch = await connect(slug, host);
      const user = await makeUser();
      const cu = await connect(slug, user);
      cu.send({ type: "add_simulated_players", count: 1 });
      await until(() => expect(cu.errors).toEqual(["forbidden"]));
      ch.send({ type: "add_simulated_players", count: 3 });
      await until(() => expect(cu.state.members.filter((m) => m.isSimulated)).toHaveLength(3));
      const sims = () => ch.state.members.filter((m) => m.isSimulated);
      expect(sims().map((m) => [m.displayName, m.participation, m.connected, m.avatarUrl])).toEqual([
        ["Testspieler 1", "player", true, null],
        ["Testspieler 2", "player", true, null],
        ["Testspieler 3", "player", true, null],
      ]);
      const { rows } = await pool.query("select discord_id, is_simulated, last_login_at from users where id = any($1)", [sims().map((m) => m.userId)]);
      expect(rows).toEqual(Array(3).fill({ discord_id: null, is_simulated: true, last_login_at: null }));

      const second = sims()[1]!.userId;
      ch.send({ type: "remove_simulated_player", userId: second });
      ch.send({ type: "remove_simulated_player", userId: user.id });
      await until(() => expect(ch.errors).toEqual(["invalid_target"]));
      expect((await pool.query("select 1 from users where id = $1", [second])).rows).toEqual([]);
      ch.send({ type: "add_simulated_players", count: 2 });
      await until(() => expect(sims().map((m) => m.displayName)).toEqual(["Testspieler 1", "Testspieler 3", "Testspieler 2", "Testspieler 4"]));
      ch.send({ type: "add_simulated_players", count: MAX_SIMULATED_PLAYERS - 3 });
      await until(() => expect(ch.errors).toEqual(["invalid_target", "too_many_simulated"]));
      ch.send({ type: "set_cohost", userId: sims()[0]!.userId, isCohost: true });
      await until(() => expect(ch.errors.at(-1)).toBe("invalid_target"));
      expect(ch.state.game.history.filter((e) => e.type === "simulated_players_changed")).toHaveLength(3);

      ch.send({ type: "start" });
      await until(() => expect(ch.state.room.status).toBe("running"));
      ch.send({ type: "pause" });
      ch.send({ type: "add_simulated_players", count: 1 });
      ch.send({ type: "remove_simulated_player", userId: sims()[0]!.userId });
      await until(() => expect(ch.errors.slice(-2)).toEqual(["not_in_lobby", "not_in_lobby"]));
    });

    it("lets simulated players roll by themselves, only on their turn and never in a pause", { timeout: 30_000 }, async () => {
      const { slug, ch, players, users } = await startGame(1, { isTest: true, sims: 2 });
      const real = users[0]!.id;
      // Until the real player's turn comes, the simulated ones roll; then nothing happens without them.
      await until(() => {
        if (ch.state.game.pause) ch.send({ type: "continue" });
        expect(ch.state.game).toMatchObject({ activeUserId: real, pause: null });
      }, 10_000);
      const before = historyLength(ch);
      await sleep(COOLDOWN + BOT_DELAY * 4);
      expect(historyLength(ch)).toBe(before);
      players.get(real)!.send({ type: "roll" });
      await until(() => expect(historyLength(ch)).toBeGreaterThan(before));
      const rolls = (await eventsOf(slug)).filter((e) => e.type === "rolled");
      for (const e of rolls) expect(e.actor).toBe(e.payload.userId); // simulated or real: the roller is the actor

      // A host pause stops them.
      if (ch.state.game.status === "running") {
        ch.send({ type: "pause" });
        await until(() => expect(ch.state.game.pause).not.toBeNull());
        const paused = historyLength(ch);
        await sleep(COOLDOWN + BOT_DELAY * 4);
        expect(historyLength(ch)).toBe(paused);
      }
    });

    it("finishes a game with only simulated players to a complete order", { timeout: 60_000 }, async () => {
      const { slug, ch } = await startGame(0, { isTest: true, sims: 4 });
      await play(ch, new Map());
      const sims = ch.state.members.filter((m) => m.isSimulated).map((m) => m.userId);
      expect([...ch.state.game.giftOrder].sort()).toEqual([...sims].sort());
      // The last one kept rolling ("choice"): every place came from a six.
      const events = await eventsOf(slug);
      expect(events.some((e) => e.type === "last_place_taken")).toBe(false);
      expect(events.filter((e) => e.type === "rolled" && (e.payload.dice as number[]).includes(6))).toHaveLength(4);
      expect(events.filter((e) => e.type === "rolled").every((e) => e.actor === e.payload.userId)).toBe(true);
    });

    it("deletes simulated players together with their room (spec 9.3)", async () => {
      const slug = await newRoom(true);
      const ch = await connect(slug, host);
      ch.send({ type: "add_simulated_players", count: 3 });
      await until(() => expect(ch.state.members.filter((m) => m.isSimulated)).toHaveLength(3));
      const sims = ch.state.members.filter((m) => m.isSimulated).map((m) => m.userId);
      const count = async () => (await pool.query("select count(*)::int as n from users where id = any($1)", [sims])).rows[0].n;
      const roomId = (await pool.query("update rooms set last_activity_at = now() - interval '400 days' where slug = $1 returning id", [slug])).rows[0].id;
      await runCleanup(pool, 90, app.live); // the room is in use
      expect(await count()).toBe(3);
      await ch.close();
      await until(() => expect(app.live.roomIds()).not.toContain(roomId));
      await runCleanup(pool, 90, app.live);
      expect(await count()).toBe(0);
      const { rows } = await pool.query("select count(*)::int as n from users u where u.is_simulated and not exists (select 1 from room_members m where m.user_id = u.id)");
      expect(rows[0].n).toBe(0); // no orphans anywhere
    });
  });

  describe("guest link (spec 4.8)", () => {
    it("is off by default: 404 for the page and the socket", async () => {
      const slug = await newRoom();
      const ch = await connect(slug, host);
      expect(ch.state.room).toMatchObject({ watchLinkActive: false, guestCount: 0 });
      expect(ch.state.room).not.toHaveProperty("watchUrl");
      const token = randomBytes(16).toString("base64url");
      for (const method of ["GET", "HEAD"] as const) {
        expect((await app.inject({ method, url: `/z/${token}`, remoteAddress: nextIp() })).statusCode).toBe(404);
        expect((await app.inject({ method, url: "/z/short", remoteAddress: nextIp() })).statusCode).toBe(404);
      }
      const refused = open(`/ws/watch/${token}`);
      expect((await refused.closed).code).toBe(1006); // the upgrade was answered with 404
    });

    it("shows a read-only guest view: players and places, display names, public history", { timeout: 30_000 }, async () => {
      const { slug, ch, users } = await startGame(2);
      const watcher = await makeUser("Zuschauerin");
      const cw = await connect(slug, watcher);
      ch.send({ type: "set_watch_link", action: "enable" });
      await until(() => expect(cw.state.room.watchLinkActive).toBe(true));
      expect(cw.state.room).not.toHaveProperty("watchUrl");
      const token = tokenOf(ch.state);
      expect(token).toMatch(/^[\w-]{22}$/);
      expect(ch.state.room.watchUrl).toBe(`${ORIGIN}/z/${token}`);
      const page = await app.inject({ url: `/z/${token}`, remoteAddress: nextIp() });
      expect(page.statusCode).toBe(200);
      expect((await app.inject({ method: "HEAD", url: `/z/${token}`, remoteAddress: nextIp() })).statusCode).toBe(200); // the client probes with HEAD
      expect(page.body).toBe((await app.inject({ url: "/" })).body);

      const foreign = open(`/ws/watch/${token}`, undefined, { origin: "https://evil.example" });
      expect((await foreign.closed).code).toBe(1006); // 403 before the upgrade
      const guest = await watch(token);
      await until(() => expect(ch.state.room.guestCount).toBe(1));
      expect(ch.state.members).toHaveLength(4); // guests are no members
      ch.send({ type: "pause" });
      await until(() => expect(ch.state.game.pause).toBe("host"));
      ch.send({ type: "continue" });
      ch.send({ type: "roll_for" });
      await until(() => expect(guest.messages.some((m) => m.type === "rolled")).toBe(true));

      const view = guest.state;
      expect(view.viewer).toEqual({ kind: "guest" });
      expect(view.room.slug).toBe("");
      expect(view.room).not.toHaveProperty("guestCount");
      expect(view.room).not.toHaveProperty("watchUrl");
      expect(view.members.map((m) => m.userId).sort()).toEqual(users.map((u) => u.id).sort());
      for (const m of view.members) {
        expect(m.avatarUrl).toBeNull();
        expect(m).not.toHaveProperty("discordName");
      }
      expect(view.game.history.map((e) => e.type)).toEqual(["rolled"]);
      const text = JSON.stringify(guest.messages);
      for (const secret of [slug, host.discordId, watcher.discordId, ...users.map((u) => u.discordId), "henrike-", "/avatars/", "paused"]) expect(text).not.toContain(secret);

      // Whatever a guest sends is dropped, without an answer.
      const events = (await eventsOf(slug)).length;
      for (const message of [{ type: "roll" }, { type: "pause" }, { type: "react", emoji: "🎉" }, "kaputt"]) guest.send(message);
      await sleep(300);
      expect(guest.messages.filter((m) => m.type === "error" || m.type === "reactions")).toEqual([]);
      expect((await eventsOf(slug)).length).toBe(events);
      expect(guest.ws.readyState).toBe(WebSocket.OPEN);
    });

    it("disconnects guests at once when the link is regenerated or switched off", async () => {
      const slug = await newRoom();
      const ch = await connect(slug, host);
      ch.send({ type: "set_watch_link", action: "enable" });
      await until(() => expect(ch.state.room.watchUrl).toBeDefined());
      const old = tokenOf(ch.state);
      const guests = [await watch(old), await watch(old)];
      await until(() => expect(ch.state.room.guestCount).toBe(2));
      ch.send({ type: "set_watch_link", action: "enable" }); // already on: nothing changes
      ch.send({ type: "set_watch_link", action: "regenerate" });
      for (const g of guests) expect(await g.closed).toEqual({ code: 4004, reason: "Dieser Zuschauer-Link gilt nicht mehr." });
      await until(() => expect(tokenOf(ch.state)).not.toBe(old));
      expect(ch.state.room.guestCount).toBe(0);
      const fresh = tokenOf(ch.state);
      expect((await app.inject({ url: `/z/${old}`, remoteAddress: nextIp() })).statusCode).toBe(404);
      expect((await open(`/ws/watch/${old}`).closed).code).toBe(1006);
      const again = await watch(fresh);
      ch.send({ type: "set_watch_link", action: "disable" });
      expect((await again.closed).code).toBe(4004);
      await until(() => expect(ch.state.room.watchLinkActive).toBe(false));
      expect((await app.inject({ url: `/z/${fresh}`, remoteAddress: nextIp() })).statusCode).toBe(404);
      expect((await app.inject({ method: "HEAD", url: `/z/${fresh}`, remoteAddress: nextIp() })).statusCode).toBe(404);
      expect(ch.state.game.history.map((e) => e.type)).toEqual(["watch_link_changed", "watch_link_changed", "watch_link_changed"]);
    });

    it(`allows ${MAX_GUESTS_PER_IP} guest connections per IP and ${MAX_GUESTS_PER_ROOM} per room`, { timeout: 60_000 }, async () => {
      const proxied = await makeApp({ ...env, TRUSTED_PROXIES: "127.0.0.1" }, dbUrl, timing);
      await proxied.app.listen({ port: 0, host: "127.0.0.1" });
      const proxiedPort = (proxied.app.server.address() as AddressInfo).port;
      try {
        const slug = await newRoom(false, proxied.app);
        const ch = await connect(slug, host, proxiedPort);
        ch.send({ type: "set_watch_link", action: "enable" });
        await until(() => expect(ch.state.room.watchUrl).toBeDefined());
        const token = tokenOf(ch.state);
        const from = (address: string) => ({ "x-forwarded-for": address });

        const same = await Promise.all(Array.from({ length: MAX_GUESTS_PER_IP }, () => watch(token, from("198.51.100.1"), proxiedPort)));
        const sixth = open(`/ws/watch/${token}`, undefined, from("198.51.100.1"), proxiedPort);
        expect(await sixth.closed).toEqual({ code: 1008, reason: "Zu viele Zuschauer-Verbindungen von deiner Adresse." });
        await same[0]!.close();
        await sleep(50);
        same[0] = await watch(token, from("198.51.100.1"), proxiedPort); // a freed slot counts again

        const rest = MAX_GUESTS_PER_ROOM - MAX_GUESTS_PER_IP;
        await Promise.all(Array.from({ length: rest }, (_, i) => watch(token, from(`10.9.${i >> 8}.${i & 255}`), proxiedPort)));
        await until(() => expect(ch.state.room.guestCount).toBe(MAX_GUESTS_PER_ROOM));
        const over = open(`/ws/watch/${token}`, undefined, from("192.0.2.200"), proxiedPort);
        expect(await over.closed).toEqual({ code: 1008, reason: "Zu viele Zuschauer in diesem Raum." });
        expect(ch.state.members).toHaveLength(1); // guests never show up as members
      } finally {
        await proxied.app.close();
      }
    });
  });

  describe("reactions (spec 4.11)", () => {
    it("bundles reactions for members and guests, never stores them, refuses the active player", async () => {
      const { slug, ch, players } = await startGame(2);
      const active = ch.state.game.activeUserId!;
      const [other] = [...players].filter(([id]) => id !== active).map(([, c]) => c);
      ch.send({ type: "set_watch_link", action: "enable" });
      await until(() => expect(ch.state.room.watchUrl).toBeDefined());
      const guest = await watch(tokenOf(ch.state));
      const events = (await eventsOf(slug)).length;

      players.get(active)!.send({ type: "react", emoji: "🎉" });
      ch.send({ type: "react", emoji: "🎉" });
      other!.send({ type: "react", emoji: "🎉" });
      other!.send({ type: "react", emoji: "😂" }); // within 2 s: refused
      await until(() => expect(players.get(active)!.errors).toEqual(["active_player"]));
      await until(() => expect(other!.errors).toEqual(["reaction_too_fast"]));
      const bundles = (c: Client) => c.messages.filter((m) => m.type === "reactions");
      for (const c of [ch, guest, other!]) {
        await until(() => expect(bundles(c)).toEqual([{ type: "reactions", emojis: [{ emoji: "🎉", count: 2 }] }]));
      }
      expect((await eventsOf(slug)).length).toBe(events);
    });

    it("refuses reactions when the hosts switched them off", async () => {
      const slug = await newRoom();
      const ch = await connect(slug, host);
      const cu = await connect(slug, await makeUser());
      ch.send({ type: "update_settings", settings: { reactions: false } });
      await until(() => expect(cu.state.room.settings.reactions).toBe(false));
      cu.send({ type: "react", emoji: "❤️" });
      await until(() => expect(cu.errors).toEqual(["reactions_off"]));
      await sleep(300);
      expect(ch.messages.filter((m) => m.type === "reactions")).toEqual([]);
    });
  });

  describe("restart (spec 6, 16)", () => {
    it("rebuilds a running game, loses no roll, and the simulated players go on", { timeout: 60_000 }, async () => {
      const first = await makeApp(env, dbUrl, timing);
      await first.app.listen({ port: 0, host: "127.0.0.1" });
      const firstPort = (first.app.server.address() as AddressInfo).port;
      const slug = await newRoom(true, first.app);
      const ch = await connect(slug, host, firstPort);
      const user = await makeUser();
      const cu = await connect(slug, user, firstPort);
      ch.send({ type: "add_simulated_players", count: 3 });
      await until(() => expect(ch.state.members.filter((m) => m.participation === "player")).toHaveLength(4));
      ch.send({ type: "start" });
      // Play a few rolls, the real player's too, continuing after sixes.
      await until(async () => {
        const game = ch.state.game;
        if (game.pause) ch.send({ type: "continue" });
        if (game.activeUserId === user.id && !game.pause) cu.send({ type: "roll" });
        expect(game.history.filter((e) => e.type === "rolled").length).toBeGreaterThanOrEqual(4);
      }, 20_000);
      await first.app.close(); // closes the sockets; whatever was committed is in the database
      const rolledSeen = cu.messages.filter((m) => m.type === "rolled").length;
      const events = await eventsOf(slug);
      expect(events.filter((e) => e.type === "rolled").length).toBeGreaterThanOrEqual(rolledSeen);
      const [{ settings }] = (await pool.query("select settings from rooms where slug = $1", [slug])).rows;
      const expected = reduce(
        events.map((e) => ({ seq: e.seq, type: e.type, actorUserId: e.actor, payload: e.payload, createdAt: e.created_at.toISOString() }) as GameEvent),
        settings,
      );

      // A second app has never seen the room: the clients reconnect and get the same game.
      const slow = await makeApp(env, dbUrl, { ...timing, simulatedRollDelayMs: 500 });
      await slow.app.listen({ port: 0, host: "127.0.0.1" });
      try {
        const slowPort = (slow.app.server.address() as AddressInfo).port;
        const again = await connect(slug, host, slowPort);
        const back = await connect(slug, user, slowPort);
        const sims = new Set(again.state.members.filter((m) => m.isSimulated).map((m) => m.userId));
        expect(again.state.game).toEqual(expected);
        expect(back.state.game.giftOrder).toEqual(expected.giftOrder);
        if (again.state.game.status === "finished") return;
        if (again.state.game.pause) again.send({ type: "continue" });
        await until(async () => {
          const game = again.state.game;
          if (game.activeUserId === user.id && !game.pause) back.send({ type: "roll" });
          expect(game.history.filter((e) => e.type === "rolled" && sims.has(e.actorUserId!)).length).toBeGreaterThan(
            expected.history.filter((e) => e.type === "rolled" && sims.has(e.actorUserId!)).length,
          );
        }, 20_000);
      } finally {
        await slow.app.close();
      }
    });
  });

  it("100 sockets in one running game all get every state; reports the broadcast latency (spec 16)", { timeout: 120_000 }, async () => {
    const n = 100;
    const slug = await newRoom();
    const roomId = (await pool.query("select id from rooms where slug = $1", [slug])).rows[0].id;
    const users = await Promise.all(Array.from({ length: n - 1 }, (_, i) => makeUser(`Gast ${i}`)));
    const rollers = users.slice(0, 5);
    await pool.query("insert into room_members (room_id, user_id, participation) select $1, unnest($2::uuid[]), 'spectator'", [roomId, users.slice(5).map((u) => u.id)]);
    await pool.query("insert into room_members (room_id, user_id, participation) select $1, unnest($2::uuid[]), 'player'", [roomId, rollers.map((u) => u.id)]);
    const ch = await connect(slug, host);
    const cs = await Promise.all(users.map((u) => connect(slug, u)));
    const all = [ch, ...cs];
    await until(() => {
      for (const c of all) expect(c.state.members.filter((m) => m.connected)).toHaveLength(n);
    }, 20_000);
    ch.send({ type: "update_settings", settings: { lastPlayer: "auto" } });
    await until(() => expect(ch.state.room.settings.lastPlayer).toBe("auto"));
    ch.send({ type: "start" });
    await until(() => expect(ch.state.room.status).toBe("running"));

    const players: Players = new Map(rollers.map((u, i) => [u.id, cs[i]!]));
    const latencies: number[] = [];
    const states = (c: Client) => c.messages.filter((m) => m.type === "state").length;
    for (let step = 0; step < 1000 && ch.state.game.status !== "finished"; step++) {
      const game = ch.state.game;
      const before = all.map(states);
      const started = performance.now();
      if (game.pause) ch.send({ type: "continue" });
      else players.get(game.activeUserId!)!.send({ type: "roll" });
      // One change, one state per socket ("continue" is moderation: players see the state, not the event).
      await until(() => {
        all.forEach((c, i) => expect(states(c)).toBeGreaterThan(before[i]!));
        for (const c of all) expect(c.state.game.activeUserId).toBe(ch.state.game.activeUserId);
      }, 10_000);
      latencies.push(performance.now() - started);
      if (ch.state.game.history.at(-1)?.type === "rolled") await sleep(COOLDOWN + 10);
    }
    for (const c of all) {
      expect(c.state.room.status).toBe("finished");
      expect(c.state.game.giftOrder).toHaveLength(rollers.length);
    }
    latencies.sort((a, b) => a - b);
    const at = (q: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!);
    console.info(`${n} sockets, ${latencies.length} changes: every socket had the new state after median ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms`);
    expect(at(0.95)).toBeLessThan(1000);
    for (const c of all) c.ws.close();
  });
});

