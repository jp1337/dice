// Shared contracts between server, game logic and web client.
// Every message crossing the network is defined here as a zod schema; types are inferred from it.
import { z } from "zod";
import { MAX_SIMULATED_PLAYERS, NICKNAME_MAX, ROOM_NAME_MAX, SIX_MESSAGE_MAX, isVisibleText, reactionEmojis } from "./constants.js";

// zod-free values live in constants.ts so the browser bundle can import them without zod.
export * from "./constants.js";

const userId = z.uuid();
export type UserId = z.infer<typeof userId>;

const die = z.int().min(1).max(6);

// Free text other people see (nicknames, room names, the six banner), so nobody can look blank or like
// someone else: NFC, trimmed; no control, format, surrogate, private-use or unassigned characters, no
// space but U+0020, no blank fillers, at most two combining marks on a character, something visible
// (isVisibleText in constants.ts).
const visibleText = (max: number) =>
  z
    .string()
    .transform((text) => text.normalize("NFC").trim())
    .pipe(
      z
        .string()
        .min(1)
        .refine((text) => [...text].length <= max) // characters, not UTF-16 units: an emoji counts once
        .refine(isVisibleText),
    );

// ---------------------------------------------------------------------------------------------
// Room settings (spec 4.4, 4.11). Defaults are the values the spec calls standard.

// No .default() here: update_settings uses settingsSchema.partial(), and a default inside it would
// silently reset every setting the message leaves out.
export const settingsSchema = z.object({
  bonusChains: z.boolean(), // R3
  lastPlayer: z.enum(["choice", "auto"]), // R5
  sixMessage: visibleText(SIX_MESSAGE_MAX), // R6
  reactions: z.boolean(),
});
export type Settings = z.infer<typeof settingsSchema>;
// R1 (a 6 gives the next place and ends rolling) and R2, R4 are fixed rules, not settings.
export const defaultSettings: Settings = {
  bonusChains: true,
  lastPlayer: "choice",
  sixMessage: "{name} hat eine 6 gewürfelt und bekommt Geschenk Nr. {platz}!",
  reactions: true,
};

// ---------------------------------------------------------------------------------------------
// Game events (spec 6, "Ereignisprotokoll"). Append-only; the game state is reduce(events).

export const participationSchema = z.enum(["player", "spectator"]);
export type Participation = z.infer<typeof participationSchema>;

export const eventPayloadSchemas = {
  // Game logic
  game_started: z.object({ order: z.array(userId).min(1) }),
  // rolledBy is set when a host rolled for the player (spec 4.5: shown as "X würfelt für Y").
  rolled: z.object({ userId, dice: z.array(die).min(1).max(2), rolledBy: userId.optional() }),
  continued: z.object({}),
  paused: z.object({}),
  skipped: z.object({ userId }),
  player_removed: z.object({ userId }),
  player_added: z.object({ userId }),
  last_place_taken: z.object({ userId }),
  // seq of the roll taken back; ignored unless it is the newest roll still in effect.
  undone: z.object({ seq: z.int().min(1) }),
  game_ended: z.object({}),
  // Back to the lobby; reduce starts from scratch after this event.
  game_reset: z.object({}),
  // Moderation only: logged for the hosts' history, ignored by the game logic.
  cohost_changed: z.object({ userId, isCohost: z.boolean() }),
  participation_changed: z.object({ userId, participation: participationSchema }),
  nickname_reset: z.object({ userId }),
  public_changed: z.object({ isPublic: z.boolean() }),
  simulated_players_changed: z.object({ added: z.array(userId), removed: z.array(userId) }),
} as const;

export type EventType = keyof typeof eventPayloadSchemas;
export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloadSchemas)[T]>;

// Spec 4.5: only rolls are public, everything else is moderation and visible to hosts only.
export const eventVisibility: Record<EventType, "public" | "hosts"> = {
  game_started: "hosts",
  rolled: "public",
  continued: "hosts",
  paused: "hosts",
  skipped: "hosts",
  player_removed: "hosts",
  player_added: "hosts",
  last_place_taken: "hosts",
  undone: "hosts",
  game_ended: "hosts",
  game_reset: "hosts",
  cohost_changed: "hosts",
  participation_changed: "hosts",
  nickname_reset: "hosts",
  public_changed: "hosts",
  simulated_players_changed: "hosts",
};

export type GameEvent = {
  [T in EventType]: {
    seq: number;
    type: T;
    actorUserId: UserId | null; // null once the acting user is deleted; a simulated player's roll names the player
    payload: EventPayload<T>;
    createdAt: string; // ISO 8601
  };
}[EventType];

// ---------------------------------------------------------------------------------------------
// Game state, computed by the pure function reduce(events, settings) (spec 6).

export type GameStatus = "lobby" | "running" | "finished";

