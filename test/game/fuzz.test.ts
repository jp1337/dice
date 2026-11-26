// Random games through decide() and reduce(), the way the server runs them: thousands of seeds, every host
// tool, late and stale clicks included. After every accepted command the state must keep its invariants.
import { describe, expect, it } from "vitest";
import type { GameState, Settings, UserId } from "../../src/shared/contracts.js";
import type { GameCommand } from "../../src/shared/game/decide.js";
import { Game, HOST, seeded, users } from "./helpers.js";

const PLAYERS = users(6);

function invariants(s: GameState, everyone: readonly UserId[]) {
  const problems: string[] = [];
  const dup = (xs: readonly UserId[]) => xs.length !== new Set(xs).size;
  if (dup(s.giftOrder)) problems.push("a gift place twice");
  if (dup(s.turnOrder)) problems.push("a player twice in the turn order");
  if (s.turnOrder.some((u) => s.giftOrder.includes(u))) problems.push("someone with a place still in the turn order");
  if (s.turnOrder.some((u) => s.removed.includes(u))) problems.push("a removed player in the turn order");
  if (s.giftOrder.some((u) => s.removed.includes(u))) problems.push("a removed player with a place");
  if (s.bonusPending.some((u) => !s.turnOrder.includes(u))) problems.push("a bonus for someone who no longer rolls");
  if (s.status === "running") {
    if (!s.activeUserId || !s.turnOrder.includes(s.activeUserId)) problems.push("running without an active player in the order");
    if (s.activeDiceCount !== (s.bonusPending.includes(s.activeUserId!) ? 2 : 1)) problems.push("dice count does not match the bonus");
  }
  if (s.status === "finished" && !s.history.some((e) => e.type === "game_ended")) {
    const left = everyone.filter((u) => !s.giftOrder.includes(u) && !s.removed.includes(u) && s.history.some((e) => e.type === "game_started"));
    if (s.turnOrder.length > 0 || left.some((u) => s.turnOrder.includes(u))) problems.push("finished with players still to roll");
  }
  const lastRoll = s.history.findLast((e): e is Extract<typeof e, { type: "rolled" }> => e.type === "rolled" && !s.undoneSeqs.includes(e.seq));
  if (s.status !== "lobby" && (lastRoll?.payload.dice.join() ?? null) !== (s.lastRoll?.dice.join() ?? null)) problems.push("lastRoll is not the newest roll in effect");
  for (const e of s.history) if (e.type === "rolled" && e.payload.dice.some((d) => d < 1 || d > 6 || !Number.isInteger(d))) problems.push("a die off 1..6");
  return problems;
}

function play(seed: number, settings: Partial<Settings>) {
  const rnd = seeded(seed);
  const pick = <T,>(xs: readonly T[]) => xs[rnd(0, xs.length)]!;
  const g = new Game(settings, seeded(seed ^ 0x5bd1e995));
  const players = PLAYERS.slice(0, rnd(2, 7));
  g.do(HOST, { type: "start" }, { players });
  const accepted: string[] = [];
  for (let step = 0; step < 120; step++) {
    const s = g.state;
    if (s.status !== "running") break;
    const active = s.activeUserId!;
    const newest = s.history.findLast((e) => e.type === "rolled" && !s.undoneSeqs.includes(e.seq))?.seq;
    const someone = pick(PLAYERS);
    const options: [UserId, GameCommand][] = [
      [active, { type: "roll" }],
      [active, { type: "roll" }],
      [active, { type: "roll" }],
      [someone, { type: "roll" }], // out of turn
      [HOST, { type: "roll_for", userId: active }],
      [HOST, { type: "roll_for", userId: someone }], // stale
      [HOST, { type: "skip", userId: active }],
      [HOST, { type: "pause" }],
      [HOST, { type: "continue", pause: s.pause ?? undefined }],
      [HOST, { type: "continue", pause: pick(["six", "host"] as const) }],
      [HOST, { type: "continue" }],
      [HOST, { type: "continue" }],
      [HOST, newest ? { type: "undo", seq: newest } : { type: "undo" }],
      [HOST, { type: "undo", seq: rnd(1, s.history.length + 2) }],
      [HOST, { type: "remove_player", userId: someone }],
      [HOST, { type: "add_player", userId: someone }],
      [HOST, { type: "assign_last_place" }],
      [HOST, { type: "assign_last_place", userId: someone }],
      [active, { type: "claim_last_place" }],
      [someone, { type: "claim_last_place" }],
    ];
    if (rnd(0, 200) === 0) options.push([HOST, { type: "end" }]);
    const [actor, command] = pick(options);
    const before = g.events.length;
    g.try(actor, command, { players });
    if (g.events.length === before) continue;
    accepted.push(command.type);
    const problems = invariants(g.state, PLAYERS);
    if (problems.length > 0) return { seed, settings, step, accepted, problems, events: g.events.slice(-6) };
  }
  return null;
}

describe("random games keep their invariants", () => {
  for (const settings of [{}, { bonusChains: true }, { lastPlayer: "auto" as const }, { bonusChains: true, lastPlayer: "auto" as const }]) {
    it(`2000 games with ${JSON.stringify(settings)}`, () => {
      const failures = [];
      for (let seed = 1; seed <= 2000 && failures.length < 3; seed++) {
        const failure = play(seed, settings);
        if (failure) failures.push(failure);
      }
      expect(failures).toEqual([]);
    });
  }
});
