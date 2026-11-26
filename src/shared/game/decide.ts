// Validates a game command against the state and the actor's rights (spec 4.6, 7) and returns the events
// to append. Pure: randomness comes in through ctx.randomInt (the server passes crypto.randomInt).
import type { ClientMessage, EventPayload, EventType, GameEvent, GameState, Settings, UserId } from "../contracts.js";
import { reduce } from "./reduce.js";

export const gameCommandTypes = [
  "start",
  "roll",
  "roll_for",
  "claim_last_place",
  "assign_last_place",
  "pause",
  "continue",
  "skip",
  "remove_player",
  "add_player",
  "undo",
  "end",
  "reset",
] as const;
export type GameCommand = Extract<ClientMessage, { type: (typeof gameCommandTypes)[number] }>;

// A game event before the server gives it seq and createdAt.
export type NewEvent = {
  [T in EventType]: { type: T; actorUserId: UserId | null; payload: EventPayload<T> };
}[EventType];

export interface DecideContext {
  actorUserId: UserId;
  actorIsHost: boolean; // host or co-host of this room
  players: readonly UserId[]; // members with participation "player"; used by start
  randomInt: (min: number, maxExclusive: number) => number;
  settings: Settings; // the room's; an undo is checked by replaying the game without the roll
}

export type DecideResult = { events: NewEvent[] } | { error: { code: string; message: string } };

const fail = (code: string, message: string): DecideResult => ({ error: { code, message } });

const hostOnly = new Set<GameCommand["type"]>(gameCommandTypes.filter((t) => t !== "roll" && t !== "claim_last_place"));

export function shuffle<T>(items: readonly T[], randomInt: DecideContext["randomInt"]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

// A finished game runs again without that roll, or the undo does nothing. A last player who rolled a 3 and
// then took the last place: taking back the 3 left the game over, while the button promised "Das Spiel geht
// dann weiter". Shared with the client, which shows the button only when this holds.
export function undoReopens(state: GameState, settings: Settings, seq: number) {
  if (state.status !== "finished") return true;
  const undone = { type: "undone", actorUserId: null, payload: { seq }, seq: (state.history.at(-1)?.seq ?? 0) + 1, createdAt: "" } as GameEvent;
  return reduce([...state.history, undone], settings).status !== "finished";
}

export function decide(state: GameState, command: GameCommand, ctx: DecideContext): DecideResult {
  const actor = ctx.actorUserId;
  const ev = <T extends EventType>(type: T, payload: EventPayload<T>): DecideResult => ({
    events: [{ type, actorUserId: actor, payload } as NewEvent],
  });
  const roll = (userId: UserId, rolledBy?: UserId): DecideResult => {
    const dice = Array.from({ length: state.activeDiceCount }, () => ctx.randomInt(1, 7));
    return ev("rolled", rolledBy && rolledBy !== userId ? { userId, dice, rolledBy } : { userId, dice });
  };

  if (hostOnly.has(command.type) && !ctx.actorIsHost) return fail("not_host", "Das dürfen nur Hosts.");

  if (command.type === "start") {
    if (state.status !== "lobby") return fail("game_running", "Das Spiel läuft schon oder ist vorbei.");
    const players = [...new Set(ctx.players)];
    if (players.length === 0) return fail("no_players", "Es gibt noch keine Würfler.");
    return ev("game_started", { order: shuffle(players, ctx.randomInt) });
  }
  if (command.type === "reset") {
    if (state.status === "lobby") return fail("no_game", "Es läuft kein Spiel.");
    return ev("game_reset", {});
  }
  if (command.type === "undo") {
    if (state.status === "lobby") return fail("no_game", "Es läuft kein Spiel.");
    if (state.history.some((e) => e.type === "game_ended")) return fail("game_over", "Das Spiel ist beendet.");
    const target = state.history.findLast((e) => e.type === "rolled" && !state.undoneSeqs.includes(e.seq));
    if (command.seq !== undefined && command.seq !== target?.seq)
      return fail("undo_stale", "Dieser Wurf ist schon zurückgenommen oder nicht mehr der letzte.");
    if (!target) return fail("nothing_to_undo", "Es gibt keinen Wurf zum Zurücknehmen.");
    if (!undoReopens(state, ctx.settings, target.seq)) return fail("undo_no_effect", "Ohne diesen Wurf wäre das Spiel trotzdem vorbei.");
    return ev("undone", { seq: target.seq });
  }

  // Every other command needs a running game, which always has an active player.
  if (state.status === "lobby") return fail("no_game", "Es läuft kein Spiel.");
  if (state.status === "finished" || !state.activeUserId) return fail("game_over", "Das Spiel ist vorbei.");
  const active = state.activeUserId;
  const lastPlayer = state.turnOrder.length === 1 ? active : null; // R5
  // skip and roll_for name the player the host saw: a late click must not hit whoever is next.
  if ((command.type === "skip" || command.type === "roll_for") && command.userId !== active)
    return fail("turn_changed", "Inzwischen ist jemand anderes dran.");

  switch (command.type) {
    case "roll":
      if (actor !== active) return fail("not_your_turn", "Du bist nicht dran.");
      if (state.pause) return fail("paused", "Das Spiel ist pausiert.");
      return roll(active);
    case "roll_for":
      if (state.pause) return fail("paused", "Das Spiel ist pausiert.");
      return roll(active, actor);
    case "claim_last_place":
      if (actor !== lastPlayer) return fail("not_last_player", "Nur der letzte Würfler kann den letzten Platz nehmen.");
      if (state.pause) return fail("paused", "Das Spiel ist pausiert.");
      return ev("last_place_taken", { userId: active });
    case "assign_last_place":
      if (!lastPlayer) return fail("no_last_player", "Es würfeln noch mehrere Spieler.");
      if (command.userId !== undefined && command.userId !== lastPlayer) return fail("turn_changed", "Inzwischen ist jemand anderes dran.");
      return ev("last_place_taken", { userId: lastPlayer });
    case "pause":
      if (state.pause) return fail("already_paused", "Das Spiel ist schon pausiert.");
      return ev("paused", {});
    case "continue":
      if (!state.pause) return fail("not_paused", "Das Spiel ist nicht pausiert.");
      if (command.pause !== undefined && command.pause !== state.pause) return fail("pause_changed", "Inzwischen hat jemand anderes pausiert.");
      return ev("continued", {});
    case "skip":
      return ev("skipped", { userId: active });
    case "remove_player":
      if (!state.turnOrder.includes(command.userId)) return fail("not_in_game", "Diese Person würfelt nicht mit.");
      return ev("player_removed", { userId: command.userId });
    case "add_player":
      if (state.turnOrder.includes(command.userId) || state.giftOrder.includes(command.userId))
        return fail("already_in_game", "Diese Person ist schon im Spiel.");
      return ev("player_added", { userId: command.userId });
    case "end":
      return ev("game_ended", {});
  }
}
