// Where the game rules plug into the rooms: every game command (decide.ts) arrives here, already
// validated and serialized per room. Checks what decide cannot see (room membership, the roll
// cooldown) and returns what rooms.ts commits. Simulated players go through here too.
import type { GameState, Participation, UserId } from "../shared/contracts.js";
import { type GameCommand, type NewEvent, decide } from "../shared/game/decide.js";

export type { GameCommand, NewEvent };

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
  actor: { userId: UserId; canModerate: boolean }; // canModerate: host or co-host of this room
  room: {
    game: GameState; // reduce(events, settings), never stale
    members: ReadonlyMap<UserId, { participation: Participation }>;
    lastRollAt: number; // epoch ms of the last accepted roll, 0 if none
  };
  rollCooldownMs: number;
  now: number;
  randomInt: (min: number, maxExclusive: number) => number; // crypto.randomInt in production
};

export type GameCommandResult = {
  events: NewEvent[];
  participation?: { userId: UserId; participation: Participation }; // remove_player and add_player
};

export function handleGameCommand(ctx: GameCommandContext, command: GameCommand): GameCommandResult {
  const { room } = ctx;
  const players = [...room.members].flatMap(([userId, m]) => (m.participation === "player" ? [userId] : []));
  const result = decide(room.game, command, { actorUserId: ctx.actor.userId, actorIsHost: ctx.actor.canModerate, players, randomInt: ctx.randomInt });
  if ("error" in result) throw new CommandError(result.error.code, result.error.message);
  // Spec 7: no roll for about 2 s after a roll, so the animation runs through for everyone.
  if (result.events.some((e) => e.type === "rolled") && ctx.now < room.lastRollAt + ctx.rollCooldownMs)
    throw new CommandError("cooldown", "Der Würfel rollt noch. Bitte warte einen Moment.");
  if (command.type !== "remove_player" && command.type !== "add_player") return { events: result.events };

  const target = room.members.get(command.userId);
  if (!target) throw new CommandError("unknown_member", "Diese Person ist nicht in diesem Raum.");
  // Spec 4.2: latecomers are spectators until added; spec 4.9: removed players come back as spectators.
  if (command.type === "add_player" && target.participation !== "spectator")
    throw new CommandError("not_spectator", "Nur Zuschauer lassen sich als Nachzügler anhängen.");
  return { events: result.events, participation: { userId: command.userId, participation: command.type === "add_player" ? "player" : "spectator" } };
}