export interface GameState {
  status: GameStatus;
  round: number; // 1-based, 0 in the lobby
  turnOrder: UserId[]; // players still rolling, in the drawn order
  activeUserId: UserId | null;
  activeDiceCount: 1 | 2;
  bonusPending: UserId[]; // players whose next actual roll uses two dice (R4)
  pause: null | "six" | "host";
  giftOrder: UserId[]; // index 0 = gift no. 1
  lastRoll: { userId: UserId; dice: number[]; rolledBy?: UserId } | null;
  removed: UserId[];
  history: GameEvent[]; // events since the last reset, undone rolls included; filtered per recipient
  undoneSeqs: number[]; // seqs of rolls taken back: shown struck through, left out of the computation
}

// ---------------------------------------------------------------------------------------------
// Emoji reactions (spec 4.11)

export const reactionSchema = z.enum(reactionEmojis);

// ---------------------------------------------------------------------------------------------
// WebSocket: client to server (spec 7). One schema per message, discriminated by "type".

const msg = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape }).strict();

export const clientMessageSchema = z.discriminatedUnion("type", [
  // Any participant (set_participation for oneself in the lobby; hosts for anyone)
  msg("set_participation", { userId, participation: participationSchema }),
  msg("react", { emoji: reactionSchema }),
  // Active player
  msg("roll", {}),
  msg("claim_last_place", {}),
  // Host and co-host
  msg("update_settings", { settings: settingsSchema.partial().strict() }),
  msg("add_simulated_players", { count: z.int().min(1).max(MAX_SIMULATED_PLAYERS) }),
  msg("remove_simulated_player", { userId }),
  msg("start", {}),
  msg("pause", {}),
  // pause: the one the host saw; a late click must not lift another host's pause.
  msg("continue", { pause: z.enum(["six", "host"]).optional() }),
  // userId: the player the host saw as active; a stale one is refused (two hosts clicking at once).
  msg("skip", { userId }),
  msg("roll_for", { userId }),
  msg("remove_player", { userId }),
  msg("add_player", { userId }),
  msg("assign_last_place", { userId: userId.optional() }), // the last player the host saw
  // seq: the roll the host saw as the newest; a stale target is refused (two hosts clicking at once).
  msg("undo", { seq: z.int().min(1).optional() }),
  msg("set_public", { isPublic: z.boolean() }),
  msg("reset_nickname", { userId }),
  msg("end", {}),
  msg("reset", {}),
  // Host only (not co-host)
  msg("set_cohost", { userId, isCohost: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------------------------
// WebSocket: server to client

export interface MemberView {
  userId: UserId;
  displayName: string; // nickname > server nickname > global name (spec 4.10)
  discordName?: string; // hosts only
  hasNickname?: boolean; // hosts and co-hosts only: an own nickname is set, so it can be reset
  avatarUrl: string | null; // null = initials placeholder; always null for guests
  participation: Participation;
  isHost: boolean;
  isCohost: boolean;
  isSimulated: boolean;
  connected: boolean;
}

export interface RoomView {
  room: {
    slug: string;
    name: string;
    isTest: boolean;
    status: GameStatus;
    settings: Settings;
    isPublic: boolean; // anyone with the room link may watch without logging in
    guestCount?: number; // hosts only
  };
  members: MemberView[]; // guests: only players and people with a gift place
  game: GameState;
  viewer:
    | { kind: "member"; userId: UserId; isHost: boolean; canModerate: boolean }
    | { kind: "guest" };
}

export type ServerMessage =
  | { type: "state"; state: RoomView; cooldownMs?: number } // cooldownMs: until the server takes the next roll
  | { type: "rolled"; userId: UserId; dice: number[]; rolledBy?: UserId }
  | { type: "reactions"; emojis: { emoji: (typeof reactionEmojis)[number]; count: number }[] }
  | { type: "error"; code: string; message: string }; // message in German

// ---------------------------------------------------------------------------------------------
// HTTP: GET /api/me (spec 7). 401 without a session.

export interface MeResponse {
  userId: UserId;
  displayName: string; // nickname > server nickname > global name (spec 4.10)
  nickname: string | null; // the own nickname, null = the Discord name is shown
  avatarUrl: string | null; // /avatars/:userId/:hash, null = initials placeholder
  isHost: boolean; // listed in HOST_DISCORD_IDS; only hosts may create rooms
}

// ---------------------------------------------------------------------------------------------
// HTTP: rooms and profile (spec 7)

export const createRoomRequestSchema = z
  .object({ name: visibleText(ROOM_NAME_MAX), isTest: z.boolean() })
  .strict();
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;
export interface CreateRoomResponse {
  slug: string; // the room link is /r/:slug
}

// GET /api/rooms/:slug: enough to render the page shell; live state comes over the WebSocket.
export interface RoomSummary {
  slug: string;
  name: string;
  isTest: boolean;
  status: GameStatus;
  isPublic: boolean;
}

// PATCH /api/me (spec 4.10). null resets to the Discord name.
export const patchMeRequestSchema = z
  .object({
    nickname: visibleText(NICKNAME_MAX).nullable(),
  })
  .strict();
export type PatchMeRequest = z.infer<typeof patchMeRequestSchema>;
