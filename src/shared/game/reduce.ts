// The complete game rules as a pure function (spec 6): no network, no database, no clock, no randomness.
// shortcut: lobby-only stub so rooms (step 3) can build on the signature; step 4 replaces the body.
import type { GameEvent, GameState, Settings } from "../contracts.js";

export function initialGameState(): GameState {
  return {
    status: "lobby",
    round: 0,
    turnOrder: [],
    activeUserId: null,
    activeDiceCount: 1,
    bonusPending: [],
    pause: null,
    giftOrder: [],
    lastRoll: null,
    removed: [],
    history: [],
  };
}

export function reduce(events: readonly GameEvent[], _settings: Settings): GameState {
  if (events.some((e) => e.type === "game_started")) throw new Error("reduce: game rules arrive in step 4");
  return { ...initialGameState(), history: [...events] };
}
