// Rooms, lobby, the game and the room and guest WebSockets (spec 4.2 to 4.11, 7, 8.1).
// A room with connections (members or guests) lives in memory, read from room_members and game_events
// (reduce) on the first join and dropped when its last socket closes. Every change runs in that room's
// queue: database first, then memory, then one coalesced `state` per audience, then `rolled`.
import { randomBytes, randomUUID } from "node:crypto";
import { type SQL, and, asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type ClientMessage,
  type CreateRoomResponse,
  type GameEvent,
  type GameState,
  type GameStatus,
  type MemberView,
  type Participation,
  type RoomSummary,
  type RoomView,
  type ServerMessage,
  type Settings,
  REACTION_INTERVAL_MS,
  clientMessageSchema,
  createRoomRequestSchema,
  defaultSettings,
  eventVisibility,
  patchMeRequestSchema,
} from "../shared/contracts.js";
import { reduce } from "../shared/game/reduce.js";
import type { LiveRooms } from "./cleanup.js";
import type { Config } from "./config.js";
import { logIp } from "./log-ip.js";
import { gameEvents, roomMembers, rooms, users } from "./db/schema.js";
import { CommandError, type NewEvent, handleGameCommand } from "./game-commands.js";

export const CREATE_ROOM_LIMIT_PER_MINUTE = 10;
export const NICKNAME_LIMIT_PER_MINUTE = 10;
// One budget per person and room, shared by all their sockets; a connect costs one message.
export const MESSAGES_PER_SECOND = 10;
export const MESSAGE_BURST = 20;
export const MAX_STRIKES = 10; // rate-limited messages in a row before the socket is closed
export const MAX_SOCKETS_PER_USER = 5; // per room
// Joins and leaves reach the others batched (see changed()); other changes go out when the queue is idle.
export const PRESENCE_DELAY_MS = 300;
export const PRESENCE_MAX_WAIT_MS = 2000;
const BUSY_DELAY_MS = 100; // the longest a change waits for a busy queue
export const SIMULATED_ROLL_DELAY_MS = 3000; // spec 4.7: "etwa 3 Sekunden nachdem sie dran sind"
export const MAX_SIMULATED_PLAYERS = 30; // per room (spec 4.7)
export const MAX_GUESTS_PER_ROOM = 200; // spec 4.8
export const MAX_GUESTS_PER_IP = 5; // guest connections per IP, over all rooms (spec 4.8)
export const GUEST_CONNECTS_PER_MINUTE = 60; // per IP, requests without a session; the room lookup touches the database
export const REACTION_BUNDLE_MS = 250; // reactions reach everyone bundled, at most this often (spec 4.11)

declare module "fastify" {
  interface FastifyInstance {
    // For the cleanup (spec 9.3), which must not delete what is in use. simulatedTurn: the turn a
    // simulated player's timer is armed for, null if none (tests).
    live: LiveRooms & { simulatedTurn(roomId: string): string | null };
  }
}

// The part of a `ws` WebSocket used here (@fastify/websocket hands one to the route).
export type Socket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: (code: number) => void): void;
};
const OPEN = 1;

// Close codes and the German reason the client may show; the key is what the log says.
const CLOSE = {
  "too many tabs": [1008, "Zu viele offene Tabs in diesem Raum."],
  "rate limit": [1008, "Zu viele Nachrichten."],
  "room gone": [4004, "Raum existiert nicht mehr."],
  "reload failed": [1012, "Der Raum wird neu geladen. Bitte verbinde dich neu."],
  retry: [1013, "Bitte verbinde dich neu."],
  "join failed": [1011, "Beitritt fehlgeschlagen."],
  "logged out": [4001, "Du hast dich abgemeldet. Melde dich wieder an, um weiterzumachen."],
  "session expired": [4001, "Sitzung abgelaufen. Bitte melde dich neu an."],
  "not public": [4001, "Der Raum ist nicht mehr öffentlich. Melde dich an, um weiter zuzuschauen."],
  "too many guests": [1008, "Zu viele Zuschauer in diesem Raum."],
  "too many guest connections": [1008, "Zu viele Zuschauer-Verbindungen von deiner Adresse."],
} as const;
type CloseReason = keyof typeof CLOSE;

const userColumns = {
  userId: users.id,
  discordId: users.discordId,
  username: users.username,
  displayName: users.displayName,
  nickname: users.nickname,
  avatarHash: users.avatarHash,
  isSimulated: users.isSimulated,
};
export type Member = {
  userId: string;
  discordId: string | null;
  username: string;
  displayName: string; // from Discord: server nickname, else global name (spec 4.10)
  nickname: string | null; // own nickname, wins over displayName
  avatarHash: string | null;
  isSimulated: boolean;
  participation: Participation;
  isCohost: boolean;
};

// What the database holds about a room, as reduce sees it.
type RoomData = {
  id: string;
  slug: string;
  name: string;
  isTest: boolean;
  settings: Settings;
  isPublic: boolean;
  members: Map<string, Member>; // insertion order = join order
  events: GameEvent[];
  game: GameState;
};

export type Audience = "host" | "moderator" | "member" | "guest";

