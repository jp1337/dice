// Rooms, lobby and the room WebSocket (spec 4.2, 4.3, 4.9, 4.10, 7, 8.1).
// Each active room lives in memory, rebuilt from room_members and game_events (reduce) on first use.
// Every change to a room runs in that room's queue: database first, then memory, then broadcast.
import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type ClientMessage,
  type CreateRoomResponse,
  type GameEvent,
  type GameState,
  type MemberView,
  type Participation,
  type RoomSummary,
  type RoomView,
  type Settings,
  clientMessageSchema,
  createRoomRequestSchema,
  defaultSettings,
  eventVisibility,
  patchMeRequestSchema,
} from "../shared/contracts.js";
import { reduce } from "../shared/game/reduce.js";
import type { Config } from "./config.js";
import { gameEvents, roomMembers, rooms, users } from "./db/schema.js";
import { CommandError, type GameCommandContext, type NewEvent, handleGameCommand } from "./game-commands.js";

export const CREATE_ROOM_LIMIT_PER_MINUTE = 10;
export const MESSAGES_PER_SECOND = 10;
export const MESSAGE_BURST = 20;
export const MAX_STRIKES = 10; // rate-limited messages in a row before the connection is closed

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

export type Room = {
  id: string;
  slug: string;
  name: string;
  isTest: boolean;
  settings: Settings;
  watchToken: string | null;
  members: Map<string, Member>; // insertion order = join order
  sockets: Map<string, Set<Socket>>; // per user; several tabs are several sockets
  events: GameEvent[];
  game: GameState;
  queue: Promise<unknown>;
};

type Db = NodePgDatabase;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const fail = (code: string, german: string) => new CommandError(code, german);
const forbidden = () => fail("forbidden", "Dazu fehlt dir die Berechtigung.");

// The room as one viewer may see it (spec 4.5, 4.8, 4.10). null = anonymous guest (4.8, not wired yet).
export function roomView(room: Room, viewer: Member | null, config: Config): RoomView {
  const isHostMember = (m: Member) => m.discordId !== null && config.hostDiscordIds.includes(m.discordId);
  const isHost = viewer !== null && isHostMember(viewer);
  const canModerate = isHost || viewer?.isCohost === true;
  const placed = new Set(room.game.giftOrder);
  const members = [...room.members.values()]
    .filter((m) => viewer || m.participation === "player" || placed.has(m.userId))
    .map(
      (m): MemberView => ({
        userId: m.userId,
        displayName: m.nickname ?? m.displayName,
        ...(isHost && { discordName: m.username }),
        avatarUrl: viewer && m.avatarHash ? `/avatars/${m.userId}/${m.avatarHash}` : null,
        participation: m.participation,
        isHost: isHostMember(m),
        isCohost: m.isCohost,
        isSimulated: m.isSimulated,
        connected: m.isSimulated || (room.sockets.get(m.userId)?.size ?? 0) > 0, // simulated players are run by the server
      }),
    );
  return {
    room: {
      slug: viewer ? room.slug : "", // the room link is for server members only
      name: room.name,
      isTest: room.isTest,
      status: room.game.status,
      settings: room.settings,
      watchLinkActive: room.watchToken !== null,
      ...(canModerate && {
        ...(room.watchToken && { watchUrl: new URL(`/z/${room.watchToken}`, config.baseUrl).href }),
        guestCount: 0, // shortcut: guests (4.8) are not connected yet; count them when /ws/watch exists
      }),
    },
    members,
    game: { ...room.game, history: room.game.history.filter((e) => canModerate || eventVisibility[e.type] === "public") },
    viewer: viewer ? { kind: "member", userId: viewer.userId, isHost, canModerate } : { kind: "guest" },
  };
}

