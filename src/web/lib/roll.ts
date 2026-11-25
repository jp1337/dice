// When the dice tumble. The server sends the `state` that holds a new roll first and `rolled` right
// after it (the animation trigger). Between the two, and until the dice land, the new result must not
// show anywhere else yet: no six banner, no result page. A new roll seq in a state marks the gap;
// `rolled` starts the tumble; the dice landing ends it. The first state of every connection is the
// baseline: rolls missed while away are not replayed.
import { ROLL_COOLDOWN_MS } from "../../shared/constants.js";
import type { RoomView } from "../../shared/contracts.js";

export type RollState = {
  seenSeq: number; // newest roll seq in any state so far
  waiting: boolean; // a state brought a new roll, its `rolled` has not arrived yet
  tumbling: boolean;
  cooling: boolean; // within ROLL_COOLDOWN_MS of the last `rolled`: the server refuses the next roll
  rollKey: number; // the Dice component's trigger, one per `rolled`
  dice: number[] | null; // the values of the newest `rolled`
  rolledAt: number | null; // when it arrived (Date.now()), for the countdown
  held: RoomView | null; // the last view before the new roll: shown everywhere until the dice land
};

export type RollAction =
  | { type: "state"; view: RoomView; first: boolean }
  | { type: "rolled"; dice: number[]; at?: number }
  | { type: "settled" }
  | { type: "cooled" } // ROLL_COOLDOWN_MS after `rolled`
  | { type: "timeout" }; // `rolled` never came (ROLLED_WAIT_MS): show the state as it is

export const ROLLED_WAIT_MS = 1500;
export const SIX_BANNER_DELAY_MS = 1000; // the landed six stays visible this long before the banner covers it
export const initialRoll: RollState = { seenSeq: 0, waiting: false, tumbling: false, cooling: false, rollKey: 0, dice: null, rolledAt: null, held: null };

// Rolls only, so the number means the same for hosts and everyone else. Undone rolls stay in the history.
export const newestRollSeq = (view: RoomView) => view.game.history.findLast((e) => e.type === "rolled")?.seq ?? 0;

export function rollStep(state: RollState, action: RollAction): RollState {
  switch (action.type) {
    case "state": {
      const seq = newestRollSeq(action.view);
      // A reconnect or a reset unmounts the dice mid-tumble, and their onSettled never comes.
      if (action.first || action.view.game.status === "lobby") {
        return { ...state, seenSeq: Math.max(seq, state.seenSeq), waiting: false, tumbling: false, cooling: false, held: action.view };
      }
      // A new roll: keep showing the view from before it. Other states while the dice tumble wait too.
      if (seq > state.seenSeq) return { ...state, seenSeq: seq, waiting: true };
      return rollBusy(state) ? state : { ...state, held: action.view };
    }
    case "rolled":
      return { ...state, waiting: false, tumbling: true, cooling: true, rollKey: state.rollKey + 1, dice: action.dice, rolledAt: action.at ?? null };
    case "settled":
      return { ...state, tumbling: false };
    case "cooled":
      return { ...state, cooling: false };
    case "timeout":
      return { ...state, waiting: false };
  }
}

// The new result is not to be shown yet.
export const rollBusy = (state: RollState) => state.waiting || state.tumbling;
// The roll buttons wait for the server's cooldown too.
export const rollLocked = (state: RollState) => rollBusy(state) || state.cooling;

// Whole seconds until the next roll is allowed, shown once the dice have landed; 0 = none to show.
export function countdown(state: RollState, now: number) {
  if (!state.cooling || rollBusy(state) || state.rolledAt === null) return 0;
  return Math.max(0, Math.ceil((state.rolledAt + ROLL_COOLDOWN_MS - now) / 1000));
}

// The view every panel shows: until the dice land, the one from before the roll, so neither the
// history, the gift order, the turn order nor a badge gives the result away before the dice do.
export function displayedView(state: RollState, latest: RoomView) {
  return (rollBusy(state) && state.held) || latest;
}

// What the dice show: the tumbling roll, or the game's last roll (which also follows an undo).
export function shownDice(state: RollState, view: RoomView) {
  return (rollBusy(state) && state.dice) || view.game.lastRoll?.dice || null;
}
