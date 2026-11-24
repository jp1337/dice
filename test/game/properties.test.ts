// Property-style checks over many seeded random games and random event logs.
import { describe, expect, it } from "vitest";
import type { GameState, Settings, UserId } from "../../src/shared/contracts.js";
import type { GameCommand, NewEvent } from "../../src/shared/game/decide.js";
import { reduce } from "../../src/shared/game/reduce.js";
import { Game, HOST, e, log, seeded, settingsWith, users } from "./helpers.js";

const variants: Partial<Settings>[] = [];
for (const bonusChains of [true, false])
  for (const lastPlayer of ["choice", "auto"] as const) variants.push({ bonusChains, lastPlayer });

function checkState(s: GameState) {
  if (s.status === "running") expect(s.turnOrder).toContain(s.activeUserId);
  else expect(s.activeUserId).toBeNull();
  if (s.status !== "running") expect(s.pause).toBeNull();
  expect(new Set(s.turnOrder).size).toBe(s.turnOrder.length);
  expect(s.activeDiceCount).toBe(s.activeUserId && s.bonusPending.includes(s.activeUserId) ? 2 : 1);
  expect(new Set(s.giftOrder).size).toBe(s.giftOrder.length);
  for (const u of s.giftOrder) expect([...s.turnOrder, ...s.removed]).not.toContain(u); // a removed player never holds a place
  for (const seq of s.undoneSeqs) expect(s.history.find((x) => x.seq === seq)?.type).toBe("rolled");
}

// One random game: mostly rolls, sometimes host tools; returns the game and everyone who ever played.
function randomGame(seed: number, s: Partial<Settings>, moderate: boolean) {
  const rnd = seeded(seed);
  const pool = users(12);
  const g = new Game(s, seeded(seed + 1));
  const start = pool.slice(0, rnd(1, 9));
  g.do(HOST, { type: "start" }, { players: start });
  const everyone = new Set(start);
  for (let step = 0; step < 2000 && g.state.status === "running"; step++) {
    const st = g.state;
    const active = st.activeUserId as UserId;
    const someone = pool[rnd(0, pool.length)] as UserId;
    const pick = rnd(0, 100);
    let cmd: [UserId, GameCommand];
    if (st.pause) cmd = [HOST, { type: "continue" }];
    else if (!moderate || pick < 70) cmd = [active, { type: "roll" }];
    else if (pick < 74) cmd = [HOST, { type: "roll_for" }];
    else if (pick < 77) cmd = [HOST, { type: "skip" }];
    else if (pick < 80) cmd = [HOST, { type: "pause" }];
    else if (pick < 85) cmd = [HOST, pick % 2 ? { type: "undo" } : { type: "undo", seq: rnd(1, g.events.length + 2) }];
    else if (pick < 88) cmd = [HOST, { type: "remove_player", userId: someone }];
    else if (pick < 91) cmd = [HOST, { type: "add_player", userId: someone }];
    else if (pick < 95) cmd = [active, { type: "claim_last_place" }];
    else if (pick < 97) cmd = [HOST, { type: "assign_last_place" }];
    else cmd = [someone, { type: "roll" }]; // mostly refused: not their turn
    const r = g.try(...cmd);
    if (cmd[1].type === "add_player" && "events" in r) everyone.add(cmd[1].userId);
    checkState(g.state);
  }
  return { g, everyone };
}

describe.each(variants)("random games with %o", (s) => {
  it("end with exactly one place per remaining player, places 1..n without gaps", () => {
    for (let seed = 0; seed < 150; seed++) {
      const { g, everyone } = randomGame(seed * 7919, s, seed % 3 !== 0);
      const st = g.state;
      expect(st.status).toBe("finished");
      const remaining = [...everyone].filter((u) => !st.removed.includes(u));
      expect([...st.giftOrder].sort()).toEqual(remaining.sort());
      expect(st.turnOrder).toEqual([]);
      // reduce is deterministic and depends on the log only
      expect(reduce(JSON.parse(JSON.stringify(g.events)), g.settings)).toEqual(st);
    }
  });
});

it("random event logs never put the active player outside the turn order", () => {
  const pool = users(5);
  const makers: ((u: UserId, r: (a: number, b: number) => number) => NewEvent)[] = [
    (u) => e.start(...pool.slice(0, pool.indexOf(u) + 1)),
    (u, r) => e.roll(u, r(1, 7)),
    (u, r) => e.roll(u, r(1, 7), r(1, 7)),
    () => e.cont(),
    () => e.pause(),
    (u) => e.skip(u),
    (u) => e.remove(u),
    (u) => e.add(u),
    (u) => e.last(u),
    (_u, r) => e.undo(r(1, 61)),
    (u) => e.start(u, ...pool, u), // duplicates
    () => e.end(),
    () => e.reset(),
    (u) => e.cohost(u),
  ];
  for (let seed = 0; seed < 400; seed++) {
    const r = seeded(seed);
    const events: NewEvent[] = [];
    for (let i = 0; i < 60; i++) {
      // game_started more often so most logs contain a game
      const k = i === 0 ? 0 : r(0, makers.length);
      events.push((makers[k] as (typeof makers)[number])(pool[r(0, pool.length)] as UserId, r));
    }
    for (const v of variants) {
      const settings = settingsWith(v);
      const st = reduce(log(events), settings);
      checkState(st);
      expect(reduce(log(events), settings)).toEqual(st);
    }
  }
});

it("a full deterministic game with a seeded RNG ends with a complete gift order", () => {
  const play = () => {
    const g = new Game({}, seeded(2026));
    const players = users(8);
    g.do(HOST, { type: "start" }, { players });
    while (g.state.status === "running") {
      if (g.state.pause) g.do(HOST, { type: "continue" });
      else g.do(g.state.activeUserId as UserId, { type: "roll" });
    }
    return g;
  };
  const g = play();
  expect([...g.state.giftOrder].sort()).toEqual(users(8).sort());
  expect(g.state.history.filter((x) => x.type === "rolled").length).toBeGreaterThan(8);
  expect(play().events).toEqual(g.events);
});