export function registerRooms(
  app: FastifyInstance,
  config: Config,
  db: Db,
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  pingIntervalMs: number,
) {
  const isHostId = (discordId: string | null) => discordId !== null && config.hostDiscordIds.includes(discordId);
  const sameOrigin = async (request: FastifyRequest, reply: FastifyReply) => {
    // CSRF for cookie-authenticated writes and WebSocket upgrades: browsers always send Origin there.
    if (request.headers.origin !== config.baseUrl.origin) return reply.code(403).send({ error: "forbidden" });
  };

  // ---------------------------------------------------------------------------------------------
  // Registry

  // shortcut: a room stays loaded until restart; fine for the few rooms hosts create. Evict idle rooms if that grows.
  const loading = new Map<string, Promise<Room | null>>();
  const live = new Set<Room>();

  async function load(slug: string): Promise<Room | null> {
    const [row] = await db.select().from(rooms).where(eq(rooms.slug, slug));
    if (!row) return null;
    const memberRows = await db
      .select({ ...userColumns, participation: roomMembers.participation, isCohost: roomMembers.isCohost })
      .from(roomMembers)
      .innerJoin(users, eq(users.id, roomMembers.userId))
      .where(eq(roomMembers.roomId, row.id))
      .orderBy(asc(roomMembers.joinedAt), asc(users.id));
    const eventRows = await db.select().from(gameEvents).where(eq(gameEvents.roomId, row.id)).orderBy(asc(gameEvents.seq));
    const events = eventRows.map(
      (e) => ({ seq: e.seq, type: e.type, actorUserId: e.actorUserId, payload: e.payload, createdAt: e.createdAt.toISOString() }) as GameEvent,
    );
    const room: Room = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      isTest: row.isTest,
      settings: row.settings,
      watchToken: row.watchToken,
      members: new Map(memberRows.map((m) => [m.userId, m])),
      sockets: new Map(),
      events,
      game: reduce(events, row.settings),
      queue: Promise.resolve(),
    };
    live.add(room);
    return room;
  }

  function getRoom(slug: string) {
    let room = loading.get(slug);
    if (!room) {
      room = load(slug);
      loading.set(slug, room);
      // Unknown slugs and failed loads are not kept, so the next request asks the database again.
      room.then((r) => r ?? loading.delete(slug), () => loading.delete(slug));
    }
    return room;
  }

  function run<T>(room: Room, task: () => Promise<T>): Promise<T> {
    const result = room.queue.then(task);
    room.queue = result.catch(() => undefined);
    return result;
  }

  const send = (socket: Socket, text: string) => socket.readyState === OPEN && socket.send(text);

  function broadcastState(room: Room) {
    for (const [userId, sockets] of room.sockets) {
      const text = JSON.stringify({ type: "state", state: roomView(room, room.members.get(userId)!, config) });
      for (const socket of sockets) send(socket, text);
    }
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
      if (added.length > 0) {
        await tx.insert(gameEvents).values(added.map((e) => ({ roomId: room.id, seq: e.seq, type: e.type, actorUserId: e.actorUserId, payload: e.payload, createdAt: now })));
      }
      await change.write?.(tx);
      await tx.update(rooms).set({ lastActivityAt: now, status: game.status, settings }).where(eq(rooms.id, room.id));
    });
    change.apply?.();
    Object.assign(room, { events, game, settings });
    broadcastState(room);
  }

  // A changed nickname shows in every loaded room the user belongs to.
  function refreshUser(userId: string, except?: Room) {
    for (const room of live) {
      if (room === except || !room.members.has(userId)) continue;
      run(room, async () => {
        const [user] = await db.select(userColumns).from(users).where(eq(users.id, userId));
        if (user) Object.assign(room.members.get(userId)!, user);
        broadcastState(room);
      }).catch((err) => app.log.error({ err, userId }, "refreshing a member failed"));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Join and leave (spec 4.2, 4.9)

  async function join(room: Room, userId: string, socket: Socket) {
    const [user] = await db.select(userColumns).from(users).where(eq(users.id, userId));
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
    await db.update(rooms).set({ lastActivityAt: new Date() }).where(eq(rooms.id, room.id));
    if (socket.readyState !== OPEN) return; // closed while waiting in the queue
    const sockets = room.sockets.get(userId) ?? new Set();
    room.sockets.set(userId, sockets.add(socket));
    broadcastState(room);
  }

  async function leave(room: Room, userId: string, socket: Socket) {
    const sockets = room.sockets.get(userId);
    if (!sockets?.delete(socket) || sockets.size > 0) return;
    room.sockets.delete(userId);
    broadcastState(room);
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
        lobbyOnly();
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
      default: {
        const ctx: GameCommandContext = {
          actor: { userId: actorId, isHost, canModerate },
          room,
          append: (events) => commit(room, { events }),
          broadcast: (out) => {
            const text = JSON.stringify(out);
            for (const sockets of room.sockets.values()) for (const socket of sockets) send(socket, text);
          },
        };
        return handleGameCommand(ctx, message);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Ping (spec 8.1): a socket that did not answer the previous ping is cut off.

  const alive = new Map<Socket, { alive: boolean; reason?: string }>();
  const pinger = setInterval(() => {
    for (const [socket, state] of alive) {
      if (!state.alive) {
        state.reason = "ping timeout";
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }, pingIntervalMs);
  pinger.unref();
  app.addHook("onClose", async () => clearInterval(pinger));

  // ---------------------------------------------------------------------------------------------
  // Routes

  const roomOf = new WeakMap<FastifyRequest, Room>();
  const findRoom = async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
    const room = await getRoom(request.params.slug);
    if (!room) return reply.code(404).send({ error: "not_found" });
    roomOf.set(request, room);
  };

  app.get<{ Params: { slug: string } }>(
    "/ws/rooms/:slug",
    { websocket: true, preHandler: [sameOrigin, requireUser, findRoom] },
    (socket: Socket, request) => {
      const room = roomOf.get(request)!;
      const userId = request.user!.id;
      const log = request.log;
      const state: { alive: boolean; reason?: string } = { alive: true };
      alive.set(socket, state);
      log.info({ userId, roomId: room.id }, "ws connected");

      const reply = (code: string, message: string) => send(socket, JSON.stringify({ type: "error", code, message }));
      const failed = (err: unknown) => {
        if (err instanceof CommandError) return reply(err.code, err.german);
        log.error({ err, userId, roomId: room.id }, "ws message failed");
        reply("internal", "Da ist etwas schiefgelaufen. Bitte versuche es noch einmal.");
      };

      // Token bucket per connection (spec 8.3).
      let tokens = MESSAGE_BURST;
      let refilled = Date.now();
      let strikes = 0;

      socket.on("pong", () => (state.alive = true));
      // Oversized messages never get here: ws closes the connection with 1009 (maxPayload).
      socket.on("message", (data, isBinary) => {
        const now = Date.now();
        tokens = Math.min(MESSAGE_BURST, tokens + ((now - refilled) / 1000) * MESSAGES_PER_SECOND);
        refilled = now;
        if (tokens < 1) {
          if (++strikes < MAX_STRIKES) return reply("rate_limited", "Zu viele Nachrichten. Bitte warte einen Moment.");
          state.reason = "rate limit";
          return socket.close(1008, "rate limit");
        }
        tokens -= 1;
        strikes = 0;
        let json: unknown;
        try {
          json = isBinary ? undefined : JSON.parse(data.toString());
        } catch {
          json = undefined;
        }
        const parsed = clientMessageSchema.safeParse(json);
        if (!parsed.success) return reply("invalid_message", "Diese Nachricht versteht der Server nicht.");
        run(room, () => handle(room, userId, parsed.data)).catch(failed);
      });

      socket.on("close", (code) => {
        alive.delete(socket);
        log.info({ userId, roomId: room.id, code, reason: state.reason ?? "client" }, "ws closed");
        run(room, () => leave(room, userId, socket)).catch(failed);
      });

      run(room, () => join(room, userId, socket)).catch((err) => {
        failed(err);
        state.reason = "join failed";
        socket.close(1011, "join failed");
      });
    },
  );

  app.post(
    "/api/rooms",
    { config: { rateLimit: { max: CREATE_ROOM_LIMIT_PER_MINUTE, timeWindow: "1 minute" } }, preHandler: [sameOrigin, requireUser] },
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

  app.get<{ Params: { slug: string } }>("/api/rooms/:slug", { preHandler: requireUser }, async (request, reply) => {
    const [row] = await db
      .select({ slug: rooms.slug, name: rooms.name, isTest: rooms.isTest, status: rooms.status })
      .from(rooms)
      .where(eq(rooms.slug, request.params.slug));
    if (!row) return reply.code(404).send({ error: "not_found" });
    const summary: RoomSummary = row;
    return summary;
  });

  app.patch("/api/me", { preHandler: [sameOrigin, requireUser] }, async (request, reply) => {
    const body = patchMeRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_nickname" });
    await db.update(users).set({ nickname: body.data.nickname }).where(eq(users.id, request.user!.id));
    refreshUser(request.user!.id);
    return reply.code(204).send();
  });
}