export type Room = RoomData & {
  sockets: Map<string, Set<Socket>>; // joined sockets per user; several tabs are several sockets
  guests: Set<Socket>; // anonymous guests (spec 4.8): no members, no presence
  after: string[]; // sent to every socket right after the next state flush (`rolled`)
  lastRollAt: number; // for the roll cooldown (spec 7); 0 after a load
  botTimer: NodeJS.Timeout | null; // the next roll of the active simulated player (spec 4.7)
  botKey: string | null; // the turn botTimer was armed for
  reactions: Map<string, number>; // emoji counts waiting for the next bundle (spec 4.11)
  reactionTimer: NodeJS.Timeout | null;
  lastReaction: Map<string, number>; // by user id
  queue: Promise<unknown>;
  tasks: number; // queued or running
  version: number; // raised by every change a view shows
  rendered: Map<Audience, { version: number; body: string }>;
  urgent: boolean; // a change waits to be sent
  timer: NodeJS.Timeout | null; // the latest send of a waiting change
  flushBy: number;
  dirtySince: number; // when the waiting batch started
  evicted: boolean; // dropped from memory; its tasks refuse to run
};

// One open socket. userId null: a guest; ip is set once it counts against MAX_GUESTS_PER_IP.
type Conn = { userId: string | null; sessionId: string; expiresAt: number; alive: boolean; reason?: string; version: number; ip?: string };
type Bucket = { tokens: number; at: number; strikes: number };

type Db = NodePgDatabase;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const fail = (code: string, german: string) => new CommandError(code, german);
const forbidden = () => fail("forbidden", "Dazu fehlt dir die Berechtigung.");
class Evicted extends Error {}
class RoomGone extends Error {}

// Spec 4.6, 4.11: switching reactions off is a host tool during the game too; the rules are fixed at the start.
export function checkSettingsChange(status: GameStatus, settings: Partial<Settings>) {
  if (status !== "lobby" && Object.keys(settings).some((key) => key !== "reactions")) {
    throw fail("not_in_lobby", "Während des Spiels lassen sich nur die Reaktionen umschalten.");
  }
}

// The user ids an event payload or the last roll names.
const idsIn = (p: unknown): string[] => {
  if (!p || typeof p !== "object") return [];
  const { userId, rolledBy, actor } = p as { userId?: unknown; rolledBy?: unknown; actor?: unknown };
  return [userId, rolledBy, actor].filter((id): id is string => typeof id === "string");
};

// The cooldown survives a reload (restart, eviction): the time of the last roll still in effect.
const lastRollAtOf = (game: GameState) => {
  const roll = game.history.findLast((e) => e.type === "rolled" && !game.undoneSeqs.includes(e.seq));
  return roll ? Date.parse(roll.createdAt) : 0;
};

// The room as one audience may see it (spec 4.5, 4.8, 4.10), without the per-socket `viewer`.
export function roomView(room: RoomData & Pick<Room, "sockets" | "guests">, audience: Audience, config: Config): Omit<RoomView, "viewer"> {
  const isHostMember = (m: Member) => m.discordId !== null && config.hostDiscordIds.includes(m.discordId);
  const guest = audience === "guest";
  const canModerate = audience === "host" || audience === "moderator";
  const history = room.game.history.filter((e) => canModerate || eventVisibility[e.type] === "public");
  // Guests see players, people with a place, and whoever the public history or the last roll names
  // (a host who rolled for someone, a removed player's rolls): by display name, like everyone.
  const named = [room.game.lastRoll, ...history.map((e) => ({ ...e.payload, actor: e.actorUserId }))].flatMap(idsIn);
  const shown = new Set([...room.game.giftOrder, ...named]);
  const members = [...room.members.values()]
    .filter((m) => !guest || m.participation === "player" || shown.has(m.userId))
    .map(
      (m): MemberView => ({
        userId: m.userId,
        displayName: m.nickname ?? m.displayName,
        ...(audience === "host" && { discordName: m.username }),
        ...(canModerate && { hasNickname: m.nickname !== null }),
        avatarUrl: !guest && m.avatarHash ? `/avatars/${m.userId}/${m.avatarHash}` : null,
        participation: m.participation,
        isHost: isHostMember(m),
        isCohost: m.isCohost,
        isSimulated: m.isSimulated,
        connected: m.isSimulated || (room.sockets.get(m.userId)?.size ?? 0) > 0, // simulated players are run by the server
      }),
    );
  return {
    room: {
      slug: room.slug,
      name: room.name,
      isTest: room.isTest,
      status: room.game.status,
      settings: room.settings,
      isPublic: room.isPublic,
      ...(canModerate && { guestCount: room.guests.size }),
    },
    members,
    game: { ...room.game, history },
  };
}

