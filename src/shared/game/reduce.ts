// The complete game rules as a pure function (spec 4.4, 6): no network, no database, no clock, no randomness.
//
// Decisions where the concept is silent (each also covered by a test):
// - Undo names its target roll (seq) and applies only while that roll is the newest one still in effect,
//   so two hosts clicking at once take back one roll. Undo again takes the roll before (never a redo).
//   The log is replayed without the undone rolls; events that no longer apply (a `continued` without
//   pause, a `skipped` for someone not active) are ignored. Undone rolls stay in the history.
// - The last-player rule (R5) applies while exactly one player is still rolling.
// - During a six pause the next player is already shown as active; nobody can roll until `continued`.
// - A finished game has no pause. After `game_ended` an undo no longer applies.
// - A host may skip and assign the last place during a pause; the player's own claim waits for `continued`.
import type { GameEvent, GameState, Settings, UserId } from "../contracts.js";

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
    undoneSeqs: [],
  };
}

interface Work {
  status: GameState["status"];
  round: number;
  order: UserId[];
  idx: number; // index of the active player in order
  bonus: Set<UserId>;
  pause: GameState["pause"];
  gifts: UserId[];
  lastRoll: GameState["lastRoll"];
  removed: UserId[];
}

const fresh = (): Work => ({
  status: "lobby",
  round: 0,
  order: [],
  idx: 0,
  bonus: new Set(),
  pause: null,
  gifts: [],
  lastRoll: null,
  removed: [],
});

export function reduce(events: readonly GameEvent[], settings: Settings): GameState {
  // Everything before the last reset is ignored (back to the lobby).
  let start = 0;
  events.forEach((e, i) => {
    if (e.type === "game_reset") start = i;
  });
  const game = events.slice(start);

  // Pass 1: which rolls are undone. stack holds the seqs of the rolls still in effect, newest last.
  const undoneSeqs: number[] = [];
  const stack: number[] = [];
  let ended = false;
  for (const e of game) {
    if (e.type === "game_ended") ended = true;
    else if (e.type === "rolled" && !ended) stack.push(e.seq);
    else if (e.type === "undone" && !ended && e.payload.seq === stack.at(-1)) undoneSeqs.push(stack.pop() as number);
  }

  // Pass 2: replay.
  let s = fresh();
  const active = () => (s.status === "running" ? (s.order[s.idx] ?? null) : null);
  const advance = () => {
    s.idx++;
    if (s.idx >= s.order.length) {
      s.idx = 0;
      s.round++;
    }
  };
  const removeAt = (j: number) => {
    s.order.splice(j, 1);
    if (j < s.idx) s.idx--;
    else if (j === s.idx && s.idx >= s.order.length && s.order.length > 0) {
      s.idx = 0;
      s.round++;
    }
  };
  // R1: the next free place, and the player stops rolling. Only players still rolling get one, so a
  // removed player never holds a place.
  const givePlace = (uid: UserId) => {
    s.gifts.push(uid);
    s.bonus.delete(uid); // nobody with a place rolls again
    removeAt(s.order.indexOf(uid));
  };
  // Called after every change to a running game: R5 auto and the end of the game.
  const settle = () => {
    const last = s.order[0];
    if (settings.lastPlayer === "auto" && s.order.length === 1 && last !== undefined) givePlace(last);
    if (s.order.length === 0) {
      s.status = "finished";
      s.pause = null;
    }
  };

  for (const e of game) {
    const running = s.status === "running";
    switch (e.type) {
      case "game_started":
        if (s.status !== "lobby") break;
        s = { ...fresh(), status: "running", round: 1, order: [...new Set(e.payload.order)] };
        settle();
        break;
      case "rolled": {
        const uid = e.payload.userId;
        if (!running || s.pause || uid !== active() || undoneSeqs.includes(e.seq)) break;
        const dice = e.payload.dice;
        s.bonus.delete(uid); // R4: the bonus lasts exactly one actual roll
        s.lastRoll = { userId: uid, dice: [...dice], ...(e.payload.rolledBy ? { rolledBy: e.payload.rolledBy } : {}) };
        if (dice.includes(6)) {
          // R1, R2: one 6 suffices and beats a simultaneous 1
          s.pause = "six";
          givePlace(uid);
        } else {
          if (dice.includes(1) && (dice.length === 1 || settings.bonusChains)) s.bonus.add(uid); // core rule 6, R3
          advance();
        }
        settle();
        break;
      }
      case "continued":
        s.pause = null;
        break;
      case "paused":
        if (running && !s.pause) s.pause = "host";
        break;
      case "skipped":
        if (running && e.payload.userId === active()) advance(); // R4: a pending bonus stays
        break;
      case "player_removed": {
        const j = s.order.indexOf(e.payload.userId);
        if (!running || j < 0) break;
        removeAt(j);
        s.bonus.delete(e.payload.userId);
        s.removed.push(e.payload.userId);
        settle();
        break;
      }
      case "player_added": {
        const uid = e.payload.userId;
        if (!running || s.order.includes(uid) || s.gifts.includes(uid)) break;
        s.order.push(uid); // latecomers go to the end of the turn order
        s.removed = s.removed.filter((r) => r !== uid);
        break;
      }
      case "last_place_taken":
        if (!running || s.order.length !== 1 || s.order[0] !== e.payload.userId) break;
        givePlace(e.payload.userId);
        settle();
        break;
      case "game_ended":
        if (!running) break;
        s.status = "finished";
        s.pause = null;
        break;
      case "game_reset":
        s = fresh();
        break;
      // undone is handled in pass 1; moderation events do not touch the game.
    }
  }

  const activeUserId = active();
  return {
    status: s.status,
    round: s.round,
    turnOrder: s.order,
    activeUserId,
    activeDiceCount: activeUserId && s.bonus.has(activeUserId) ? 2 : 1,
    bonusPending: [...s.bonus],
    pause: s.pause,
    giftOrder: s.gifts,
    lastRoll: s.lastRoll,
    removed: s.removed,
    history: game,
    undoneSeqs,
  };
}
