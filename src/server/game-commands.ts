// The seam where the game rules plug into the rooms (step 4): every client message that is not a
// lobby or moderation message arrives here, already validated and serialized per room.
import type { ClientMessage, EventPayload, EventType, GameEvent, GameState, Participation, ServerMessage, Settings, UserId } from "../shared/contracts.js";

// Handled by rooms.ts itself.
export type LobbyCommand = Extract<ClientMessage, { type: "set_participation" | "update_settings" | "set_cohost" | "reset_nickname" }>;
export type GameCommand = Exclude<ClientMessage, LobbyCommand>;

export type NewEvent = { [T in EventType]: { type: T; actorUserId: UserId | null; payload: EventPayload<T> } }[EventType];

// Answered to the sender only, as { type: "error", code, message }.
export class CommandError extends Error {
  constructor(
    readonly code: string,
    readonly german: string,
  ) {
    super(code);
  }
}

export type GameCommandContext = {
  actor: { userId: UserId; isHost: boolean; canModerate: boolean };
  room: {
    isTest: boolean;
    settings: Settings;
    game: GameState; // reduce(events, settings), never stale
    events: readonly GameEvent[];
    members: ReadonlyMap<UserId, { participation: Participation; isSimulated: boolean }>;
  };
  // Appends the events (seq = last + 1), recomputes the state with reduce, then broadcasts `state`.
  // Throws, writing nothing, if reduce rejects the new events.
  append: (events: NewEvent[]) => Promise<void>;
  // Sends one message to every socket in the room, e.g. `rolled` for the animation or `reactions`.
  broadcast: (message: Exclude<ServerMessage, { type: "state" | "error" }>) => void;
};

export async function handleGameCommand(_ctx: GameCommandContext, _command: GameCommand): Promise<void> {
  throw new CommandError("not_implemented", "Diese Aktion gibt es noch nicht.");
}