export function registerRooms(
  app: FastifyInstance,
  config: Config,
  db: Db,
  auth: {
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    loadUser: (request: FastifyRequest) => Promise<unknown>;
    onSessionEnd: (listener: (sessionId: string) => void) => void;
  },
  timing: { pingIntervalMs: number; rollCooldownMs: number; simulatedRollDelayMs: number; randomInt: (min: number, maxExclusive: number) => number },
) {
  const isHostId = (discordId: string | null) => discordId !== null && config.hostDiscordIds.includes(discordId);
  const audienceOf = (m: Member): Audience => (isHostId(m.discordId) ? "host" : m.isCohost ? "moderator" : "member");
  const sameOrigin = async (request: FastifyRequest, reply: FastifyReply) => {
    // CSRF for cookie-authenticated writes and WebSocket upgrades: browsers always send Origin there.
    if (request.headers.origin !== config.baseUrl.origin) return reply.code(403).send({ error: "forbidden" });
  };

  const live = new Map<string, Room>(); // by slug; only rooms with sockets or a join on its way
  const loading = new Map<string, Promise<Room | null>>();
  const conns = new Map<Socket, Conn>();
  const buckets = new Map<string, Bucket>(); // by room id and user id
  const guestsPerIp = new Map<string, number>();

  app.decorate("live", {
    roomIds: () => [...live.values()].map((room) => room.id),
    userIds: () => [...new Set([...conns.values()].flatMap((conn) => (conn.userId === null ? [] : [conn.userId])))],
    simulatedTurn: (roomId: string) => [...live.values()].find((room) => room.id === roomId)?.botKey ?? null,
  });

  // ---------------------------------------------------------------------------------------------
  // Registry

  async function read(where: SQL): Promise<RoomData | null> {
    const [row] = await db.select().from(rooms).where(where);
    if (!row) return null;
    const [memberRows, eventRows] = await Promise.all([
      db
        .select({ ...userColumns, participation: roomMembers.participation, isCohost: roomMembers.isCohost })
        .from(roomMembers)
        .innerJoin(users, eq(users.id, roomMembers.userId))
        .where(eq(roomMembers.roomId, row.id))
        .orderBy(asc(roomMembers.joinedAt), asc(users.id)),
      db.select().from(gameEvents).where(eq(gameEvents.roomId, row.id)).orderBy(asc(gameEvents.seq)),
    ]);
    const events = eventRows.map(
      (e) => ({ seq: e.seq, type: e.type, actorUserId: e.actorUserId, payload: e.payload, createdAt: e.createdAt.toISOString() }) as GameEvent,
    );
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      isTest: row.isTest,
      settings: row.settings,
      isPublic: row.isPublic,
      members: new Map(memberRows.map((m) => [m.userId, m])),
      events,
      game: reduce(events, row.settings),
    };
  }

  function getRoom(slug: string): Promise<Room | null> {
    const room = live.get(slug);
    if (room) return Promise.resolve(room);
    let pending = loading.get(slug);
    if (!pending) {
      pending = read(eq(rooms.slug, slug))
        .then((data) => {
          if (!data) return null;
          const loaded: Room = {
            ...data,
            sockets: new Map(),
            guests: new Set(),
            after: [],
            lastRollAt: lastRollAtOf(data.game),
            botTimer: null,
            botKey: null,
            reactions: new Map(),
            reactionTimer: null,
            lastReaction: new Map(),
            queue: Promise.resolve(),
            tasks: 0,
            version: 0,
            rendered: new Map(),
            urgent: false,
            timer: null,
            flushBy: 0,
            dirtySince: 0,
            evicted: false,
          };
          live.set(slug, loaded); // simulated players go on with the first join (schedule)
          return loaded;
        })
        .finally(() => loading.delete(slug));
      loading.set(slug, pending);
    }
    return pending;
  }

  function closeSocket(socket: Socket, reason: CloseReason) {
    const conn = conns.get(socket);
    if (conn) conn.reason = reason;
    const [code, text] = CLOSE[reason];
    socket.close(code, text);
  }

  function* socketsOf(room: Room) {
    for (const sockets of room.sockets.values()) yield* sockets;
    yield* room.guests;
  }
  const idle = (room: Room) => room.tasks === 0 && room.sockets.size === 0 && room.guests.size === 0;

  function stopTimers(room: Room) {
    for (const timer of [room.timer, room.botTimer, room.reactionTimer]) if (timer) clearTimeout(timer);
    room.timer = room.botTimer = room.reactionTimer = null;
  }

  // Drops the room from memory; the next join reads it again. Its sockets reconnect, if any are left.
  function dispose(room: Room, reason: CloseReason = "retry") {
    if (room.evicted) return;
    room.evicted = true;
    if (live.get(room.slug) === room) live.delete(room.slug);
    stopTimers(room);
    for (const socket of socketsOf(room)) closeSocket(socket, reason);
  }

  // After an unexpected failure memory may differ from the database (e.g. a COMMIT whose reply was lost):
  // read the room again instead of computing the next seq from stale memory forever.
  async function recover(room: Room, cause: unknown) {
    app.log.error({ err: cause, roomId: room.id }, "room change failed, reading the room again");
    try {
      const data = await read(eq(rooms.id, room.id));
      if (!data) return dispose(room, "room gone");
      if ([...room.sockets.keys()].some((userId) => !data.members.has(userId))) throw new Error("a connected member is missing");
      Object.assign(room, data);
      changed(room, true);
      schedule(room);
    } catch (err) {
      app.log.error({ err, roomId: room.id }, "reading the room again failed");
      dispose(room, "reload failed");
    }
  }

  function run<T>(room: Room, task: () => Promise<T>): Promise<T> {
    room.tasks++;
    const result = room.queue.then(async () => {
      try {
        if (room.evicted) throw new Evicted();
        return await task();
      } catch (err) {
        if (err instanceof RoomGone) dispose(room, "room gone");
        else if (!(err instanceof CommandError || err instanceof Evicted)) await recover(room, err);
        throw err;
      } finally {
        room.tasks--;
        if (!room.evicted && room.tasks === 0) {
          if (idle(room)) dispose(room);
          else if (room.urgent) flush(room);
        }
      }
    });
    room.queue = result.catch(() => undefined);
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // State: rendered once per audience and version, shared by every socket of that audience.

  const send = (socket: Socket, text: string) => socket.readyState === OPEN && socket.send(text);

  function sendState(room: Room, socket: Socket, conn: Conn) {
    const member = conn.userId === null ? null : room.members.get(conn.userId)!;
    const audience = member ? audienceOf(member) : "guest";
    let rendered = room.rendered.get(audience);
    if (rendered?.version !== room.version) {
      rendered = { version: room.version, body: JSON.stringify(roomView(room, audience, config)).slice(1) };
      room.rendered.set(audience, rendered);
    }
    const viewer: RoomView["viewer"] = member
      ? { kind: "member", userId: member.userId, isHost: audience === "host", canModerate: audience !== "member" }
      : { kind: "guest" };
    send(socket, `{"type":"state","state":{"viewer":${JSON.stringify(viewer)},${rendered.body}}`);
    conn.version = room.version;
  }

  // Every socket gets the newest state first, then what waited for it: no client sees `rolled` before
  // the state that holds the roll.
  function flush(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    room.urgent = false;
    if (room.evicted) return;
    for (const socket of socketsOf(room)) {
      const conn = conns.get(socket);
      if (conn && conn.version !== room.version) sendState(room, socket, conn);
    }
    for (const text of room.after.splice(0)) for (const socket of socketsOf(room)) send(socket, text);
  }

  // urgent: sent as soon as the queue is idle, at most BUSY_DELAY_MS late. Else (presence) debounced:
  // PRESENCE_DELAY_MS after the last join or leave, at most PRESENCE_MAX_WAIT_MS after the first.
  function changed(room: Room, urgent: boolean) {
    room.version++;
    const now = Date.now();
    if (!room.timer) room.dirtySince = now;
    let at = urgent ? now + BUSY_DELAY_MS : Math.min(now + PRESENCE_DELAY_MS, room.dirtySince + PRESENCE_MAX_WAIT_MS);
    if (room.timer && (urgent || room.urgent)) at = Math.min(at, room.flushBy);
    room.urgent ||= urgent;
    if (room.timer) clearTimeout(room.timer);
    room.flushBy = at;
    room.timer = setTimeout(() => flush(room), at - now);
  }

  // Runs inside the room queue. Rules that reject the new events throw before anything is written.
  async function commit(room: Room, change: { events?: NewEvent[]; settings?: Settings; write?: (tx: Tx) => Promise<unknown>; apply?: () => void }) {
    const settings = change.settings ?? room.settings;
    const now = new Date();
    const last = room.events.at(-1)?.seq ?? 0;
    const added = (change.events ?? []).map((e, i) => ({ ...e, seq: last + i + 1, createdAt: now.toISOString() }) as GameEvent);
    const events = [...room.events, ...added];
    const game = reduce(events, settings);
    await db.transaction(async (tx) => {
      // First: locks the room row against the cleanup, and finds out whether the room still exists.
      const [kept] = await tx.update(rooms).set({ lastActivityAt: now, status: game.status, settings }).where(eq(rooms.id, room.id)).returning({ id: rooms.id });
      if (!kept) throw new RoomGone();
      if (added.length > 0) {
        await tx.insert(gameEvents).values(added.map((e) => ({ roomId: room.id, seq: e.seq, type: e.type, actorUserId: e.actorUserId, payload: e.payload, createdAt: now })));
      }
      await change.write?.(tx);
    });
    change.apply?.();
    Object.assign(room, { events, game, settings });
    for (const e of added) {
      if (e.type !== "rolled") continue;
      room.lastRollAt = Date.now();
      const { userId, dice, rolledBy } = e.payload;
      const rolled: ServerMessage = { type: "rolled", userId, dice, ...(rolledBy && { rolledBy }) };
      room.after.push(JSON.stringify(rolled));
    }
    changed(room, true);
    schedule(room);
  }

  // ---------------------------------------------------------------------------------------------
  // Simulated players (spec 4.7): the room arms one timer for the active simulated player while the
  // game runs unpaused. It rolls through handleGameCommand and commit exactly like a real roll.

  // The turn a timer is for: any event in between (skip, undo, removal) makes it another turn.
  const turnOf = (room: Room) => `${room.game.activeUserId}:${room.game.history.length}`;

  function schedule(room: Room) {
    const { game } = room;
    const active = game.activeUserId;
    const due = !room.evicted && game.status === "running" && !game.pause && active !== null && room.members.get(active)?.isSimulated === true;
    const key = due ? turnOf(room) : null;
    if (key !== null && key === room.botKey) return; // armed for this turn already
    if (room.botTimer) clearTimeout(room.botTimer);
    room.botTimer = null;
    room.botKey = key;
    if (key === null) return;
    const wait = Math.max(timing.simulatedRollDelayMs, room.lastRollAt + timing.rollCooldownMs - Date.now());
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      room.botKey = null;
      run(room, () => simulatedRoll(room, key)).catch((err) => err instanceof Evicted || app.log.error({ err, roomId: room.id }, "simulated roll failed"));
    }, wait);
  }

  async function simulatedRoll(room: Room, key: string) {
    const active = room.game.activeUserId;
    try {
      // Something happened while the timer waited in the queue: the new turn gets its own full delay.
      if (turnOf(room) !== key || !active) return;
      const ctx = { actor: { userId: active, canModerate: false }, room, rollCooldownMs: timing.rollCooldownMs, now: Date.now(), randomInt: timing.randomInt };
      const { events } = handleGameCommand(ctx, { type: "roll" });
      await commit(room, { events }); // actor: the simulated player, as for a real roll
    } catch (err) {
      if (!(err instanceof CommandError)) throw err; // paused or cooling down: schedule decides
    } finally {
      schedule(room);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Reactions (spec 4.11): never stored; counted per emoji, sent bundled to members and guests.

  type Reactions = Extract<ServerMessage, { type: "reactions" }>;
  function sendReactions(room: Room) {
    room.reactionTimer = null;
    const message: Reactions = { type: "reactions", emojis: [...room.reactions].map(([emoji, count]) => ({ emoji, count })) as Reactions["emojis"] };
    room.reactions.clear();
    const text = JSON.stringify(message);
    for (const socket of socketsOf(room)) send(socket, text);
  }

  // A changed nickname shows in every room in memory the user belongs to.
  function refreshUser(userId: string, except?: Room) {
    for (const room of live.values()) {
      if (room === except || !room.members.has(userId)) continue;
      run(room, async () => {
        const [user] = await db.select(userColumns).from(users).where(eq(users.id, userId));
        if (user) Object.assign(room.members.get(userId)!, user);
        changed(room, true);
      }).catch((err) => err instanceof Evicted || app.log.error({ err, userId }, "refreshing a member failed"));
    }
  }

  // Token bucket per person and room (spec 8.3).
  function take(roomId: string, userId: string) {
    const key = `${roomId}:${userId}`;
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: MESSAGE_BURST, at: now, strikes: 0 };
    buckets.set(key, bucket);
    bucket.tokens = Math.min(MESSAGE_BURST, bucket.tokens + ((now - bucket.at) / 1000) * MESSAGES_PER_SECOND);
    bucket.at = now;
    if (bucket.tokens < 1) return { ok: false, strikes: ++bucket.strikes };
    bucket.tokens -= 1;
    bucket.strikes = 0;
    return { ok: true, strikes: 0 };
  }

  // ---------------------------------------------------------------------------------------------
  // Join and leave (spec 4.2, 4.9)

  async function join(room: Room, socket: Socket, conn: Conn & { userId: string }) {
    if (socket.readyState !== OPEN) return; // closed while waiting in the queue
    const { userId } = conn;
    if ((room.sockets.get(userId)?.size ?? 0) >= MAX_SOCKETS_PER_USER) return closeSocket(socket, "too many tabs");
    const [[user], [kept]] = await Promise.all([
      db.select(userColumns).from(users).where(eq(users.id, userId)),
      db.update(rooms).set({ lastActivityAt: new Date() }).where(eq(rooms.id, room.id)).returning({ id: rooms.id }),
    ]);
    if (!kept) throw new RoomGone();
    if (!user) throw new Error("user vanished");
    const member = room.members.get(userId);
    if (member) {
      Object.assign(member, user); // name or avatar may have changed at the last login; the rest stays
    } else {
      // Spec 4.2: players in the lobby, spectators once a game has started.
      const participation: Participation = room.game.status === "lobby" ? "player" : "spectator";
      await db.insert(roomMembers).values({ roomId: room.id, userId, participation }).onConflictDoNothing();
      room.members.set(userId, { ...user, participation, isCohost: false });
    }
    if (socket.readyState !== OPEN) return;
    room.sockets.set(userId, (room.sockets.get(userId) ?? new Set()).add(socket));
    schedule(room); // a game that ran before a restart or an eviction goes on
    changed(room, false); // the others learn about it batched
    sendState(room, socket, conn); // the newcomer at once
  }

  async function leave(room: Room, userId: string, socket: Socket) {
    const sockets = room.sockets.get(userId);
    if (!sockets?.delete(socket)) return;
    if (sockets.size === 0) {
      room.sockets.delete(userId);
      changed(room, false);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Messages (spec 7)

  async function handle(room: Room, actorId: string, message: ClientMessage) {
    const actor = room.members.get(actorId)!;
    const isHost = isHostId(actor.discordId);
    const canModerate = isHost || actor.isCohost;
    const target = (userId: string) => {
      const member = room.members.get(userId);
      if (!member) throw fail("unknown_member", "Diese Person ist nicht in diesem Raum.");
      return member;
    };
    const lobbyOnly = () => {
      if (room.game.status !== "lobby") throw fail("not_in_lobby", "Das geht nur in der Lobby.");
    };
    const testRoomOnly = () => {
      if (!room.isTest) throw fail("not_test_room", "Simulierte Mitspieler gibt es nur in Testräumen.");
    };
    const memberRow = (userId: string) => and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId));

    switch (message.type) {
      case "set_participation": {
        if (message.userId !== actorId && !canModerate) throw forbidden();
        lobbyOnly();
        const member = target(message.userId);
        const { participation } = message;
        if (member.participation === participation) return;
        return commit(room, {
          events: [{ type: "participation_changed", actorUserId: actorId, payload: { userId: member.userId, participation } }],
          write: (tx) => tx.update(roomMembers).set({ participation }).where(memberRow(member.userId)),
          apply: () => (member.participation = participation),
        });
      }
      case "update_settings": {
        if (!canModerate) throw forbidden();
        checkSettingsChange(room.game.status, message.settings);
        return commit(room, { settings: { ...room.settings, ...message.settings } });
      }
      case "set_cohost": {
        if (!isHost) throw forbidden(); // co-hosts cannot appoint co-hosts (spec 4.2)
        const member = target(message.userId);
        if (member.isSimulated) throw fail("invalid_target", "Simulierte Mitspieler können nicht Co-Host werden.");
        if (isHostId(member.discordId)) throw fail("invalid_target", "Hosts sind in jedem Raum Host und lassen sich nicht ändern.");
        const { isCohost } = message;
        if (member.isCohost === isCohost) return;
        return commit(room, {
          events: [{ type: "cohost_changed", actorUserId: actorId, payload: { userId: member.userId, isCohost } }],
          write: (tx) => tx.update(roomMembers).set({ isCohost }).where(memberRow(member.userId)),
          apply: () => (member.isCohost = isCohost),
        });
      }
      case "reset_nickname": {
        if (!canModerate) throw forbidden();
        const member = target(message.userId);
        if (member.nickname === null) return;
        await commit(room, {
          events: [{ type: "nickname_reset", actorUserId: actorId, payload: { userId: member.userId } }],
          write: (tx) => tx.update(users).set({ nickname: null }).where(eq(users.id, member.userId)),
          apply: () => (member.nickname = null),
        });
        return refreshUser(member.userId, room);
      }
      case "react": {
        if (!room.settings.reactions) throw fail("reactions_off", "Reaktionen sind in diesem Raum abgeschaltet.");
        if (room.game.activeUserId === actorId) throw fail("active_player", "Wer dran ist, kann nicht reagieren.");
        const now = Date.now();
        if (now < (room.lastReaction.get(actorId) ?? -Infinity) + REACTION_INTERVAL_MS) throw fail("reaction_too_fast", "Höchstens eine Reaktion alle 2 Sekunden.");
        room.lastReaction.set(actorId, now);
        room.reactions.set(message.emoji, (room.reactions.get(message.emoji) ?? 0) + 1);
        room.reactionTimer ??= setTimeout(() => sendReactions(room), REACTION_BUNDLE_MS);
        return;
      }
      case "add_simulated_players": {
        if (!canModerate) throw forbidden();
        testRoomOnly();
        lobbyOnly();
        const taken = new Set([...room.members.values()].filter((m) => m.isSimulated).map((m) => m.username));
        if (taken.size + message.count > MAX_SIMULATED_PLAYERS)
          throw fail("too_many_simulated", `Höchstens ${MAX_SIMULATED_PLAYERS} simulierte Mitspieler pro Raum.`);
        const added: Member[] = [];
        for (let n = 1; added.length < message.count; n++) {
          const name = `Testspieler ${n}`; // unique within the room (spec 4.7)
          if (taken.has(name)) continue;
          added.push({ userId: randomUUID(), discordId: null, username: name, displayName: name, nickname: null, avatarHash: null, isSimulated: true, participation: "player", isCohost: false });
        }
        return commit(room, {
          events: [{ type: "simulated_players_changed", actorUserId: actorId, payload: { added: added.map((m) => m.userId), removed: [] } }],
          write: async (tx) => {
            await tx.insert(users).values(added.map((m) => ({ id: m.userId, username: m.username, displayName: m.displayName, isSimulated: true })));
            // joined_at a microsecond apart: a reload lists them in the same order as memory.
            await tx.insert(roomMembers).values(
              added.map((m, i) => ({ roomId: room.id, userId: m.userId, participation: "player" as const, joinedAt: sql`now() + ${i} * interval '1 microsecond'` })),
            );
          },
          apply: () => added.forEach((m) => room.members.set(m.userId, m)),
        });
      }
      case "remove_simulated_player": {
        if (!canModerate) throw forbidden();
        testRoomOnly();
        lobbyOnly();
        const member = target(message.userId);
        if (!member.isSimulated) throw fail("invalid_target", "Das ist kein simulierter Mitspieler.");
        return commit(room, {
          events: [{ type: "simulated_players_changed", actorUserId: actorId, payload: { added: [], removed: [member.userId] } }],
          write: (tx) => tx.delete(users).where(and(eq(users.id, member.userId), eq(users.isSimulated, true))), // membership cascades
          apply: () => room.members.delete(member.userId),
        });
      }
      case "set_public": {
        if (!canModerate) throw forbidden();
        const { isPublic } = message;
        if (room.isPublic === isPublic) return;
        return commit(room, {
          events: [{ type: "public_changed", actorUserId: actorId, payload: { isPublic } }],
          write: (tx) => tx.update(rooms).set({ isPublic }).where(eq(rooms.id, room.id)),
          apply: () => {
            room.isPublic = isPublic;
            // Off: every guest goes at once.
            for (const socket of room.guests) closeSocket(socket, "not public");
            room.guests.clear();
          },
        });
      }
      default: {
        const { events, participation: change } = handleGameCommand({ actor: { userId: actorId, canModerate }, room, rollCooldownMs: timing.rollCooldownMs, now: Date.now(), randomInt: timing.randomInt }, message);
        if (!change) return commit(room, { events });
        const member = room.members.get(change.userId)!;
        return commit(room, {
          events,
          write: (tx) => tx.update(roomMembers).set({ participation: change.participation }).where(memberRow(change.userId)),
          apply: () => (member.participation = change.participation),
        });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Every ping interval (spec 8.1): cut off sockets that did not answer the last ping or whose session
  // ran out, forget full rate-limit buckets and rooms nobody joined after all.

  const tick = setInterval(() => {
    const now = Date.now();
    for (const [socket, conn] of conns) {
      if (now >= conn.expiresAt) {
        closeSocket(socket, "session expired");
      } else if (!conn.alive) {
        conn.reason = "ping timeout";
        socket.terminate();
      } else {
        conn.alive = false;
        socket.ping();
      }
    }
    for (const [key, bucket] of buckets) {
      if (bucket.tokens + ((now - bucket.at) / 1000) * MESSAGES_PER_SECOND >= MESSAGE_BURST) buckets.delete(key);
    }
    for (const room of live.values()) if (idle(room)) dispose(room);
  }, timing.pingIntervalMs);
  tick.unref();
  app.addHook("onClose", async () => {
    clearInterval(tick);
    for (const room of live.values()) stopTimers(room);
  });

  // Sockets do not outlive their session.
  auth.onSessionEnd((sessionId) => {
    for (const [socket, conn] of conns) if (conn.sessionId === sessionId) closeSocket(socket, "logged out");
  });

  // ---------------------------------------------------------------------------------------------
  // Routes

  // The room link serves members and, in a public room, guests (spec 4.8). Without a session
  // (auth.loadUser), a room that is not public answers like a missing one: 401, log in.
  const roomOf = new WeakMap<FastifyRequest, Room>();
  const findRoom = async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
    const room = await getRoom(request.params.slug);
    if (!request.user && !room?.isPublic) return reply.code(401).send({ error: "unauthorized" });
    if (!room) return reply.code(404).send({ error: "not_found" });
    roomOf.set(request, room);
  };
  // Requests without a session reach the database too, so they are limited per IP; members are not.
  const guestLimit = () => app.rateLimit({ max: GUEST_CONNECTS_PER_MINUTE, timeWindow: "1 minute", allowList: (request) => request.user !== null });

  app.get<{ Params: { slug: string } }>(
    "/ws/rooms/:slug",
    { websocket: true, onRequest: [auth.loadUser, guestLimit()], preHandler: [sameOrigin, findRoom] },
    (socket: Socket, request) => {
      const room = roomOf.get(request)!;
      if (!request.user) return watch(socket, request, room);
      const userId = request.user!.id;
      const session = request.session!;
      const conn: Conn & { userId: string } = { userId, sessionId: session.id, expiresAt: session.expiresAt.getTime(), alive: true, version: -1 };
      conns.set(socket, conn);
      const log = request.log;
      log.info({ userId, roomId: room.id }, "ws connected");

      const reply = (code: string, message: string) => send(socket, JSON.stringify({ type: "error", code, message }));
      const failed = (err: unknown) => {
        if (err instanceof Evicted) return closeSocket(socket, "retry");
        if (err instanceof RoomGone) return closeSocket(socket, "room gone");
        if (err instanceof CommandError) return reply(err.code, err.german);
        log.error({ err, userId, roomId: room.id }, "ws message failed");
        reply("internal", "Da ist etwas schiefgelaufen. Bitte versuche es noch einmal.");
      };

      socket.on("pong", () => (conn.alive = true));
      // Oversized messages never get here: ws closes the connection with 1009 (maxPayload).
      socket.on("message", (data, isBinary) => {
        const budget = take(room.id, userId);
        if (!budget.ok) {
          if (budget.strikes < MAX_STRIKES) return reply("rate_limited", "Zu viele Nachrichten. Bitte warte einen Moment.");
          return closeSocket(socket, "rate limit");
        }
        let json: unknown;
        try {
          json = isBinary ? undefined : JSON.parse(data.toString());
        } catch {
          json = undefined;
        }
        const parsed = clientMessageSchema.safeParse(json);
        if (!parsed.success) return reply("invalid_message", "Diese Nachricht versteht der Server nicht.");
        run(room, async () => {
          if (room.sockets.get(userId)?.has(socket)) await handle(room, userId, parsed.data); // not if the join was refused
        }).catch(failed);
      });

      socket.on("close", (code) => {
        conns.delete(socket);
        log.info({ userId, roomId: room.id, code, reason: conn.reason ?? "client" }, "ws closed");
        run(room, () => leave(room, userId, socket)).catch((err) => err instanceof Evicted || failed(err));
      });

      if (!take(room.id, userId).ok) return closeSocket(socket, "rate limit"); // reconnect loops cost too
      run(room, () => join(room, socket, conn)).catch((err) => {
        if (err instanceof Evicted || err instanceof RoomGone) return failed(err);
        log.error({ err, userId, roomId: room.id }, "ws join failed");
        closeSocket(socket, "join failed");
      });
    },
  );

  // Guests (spec 4.8): no session, read-only, the guest view of the state.
  function watch(socket: Socket, request: FastifyRequest, room: Room) {
    const conn: Conn = { userId: null, sessionId: "", expiresAt: Infinity, alive: true, version: -1 };
    conns.set(socket, conn);
    const log = request.log;
    log.info({ roomId: room.id, ip: logIp(request.ip) }, "guest connected");

    socket.on("pong", () => (conn.alive = true));
    socket.on("message", () => undefined); // read-only: whatever a guest sends is dropped
    socket.on("close", (code) => {
      conns.delete(socket);
      if (conn.ip !== undefined) {
        const left = guestsPerIp.get(conn.ip)! - 1;
        if (left > 0) guestsPerIp.set(conn.ip, left);
        else guestsPerIp.delete(conn.ip);
      }
      log.info({ roomId: room.id, code, reason: conn.reason ?? "client" }, "guest closed");
      run(room, async () => {
        if (room.guests.delete(socket)) changed(room, false); // hosts see the guest count
      }).catch((err) => err instanceof Evicted || log.error({ err, roomId: room.id }, "guest leave failed"));
    });

    const fromIp = guestsPerIp.get(request.ip) ?? 0;
    if (fromIp >= MAX_GUESTS_PER_IP) return closeSocket(socket, "too many guest connections");
    guestsPerIp.set(request.ip, fromIp + 1);
    conn.ip = request.ip;
    run(room, async () => {
      if (socket.readyState !== OPEN) return;
      if (!room.isPublic) return closeSocket(socket, "not public"); // switched off while waiting
      if (room.guests.size >= MAX_GUESTS_PER_ROOM) return closeSocket(socket, "too many guests");
      room.guests.add(socket);
      schedule(room);
      changed(room, false);
      sendState(room, socket, conn);
    }).catch((err) => closeSocket(socket, err instanceof Evicted ? "retry" : "join failed"));
  }

  app.post(
    "/api/rooms",
    { onRequest: app.rateLimit({ max: CREATE_ROOM_LIMIT_PER_MINUTE, timeWindow: "1 minute" }), preHandler: [sameOrigin, auth.requireUser] },
    async (request, reply) => {
      if (!isHostId(request.user!.discordId)) return reply.code(403).send({ error: "forbidden" });
      const body = createRoomRequestSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_request" });
      const slug = randomBytes(16).toString("base64url"); // 128 bit, not guessable (spec 6)
      await db.transaction(async (tx) => {
        const [room] = await tx
          .insert(rooms)
          .values({ slug, name: body.data.name, isTest: body.data.isTest, settings: defaultSettings, createdBy: request.user!.id })
          .returning({ id: rooms.id });
        // The creator watches by default (spec 4.2).
        await tx.insert(roomMembers).values({ roomId: room!.id, userId: request.user!.id, participation: "spectator" });
      });
      const response: CreateRoomResponse = { slug };
      return reply.code(201).send(response);
    },
  );

  app.get<{ Params: { slug: string } }>("/api/rooms/:slug", { onRequest: [auth.loadUser, guestLimit()] }, async (request, reply) => {
    const [row] = await db
      .select({ slug: rooms.slug, name: rooms.name, isTest: rooms.isTest, status: rooms.status, isPublic: rooms.isPublic })
      .from(rooms)
      .where(eq(rooms.slug, request.params.slug));
    if (!request.user && !row?.isPublic) return reply.code(401).send({ error: "unauthorized" });
    if (!row) return reply.code(404).send({ error: "not_found" });
    const summary: RoomSummary = row;
    return summary;
  });

  // Each change reaches every room the user is in, so it is limited like room creation.
  app.patch(
    "/api/me",
    { onRequest: app.rateLimit({ max: NICKNAME_LIMIT_PER_MINUTE, timeWindow: "1 minute" }), preHandler: [sameOrigin, auth.requireUser] },
    async (request, reply) => {
      const body = patchMeRequestSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_nickname" });
      await db.update(users).set({ nickname: body.data.nickname }).where(eq(users.id, request.user!.id));
      refreshUser(request.user!.id);
      return reply.code(204).send();
    },
  );
}
