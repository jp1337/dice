// The game over the room WebSocket (spec 4.3 to 4.11, 7, 13, 16) against a real PostgreSQL and a listening
// server: turns, host tools, the roll cooldown, test rooms, public rooms, reactions, restart recovery.
import { randomBytes, randomInt } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/server/auth.js";
import { runCleanup } from "../src/server/cleanup.js";
import { runMigrations } from "../src/server/db/migrate.js";
import { CommandError, type GameCommandContext, handleGameCommand } from "../src/server/game-commands.js";
import { MAX_SIMULATED_PLAYERS } from "../src/shared/constants.js";
import { MAX_GUESTS_PER_IP, MAX_GUESTS_PER_ROOM } from "../src/server/rooms.js";
import { type GameEvent, type Participation, type Settings, defaultSettings } from "../src/shared/contracts.js";
import { reduce } from "../src/shared/game/reduce.js";
import { makeApp, ownDatabase } from "./helpers.js";
import { Client, HOST2_ID, HOST_ID, ORIGIN, type User, env, makeUser as makeUserIn, until } from "./ws.js";

const dbUrl = await ownDatabase();
// The shared app has no roll cooldown (it has its own tests and app) and fast simulated players.
const BOT_DELAY = 30; // injected instead of SIMULATED_ROLL_DELAY_MS
// Dice come from crypto.randomInt unless a test queues values: a test that must not see a 6 says so.
const forcedRandom: number[] = [];
const randomIntForTests = (min: number, maxExclusive: number) => forcedRandom.shift() ?? randomInt(min, maxExclusive);
const timing = { rollCooldownMs: 0, simulatedRollDelayMs: BOT_DELAY, randomInt: randomIntForTests };

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
    room: { game: reduce([], defaultSettings), settings: defaultSettings, members: new Map(members.map(([id, participation]) => [id, { participation }])), lastRollAt: 0 },
    rollCooldownMs: 2000,
    now: 10_000,
    randomInt,
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
    expect(code(() => handleGameCommand(cooling, { type: "roll_for", userId: A }))).toBe("cooldown");
    expect(code(() => handleGameCommand(cooling, { type: "skip", userId: A }))).toBe("ok");
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
  async function watch(slug: string, headers: Record<string, string> = {}, targetPort = port) {
    const client = open(`/ws/rooms/${slug}`, undefined, headers, targetPort); // no session: a guest
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
  const roomIdOf = async (slug: string) => (await pool.query("select id from rooms where slug = $1", [slug])).rows[0].id as string;
  async function listen(app: App) {
    await app.listen({ port: 0, host: "127.0.0.1" });
    return (app.server.address() as AddressInfo).port;
  }

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
      const guest = await watch(slug); // new rooms are public
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
        { type: "roll_for", userId: active },
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
        { type: "skip", userId: first },
        { type: "roll_for", userId: first },
        { type: "remove_player", userId: second },
        { type: "add_player", userId: host.id },
        { type: "assign_last_place" },
        { type: "undo" },
        { type: "end" },
        { type: "reset" },
      ];
      for (const message of hostOnly) player.send(message);
      for (const message of [{ type: "set_public", isPublic: false }, { type: "add_simulated_players", count: 1 }]) player.send(message);
      await until(() => expect(player.errors).toHaveLength(hostOnly.length + 2));
      expect(player.errors).toEqual([...hostOnly.map(() => "not_host"), "forbidden", "forbidden"]);
      expect((await eventsOf(slug)).map((e) => e.type)).toEqual(["game_started"]);
      expect(ch.state.room.isPublic).toBe(true);
    });

    it("refuses rolls during a pause", async () => {
      const { slug, ch, players } = await startGame(2);
      const active = players.get(ch.state.game.activeUserId!)!;
      ch.send({ type: "pause" });
      await until(() => expect(ch.state.game.pause).toBe("host"));
      active.send({ type: "roll" });
      ch.send({ type: "roll_for", userId: ch.state.game.activeUserId });
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
      ch2.send({ type: "skip", userId: ch2.state.game.activeUserId });
      await until(() => expect(ch2.state.game.history.map((e) => e.type)).toEqual(["game_started", "paused", "continued", "skipped"]));
      players.get(ch2.state.game.activeUserId!)!.send({ type: "roll" });
      await until(() => expect(ch2.state.game.lastRoll).not.toBeNull());
      expect(ch2.errors).toEqual([]);
    });

    it("lets two hosts clicking at once skip one player, and refuses a late roll_for (turn_changed)", async () => {
      const { slug, ch } = await startGame(3);
      const ch2 = await connect(slug, host2);
      const active = ch.state.game.activeUserId!;
      ch.send({ type: "skip", userId: active });
      ch2.send({ type: "skip", userId: active });
      await until(() => expect([...ch.errors, ...ch2.errors]).toEqual(["turn_changed"]));
      await until(() => expect(ch.state.game.activeUserId).not.toBe(active));
      ch.send({ type: "roll_for", userId: active }); // clicked before the skip arrived
      await until(() => expect([...ch.errors, ...ch2.errors]).toEqual(["turn_changed", "turn_changed"]));
      expect([...ch.messages, ...ch2.messages].find((m) => m.type === "error")).toMatchObject({ message: "Inzwischen ist jemand anderes dran." });
      expect((await eventsOf(slug)).map((e) => e.type)).toEqual(["game_started", "skipped"]);
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

    it("names simulated players around a member who already shows a Testspieler name", async () => {
      const slug = await newRoom(true);
      const ch = await connect(slug, host);
      await connect(slug, await makeUser("testspieler 1"));
      ch.send({ type: "add_simulated_players", count: 2 });
      await until(() => expect(ch.state.members.filter((m) => m.isSimulated).map((m) => m.displayName)).toEqual(["Testspieler 2", "Testspieler 3"]));
    });

    it("lets simulated players roll by themselves, only on their turn and never in a pause", { timeout: 30_000 }, async () => {
      const { slug, ch, players, users } = await startGame(1, { isTest: true, sims: 2 });
      const real = users[0]!.id;
      const roomId = await roomIdOf(slug);
      // Until the real player's turn comes, the simulated ones roll; then no timer waits for them.
      await until(() => {
        if (ch.state.game.pause) ch.send({ type: "continue" });
        expect(ch.state.game).toMatchObject({ activeUserId: real, pause: null });
      }, 10_000);
      expect(app.live.simulatedTurn(roomId)).toBeNull();
      const before = historyLength(ch);
      players.get(real)!.send({ type: "roll" });
      await until(() => expect(historyLength(ch)).toBeGreaterThan(before));
      const rolls = (await eventsOf(slug)).filter((e) => e.type === "rolled");
      for (const e of rolls) expect(e.actor).toBe(e.payload.userId); // simulated or real: the roller is the actor

      // A host pause stops them.
      if (ch.state.game.status === "running") {
        ch.send({ type: "pause" });
        await until(() => expect(ch.state.game.pause).not.toBeNull());
        expect(app.live.simulatedTurn(roomId)).toBeNull();
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

    it("gives the next simulated player its full delay when a timer fires behind a host's skip", { timeout: 30_000 }, async () => {
      const DELAY = 500;
      const slow = await makeApp(env, dbUrl, { rollCooldownMs: 0, simulatedRollDelayMs: DELAY });
      const slowPort = await listen(slow.app);
      const locker = await pool.connect();
      try {
        const slug = await newRoom(true, slow.app);
        const roomId = await roomIdOf(slug);
        const ch = await connect(slug, host, slowPort);
        ch.send({ type: "add_simulated_players", count: 3 });
        await until(() => expect(ch.state.members.filter((m) => m.isSimulated)).toHaveLength(3));
        ch.send({ type: "start" });
        await until(() => expect(slow.app.live.simulatedTurn(roomId)).not.toBeNull());
        const [first, second] = ch.state.game.turnOrder;
        // The skip waits for the room row inside its transaction while the first player's timer fires.
        await locker.query("begin");
        await locker.query("select 1 from rooms where id = $1 for update", [roomId]);
        ch.send({ type: "skip", userId: first });
        await until(() => expect(slow.app.live.simulatedTurn(roomId)).toBeNull(), 5000); // fired, queued behind the skip
        await locker.query("commit");
        const released = Date.now();
        await until(async () => expect((await eventsOf(slug)).filter((e) => e.type === "rolled")).toHaveLength(1), 10_000);
        const roll = (await eventsOf(slug)).find((e) => e.type === "rolled")!;
        expect(roll.payload.userId).toBe(second);
        expect(roll.created_at.getTime() - released).toBeGreaterThanOrEqual(DELAY - 50); // not at once
      } finally {
        await locker.query("rollback").catch(() => undefined);
        locker.release();
        await slow.app.close();
      }
    });

    it("arms no simulated player for a connection that never joins (a guest refused at the IP limit)", { timeout: 30_000 }, async () => {
      const proxied = await makeApp({ ...env, TRUSTED_PROXIES: "127.0.0.1" }, dbUrl, timing);
      const proxiedPort = await listen(proxied.app);
      try {
        const from = { "x-forwarded-for": "198.51.100.77" };
        const elsewhere = await newRoom(false, proxied.app);
        await Promise.all(Array.from({ length: MAX_GUESTS_PER_IP }, () => watch(elsewhere, from, proxiedPort)));

        // A running test room whose simulated player is due, with nobody connected.
        const slug = await newRoom(true, proxied.app);
        const roomId = await roomIdOf(slug);
        const ch = await connect(slug, host, proxiedPort);
        ch.send({ type: "add_simulated_players", count: 2 });
        await until(() => expect(ch.state.members.filter((m) => m.isSimulated)).toHaveLength(2));
        ch.send({ type: "start" });
        ch.send({ type: "pause" });
        await until(() => expect(ch.state.game.pause).not.toBeNull()); // the host's, or a six's
        await ch.close();
        await until(() => expect(proxied.app.live.roomIds()).not.toContain(roomId));
        await pool.query("insert into game_events (room_id, seq, type, actor_user_id, payload) select $1, max(seq) + 1, 'continued', $2, '{}' from game_events where room_id = $1", [roomId, host.id]);
        const events = (await eventsOf(slug)).length;

        const refused = open(`/ws/rooms/${slug}`, undefined, from, proxiedPort);
        expect((await refused.closed).code).toBe(1008);
        expect(proxied.app.live.roomIds()).toContain(roomId); // loaded for the attempt
        expect(proxied.app.live.simulatedTurn(roomId)).toBeNull();
        expect((await eventsOf(slug)).length).toBe(events);

        const back = await connect(slug, host, proxiedPort); // the first real join lets them go on
        await until(() => expect(historyLength(back)).toBeGreaterThan(events));
      } finally {
        await proxied.app.close();
      }
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

  describe("public room (spec 4.8)", () => {
    it("is public by default; the old guest link path is gone", async () => {
      const slug = await newRoom();
      const ch = await connect(slug, host);
      expect(ch.state.room).toMatchObject({ isPublic: true, guestCount: 0 });
      expect((await app.inject({ url: `/z/${randomBytes(16).toString("base64url")}`, remoteAddress: nextIp() })).statusCode).toBe(404);
    });

    it("shows a read-only guest view: players and places, display names, public history", { timeout: 30_000 }, async () => {
      const { slug, ch, users } = await startGame(3);
      const watcher = await makeUser("Zuschauerin");
      const cw = await connect(slug, watcher);
      expect(cw.state.room.isPublic).toBe(true);
      expect(cw.state.viewer).toMatchObject({ kind: "member" }); // logged in: the member view through the same link
      expect(cw.state.room).not.toHaveProperty("guestCount");

      const foreign = open(`/ws/rooms/${slug}`, undefined, { origin: "https://evil.example" });
      expect((await foreign.closed).code).toBe(1006); // 403 before the upgrade
      const guest = await watch(slug);
      await until(() => expect(ch.state.room.guestCount).toBe(1));
      expect(ch.state.members).toHaveLength(5); // guests are no members
      ch.send({ type: "pause" });
      await until(() => expect(ch.state.game.pause).toBe("host"));
      ch.send({ type: "continue" });
      const rolledFor = ch.state.game.activeUserId!;
      forcedRandom.push(3, 3); // no 6 (also with the bonus die), so the player stays in the game and can be removed
      ch.send({ type: "roll_for", userId: rolledFor });
      await until(() => expect(guest.messages.some((m) => m.type === "rolled")).toBe(true));
      await until(() => expect(ch.state.game.lastRoll?.userId).toBe(rolledFor)); // the host's own state, not the guest's
      expect(ch.state.game.turnOrder).toContain(rolledFor);
      // Removed after the roll: still named in the public history, so guests still see the name.
      ch.send({ type: "remove_player", userId: rolledFor });
      await until(() => expect(ch.member(rolledFor)?.participation).toBe("spectator"));
      await until(() => expect(guest.state.game.removed.length + guest.state.game.giftOrder.length).toBe(1));

      const view = guest.state;
      expect(view.viewer).toEqual({ kind: "guest" });
      expect(view.room).toMatchObject({ slug, isPublic: true }); // the guest came through the room link
      expect(view.room).not.toHaveProperty("guestCount");
      // The players, and the host who rolled for one of them (named in the public history).
      expect(view.members.map((m) => m.userId).sort()).toEqual([...users.map((u) => u.id), host.id].sort());
      expect(view.members.find((m) => m.userId === host.id)).toMatchObject({ displayName: ch.member(host.id)!.displayName, avatarUrl: null });
      expect(view.members.find((m) => m.userId === rolledFor)?.participation).toBe("spectator");
      expect(view.members.some((m) => m.userId === watcher.id)).toBe(false);
      for (const m of view.members) {
        expect(m.avatarUrl).toBeNull();
        expect(m).not.toHaveProperty("discordName");
      }
      expect(view.game.history.map((e) => e.type)).toEqual(["rolled"]);
      const text = JSON.stringify(guest.messages);
      for (const secret of [host.discordId, watcher.discordId, "Zuschauerin", ...users.map((u) => u.discordId), "henrike-", "/avatars/", "paused", "player_removed"]) {
        expect(text).not.toContain(secret);
      }

      // Whatever a guest sends is dropped, without an answer.
      const events = (await eventsOf(slug)).length;
      for (const message of [{ type: "roll" }, { type: "pause" }, { type: "react", emoji: "🎉" }, "kaputt"]) guest.send(message);
      await guest.close(); // the server reads a socket in order: when it sees the close, it has seen the rest
      await until(() => expect(ch.state.room.guestCount).toBe(0));
      expect(guest.messages.filter((m) => m.type === "error" || m.type === "reactions")).toEqual([]);
      expect((await eventsOf(slug)).length).toBe(events);
    });

    it("disconnects guests at once when switched off, keeps members, lets guests in again when switched on", async () => {
      const slug = await newRoom();
      const ch = await connect(slug, host);
      const cu = await connect(slug, await makeUser());
      const guests = [await watch(slug), await watch(slug)];
      await until(() => expect(ch.state.room.guestCount).toBe(2));
      ch.send({ type: "set_public", isPublic: true }); // already on: nothing changes
      ch.send({ type: "set_public", isPublic: false });
      for (const g of guests) expect(await g.closed).toEqual({ code: 4001, reason: "Der Raum ist nicht mehr öffentlich. Melde dich an, um weiter zuzuschauen." });
      await until(() => expect(cu.state.room.isPublic).toBe(false));
      expect(ch.state.room.guestCount).toBe(0);
      expect(cu.ws.readyState).toBe(WebSocket.OPEN);
      expect((await pool.query("select is_public from rooms where slug = $1", [slug])).rows).toEqual([{ is_public: false }]);
      expect((await open(`/ws/rooms/${slug}`).closed).code).toBe(1006); // 401 before the upgrade
      expect((await app.inject({ url: `/api/rooms/${slug}`, remoteAddress: nextIp() })).statusCode).toBe(401);
      ch.send({ type: "set_public", isPublic: true });
      await until(() => expect(ch.state.room.isPublic).toBe(true));
      await watch(slug);
      await until(() => expect(ch.state.room.guestCount).toBe(1));
      expect(ch.state.game.history.map((e) => [e.type, e.payload])).toEqual([
        ["public_changed", { isPublic: false }],
        ["public_changed", { isPublic: true }],
      ]);
    });

    it(`allows ${MAX_GUESTS_PER_IP} guest connections per IP and ${MAX_GUESTS_PER_ROOM} per room`, { timeout: 60_000 }, async () => {
      const proxied = await makeApp({ ...env, TRUSTED_PROXIES: "127.0.0.1" }, dbUrl, timing);
      await proxied.app.listen({ port: 0, host: "127.0.0.1" });
      const proxiedPort = (proxied.app.server.address() as AddressInfo).port;
      try {
        const slug = await newRoom(false, proxied.app);
        const ch = await connect(slug, host, proxiedPort);
        const from = (address: string) => ({ "x-forwarded-for": address });

        const same = await Promise.all(Array.from({ length: MAX_GUESTS_PER_IP }, () => watch(slug, from("198.51.100.1"), proxiedPort)));
        const sixth = open(`/ws/rooms/${slug}`, undefined, from("198.51.100.1"), proxiedPort);
        expect(await sixth.closed).toEqual({ code: 1008, reason: "Zu viele Zuschauer-Verbindungen von deiner Adresse." });
        await same[0]!.close();
        await until(() => expect(ch.state.room.guestCount).toBe(MAX_GUESTS_PER_IP - 1));
        same[0] = await watch(slug, from("198.51.100.1"), proxiedPort); // a freed slot counts again

        const rest = MAX_GUESTS_PER_ROOM - MAX_GUESTS_PER_IP;
        await Promise.all(Array.from({ length: rest }, (_, i) => watch(slug, from(`10.9.${i >> 8}.${i & 255}`), proxiedPort)));
        await until(() => expect(ch.state.room.guestCount).toBe(MAX_GUESTS_PER_ROOM));
        const over = open(`/ws/rooms/${slug}`, undefined, from("192.0.2.200"), proxiedPort);
        expect(await over.closed).toEqual({ code: 1008, reason: "Zu viele Zuschauer in diesem Raum." });
        expect(ch.state.members).toHaveLength(1); // guests never show up as members
      } finally {
        await proxied.app.close();
      }
    });
  });

  describe("client addresses in the log (spec 8.3)", () => {
    it("never logs a full address: requests, failed logins, members and guests from IPv4, IPv6 and mapped IPv4", { timeout: 30_000 }, async () => {
      const proxied = await makeApp({ ...env, TRUSTED_PROXIES: "127.0.0.1" }, dbUrl, timing);
      const proxiedPort = await listen(proxied.app);
      try {
        const slug = await newRoom(false, proxied.app);
        const cases = [
          { address: "198.51.100.23", short: "198.51.0.0", leaks: ["198.51.100.23"] },
          { address: "2001:db8:abcd:12::7", short: "2001:db8:abcd::", leaks: ["2001:db8:abcd:12", ":12::7"] },
          { address: "::ffff:203.0.113.45", short: "203.0.0.0", leaks: ["203.0.113.45"] },
        ];
        for (const { address, short, leaks } of cases) {
          const from = { "x-forwarded-for": address };
          proxied.logs.length = 0;
          await proxied.app.inject({ url: "/robots.txt", headers: from });
          await proxied.app.inject({ url: "/%zz", remoteAddress: address }); // frameworkErrors: Fastify ignores TRUSTED_PROXIES there
          await proxied.app.inject({ url: "/auth/callback", headers: from }); // login failed
          const member = open(`/ws/rooms/${slug}`, host2, from, proxiedPort);
          await until(() => member.state);
          await member.close();
          await (await watch(slug, from, proxiedPort)).close();
          await until(() => expect(proxied.logs.map((l) => l.msg)).toEqual(expect.arrayContaining(["login failed", "ws closed", "guest connected", "guest closed"])));

          const ips = proxied.logs.filter((l) => "ip" in l).map((l) => l.ip);
          expect(ips.length, address).toBeGreaterThanOrEqual(5); // three requests, the login, the guest
          expect(new Set(ips), address).toEqual(new Set([short]));
          const text = JSON.stringify(proxied.logs);
          for (const leak of leaks) expect(text, address).not.toContain(leak);
        }
      } finally {
        await proxied.app.close();
      }
    });
  });

  describe("reactions (spec 4.11)", () => {
    const reactionsOf = (c: Client) => {
      const counts: Record<string, number> = {};
      for (const m of c.messages) if (m.type === "reactions") for (const { emoji, count } of m.emojis) counts[emoji] = (counts[emoji] ?? 0) + count;
      return counts;
    };

    it("bundles reactions for members and guests, never stores them, the active player's too", async () => {
      const { slug, ch, players } = await startGame(2);
      const active = ch.state.game.activeUserId!;
      const [other] = [...players].filter(([id]) => id !== active).map(([, c]) => c);
      const guest = await watch(slug); // new rooms are public
      const events = (await eventsOf(slug)).length;

      players.get(active)!.send({ type: "react", emoji: "🎉" });
      ch.send({ type: "react", emoji: "🎉" });
      other!.send({ type: "react", emoji: "🎉" });
      other!.send({ type: "react", emoji: "😂" }); // within the cooldown: refused
      await until(() => expect(other!.errors).toEqual(["reaction_too_fast"]));
      // Counted per emoji, however the two land in bundles (usually one).
      for (const c of [ch, guest, other!]) {
        await until(() => expect(reactionsOf(c)).toEqual({ "🎉": 3 }));
        expect(c.messages.filter((m) => m.type === "reactions").length).toBeLessThanOrEqual(2);
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
      // Switched on again, one reaction gets through, and only that one was ever counted.
      ch.send({ type: "update_settings", settings: { reactions: true } });
      await until(() => expect(cu.state.room.settings.reactions).toBe(true));
      ch.send({ type: "react", emoji: "👏" });
      await until(() => expect(reactionsOf(cu)).toEqual({ "👏": 1 }));
    });
  });

  describe("roll cooldown (spec 7)", () => {
    it("refuses a roll within the cooldown, also after the room was read again or the server restarted", { timeout: 30_000 }, async () => {
      const LONG = { rollCooldownMs: 60_000 };
      const first = await makeApp(env, dbUrl, LONG);
      const second = await makeApp(env, dbUrl, LONG);
      let firstOpen = true;
      try {
        const firstPort = await listen(first.app);
        const slug = await newRoom(false, first.app);
        const roomId = await roomIdOf(slug);
        let ch = await connect(slug, host, firstPort);
        const players = await Promise.all([makeUser(), makeUser()]);
        const cs = await Promise.all(players.map((u) => connect(slug, u, firstPort)));
        ch.send({ type: "start" });
        await until(() => expect(ch.state.room.status).toBe("running"));
        ch.send({ type: "roll_for", userId: ch.state.game.activeUserId });
        await until(() => expect(ch.state.game.lastRoll).not.toBeNull());
        if (ch.state.game.pause) ch.send({ type: "continue" });
        await until(() => expect(ch.state.game.pause).toBeNull());
        const next = ch.state.game.activeUserId!;
        const tryRoll = async (c: Client) => {
          const errors = c.errors.length;
          c.send({ type: "roll_for", userId: next });
          await until(() => expect(c.errors.length).toBeGreaterThan(errors));
          return c.errors.at(-1);
        };
        expect(await tryRoll(ch)).toBe("cooldown");
        expect(ch.messages.findLast((m) => m.type === "error")).toMatchObject({ message: "Der Würfel rollt noch. Bitte warte einen Moment." });

        // Everyone leaves: the room is dropped from memory and read again.
        for (const c of [ch, ...cs]) await c.close();
        await until(() => expect(first.app.live.roomIds()).not.toContain(roomId));
        ch = await connect(slug, host, firstPort);
        expect(await tryRoll(ch)).toBe("cooldown");

        // A restart: another app reads the room from the database.
        await first.app.close();
        firstOpen = false;
        const secondPort = await listen(second.app);
        let again = await connect(slug, host, secondPort);
        expect(await tryRoll(again)).toBe("cooldown");

        // The time comes from the stored roll: one an hour old no longer holds anything back.
        await again.close();
        await until(() => expect(second.app.live.roomIds()).not.toContain(roomId));
        await pool.query("update game_events set created_at = now() - interval '1 hour' where room_id = $1", [roomId]);
        again = await connect(slug, host, secondPort);
        again.send({ type: "roll_for", userId: next });
        await until(() => expect(again.state.game.lastRoll?.userId).toBe(next));
        expect(again.errors).toEqual([]);
      } finally {
        if (firstOpen) await first.app.close();
        await second.app.close();
      }
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
        await until(async () => {
          const game = again.state.game;
          if (game.pause) again.send({ type: "continue" }); // also after the real player's own six, or the game waits forever
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
    }
    for (const c of all) {
      expect(c.state.room.status).toBe("finished");
      expect(c.state.game.giftOrder).toHaveLength(rollers.length);
    }
    latencies.sort((a, b) => a - b);
    const at = (q: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!);
    console.info(`${n} sockets, ${latencies.length} changes: every socket had the new state after median ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms`);
    expect(at(0.95)).toBeLessThan(5000); // a generous bound against hangs; the log line is the measurement
    for (const c of all) c.ws.close();
  });
});

