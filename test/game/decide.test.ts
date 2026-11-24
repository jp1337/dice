import { describe, expect, it } from "vitest";
import type { UserId } from "../../src/shared/contracts.js";
import { decide, gameCommandTypes, shuffle, type GameCommand } from "../../src/shared/game/decide.js";
import { initialGameState } from "../../src/shared/game/reduce.js";
import { A, B, C, D, Game, HOST, log, scripted, seeded, users } from "./helpers.js";

const errorOf = (r: ReturnType<Game["try"]>) => ("error" in r ? r.error.code : "ok");
const running = (players = [A, B, C], s = {}) => new Game(s).startFixed(players);
const finished = () => running([A, B], { lastPlayer: "auto" }).roll(6);
const ended = () => running().do(HOST, { type: "end" });

describe("authorization", () => {
  const hostCommands: GameCommand[] = [
    { type: "start" },
    { type: "roll_for", userId: A },
    { type: "assign_last_place" },
    { type: "pause" },
    { type: "continue" },
    { type: "skip", userId: A },
    { type: "remove_player", userId: B },
    { type: "add_player", userId: D },
    { type: "undo" },
    { type: "end" },
    { type: "reset" },
  ];

  it.each(hostCommands)("$type needs a host or co-host", (command) => {
    const g = running().roll(2);
    expect(g.try(A, command)).toEqual({ error: { code: "not_host", message: "Das dürfen nur Hosts." } });
    expect(g.events).toHaveLength(2);
  });

  it("covers every game command (the two player commands are open to everyone)", () => {
    expect(new Set([...hostCommands.map((c) => c.type), "roll", "claim_last_place"])).toEqual(new Set(gameCommandTypes));
  });

  it("a co-host (actorIsHost) may use the host tools; events carry the actor", () => {
    const g = running();
    g.do(D, { type: "pause" }, { host: true });
    expect(g.events.at(-1)).toMatchObject({ type: "paused", actorUserId: D });
  });
});

describe("start", () => {
  it("shuffles the players with Fisher–Yates over the injected RNG only", () => {
    const calls: [number, number][] = [];
    const g = new Game({}, (min, max) => (calls.push([min, max]), min));
    g.do(HOST, { type: "start" }, { players: [A, B, C, D] });
    expect(calls).toEqual([
      [0, 4],
      [0, 3],
      [0, 2],
    ]);
    // j = 0 every time: [A,B,C,D] → [D,B,C,A] → [C,B,D,A] → [B,C,D,A]
    expect(g.events[0]).toMatchObject({ type: "game_started", actorUserId: HOST, payload: { order: [B, C, D, A] } });
    expect(g.state).toMatchObject({ status: "running", activeUserId: B });
  });

  it("is a permutation for every seed and reaches every order", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 500; seed++) {
      const order = shuffle([A, B, C], seeded(seed));
      expect([...order].sort()).toEqual([A, B, C]);
      seen.add(order.join());
    }
    expect(seen.size).toBe(6);
  });

  it("drops duplicate players", () => {
    const g = new Game({}, seeded(1)).do(HOST, { type: "start" }, { players: [A, B, A] });
    expect([...g.state.turnOrder].sort()).toEqual([A, B]);
  });

  it("refuses without players or when a game is running or finished", () => {
    expect(errorOf(new Game().try(HOST, { type: "start" }))).toBe("no_players");
    expect(errorOf(running().try(HOST, { type: "start" }, { players: [A] }))).toBe("game_running");
    expect(errorOf(finished().try(HOST, { type: "start" }, { players: [A] }))).toBe("game_running");
  });
});

describe("roll", () => {
  it("only the active player rolls; the server draws the dice in 1..6", () => {
    const g = running();
    expect(errorOf(g.try(B, { type: "roll" }))).toBe("not_your_turn");
    expect(errorOf(g.try(HOST, { type: "roll" }))).toBe("not_your_turn");
    g.randomInt = scripted(4);
    g.do(A, { type: "roll" });
    expect(g.events.at(-1)).toMatchObject({ type: "rolled", actorUserId: A, payload: { userId: A, dice: [4] } });
    expect(g.events.at(-1)?.payload).not.toHaveProperty("rolledBy");
  });

  it("rolls two dice with a bonus", () => {
    const g = running([A, B]).roll(1).roll(3);
    g.randomInt = scripted(2, 5);
    g.do(A, { type: "roll" });
    expect(g.events.at(-1)?.payload).toMatchObject({ dice: [2, 5] });
  });

  it("is refused while paused, in the lobby and after the game", () => {
    expect(errorOf(running().roll(6).try(B, { type: "roll" }))).toBe("paused");
    expect(errorOf(running().do(HOST, { type: "pause" }).try(A, { type: "roll" }))).toBe("paused");
    expect(errorOf(new Game().try(A, { type: "roll" }))).toBe("no_game");
    expect(errorOf(finished().try(B, { type: "roll" }))).toBe("game_over");
  });
});

describe("roll_for", () => {
  it("a host rolls for the active player under the same rules", () => {
    const g = running([A, B]).roll(1).roll(3);
    g.randomInt = scripted(6, 1);
    g.do(HOST, { type: "roll_for", userId: A });
    expect(g.events.at(-1)).toMatchObject({ actorUserId: HOST, payload: { userId: A, dice: [6, 1], rolledBy: HOST } });
    expect(g.state).toMatchObject({ giftOrder: [A], pause: "six" });
  });

  it("a host who is the active player gets an ordinary roll", () => {
    const g = running([HOST, A]);
    g.randomInt = scripted(3);
    g.do(HOST, { type: "roll_for", userId: HOST });
    expect(g.events.at(-1)?.payload).toEqual({ userId: HOST, dice: [3] });
  });

  it("is refused while paused", () => {
    expect(errorOf(running().roll(6).try(HOST, { type: "roll_for", userId: B }))).toBe("paused");
  });

  it("names the player it rolls for; a late click after the turn moved on is refused", () => {
    const g = running([A, B]).roll(3); // B is active now
    expect(g.try(HOST, { type: "roll_for", userId: A })).toEqual({ error: { code: "turn_changed", message: "Inzwischen ist jemand anderes dran." } });
    expect(g.events).toHaveLength(2);
  });
});

describe("last place (R5)", () => {
  const lastB = () => running([A, B]).roll(6);

  it("only the last player claims, not during a pause", () => {
    expect(errorOf(running([A, B]).try(A, { type: "claim_last_place" }))).toBe("not_last_player");
    expect(errorOf(lastB().try(A, { type: "claim_last_place" }))).toBe("not_last_player");
    expect(errorOf(lastB().try(B, { type: "claim_last_place" }))).toBe("paused");
    const g = lastB().do(HOST, { type: "continue" }).do(B, { type: "claim_last_place" });
    expect(g.events.at(-1)).toMatchObject({ type: "last_place_taken", actorUserId: B, payload: { userId: B } });
    expect(g.state).toMatchObject({ status: "finished", giftOrder: [A, B] });
    expect(errorOf(g.try(B, { type: "claim_last_place" }))).toBe("game_over");
  });

  it("hosts assign the last place at any time once one player is left", () => {
    expect(errorOf(running([A, B]).try(HOST, { type: "assign_last_place" }))).toBe("no_last_player");
    const g = lastB().do(HOST, { type: "assign_last_place" });
    expect(g.events.at(-1)).toMatchObject({ actorUserId: HOST, payload: { userId: B } });
    expect(g.state.giftOrder).toEqual([A, B]);
  });
});

describe("pause and continue", () => {
  it("pause needs an unpaused running game", () => {
    expect(errorOf(new Game().try(HOST, { type: "pause" }))).toBe("no_game");
    expect(errorOf(running().roll(6).try(HOST, { type: "pause" }))).toBe("already_paused");
    expect(running().do(HOST, { type: "pause" }).state.pause).toBe("host");
  });

  it("continue ends a host pause and a six pause", () => {
    expect(errorOf(running().try(HOST, { type: "continue" }))).toBe("not_paused");
    expect(running().do(HOST, { type: "pause" }).do(HOST, { type: "continue" }).state.pause).toBeNull();
    expect(running().roll(6).do(HOST, { type: "continue" }).state).toMatchObject({ pause: null, activeUserId: B });
  });
});

describe("skip", () => {
  it("skips the active player", () => {
    const g = running().do(HOST, { type: "skip", userId: A });
    expect(g.events.at(-1)).toMatchObject({ type: "skipped", payload: { userId: A } });
    expect(g.state.activeUserId).toBe(B);
    expect(errorOf(finished().try(HOST, { type: "skip", userId: A }))).toBe("game_over");
  });

  it("two hosts skipping at once skip one player, not two", () => {
    const g = running([A, B, C]).do(HOST, { type: "skip", userId: A });
    expect(errorOf(g.try(D, { type: "skip", userId: A }, { host: true }))).toBe("turn_changed");
    expect(g.state.activeUserId).toBe(B);
  });
});

describe("remove_player and add_player", () => {
  it("removes only players who are still rolling", () => {
    const g = running().roll(6);
    expect(errorOf(g.try(HOST, { type: "remove_player", userId: A }))).toBe("not_in_game");
    expect(errorOf(g.try(HOST, { type: "remove_player", userId: D }))).toBe("not_in_game");
    g.do(HOST, { type: "remove_player", userId: C });
    expect(g.state).toMatchObject({ turnOrder: [B], removed: [C] });
  });

  it("adds latecomers and removed players, but nobody rolling or holding a place", () => {
    const g = running().roll(6);
    expect(errorOf(g.try(HOST, { type: "add_player", userId: A }))).toBe("already_in_game");
    expect(errorOf(g.try(HOST, { type: "add_player", userId: B }))).toBe("already_in_game");
    g.do(HOST, { type: "add_player", userId: D }).do(HOST, { type: "remove_player", userId: B });
    g.do(HOST, { type: "add_player", userId: B });
    expect(g.state.turnOrder).toEqual([C, D, B]);
  });
});

describe("undo", () => {
  it("targets the newest roll in effect and needs one", () => {
    expect(errorOf(new Game().try(HOST, { type: "undo" }))).toBe("no_game");
    expect(errorOf(running().try(HOST, { type: "undo" }))).toBe("nothing_to_undo");
    const g = running().roll(2).do(HOST, { type: "undo" });
    expect(g.events.at(-1)).toMatchObject({ type: "undone", actorUserId: HOST, payload: { seq: 2 } });
    expect(g.state).toMatchObject({ activeUserId: A, lastRoll: null, undoneSeqs: [2] });
    expect(errorOf(g.try(HOST, { type: "undo" }))).toBe("nothing_to_undo");
  });

  it("undo chains walk back roll by roll", () => {
    const g = running().roll(2).roll(3).do(HOST, { type: "undo" }).do(HOST, { type: "undo" });
    expect(g.events.slice(-2).map((x) => x.payload)).toEqual([{ seq: 3 }, { seq: 2 }]);
    expect(g.state).toMatchObject({ activeUserId: A, undoneSeqs: [3, 2] });
  });

  it("refuses a stale target: a second host clicking undo on the same roll", () => {
    const g = running().roll(2).roll(3);
    expect(errorOf(g.try(HOST, { type: "undo", seq: 2 }))).toBe("undo_stale");
    g.do(HOST, { type: "undo", seq: 3 });
    expect(g.try(D, { type: "undo", seq: 3 }, { host: true })).toEqual({
      error: { code: "undo_stale", message: "Dieser Wurf ist schon zurückgenommen oder nicht mehr der letzte." },
    });
    g.do(HOST, { type: "undo", seq: 2 });
    expect(errorOf(g.try(HOST, { type: "undo", seq: 2 }))).toBe("undo_stale");
    expect(g.state.undoneSeqs).toEqual([3, 2]);
  });

  it("two undo commands decided against the same state take back one roll", () => {
    const g = running().roll(2).roll(3);
    const state = g.state;
    const ctx = { actorUserId: HOST, actorIsHost: true, players: [], randomInt: seeded(1) };
    for (const r of [decide(state, { type: "undo" }, ctx), decide(state, { type: "undo" }, ctx)])
      if ("events" in r) g.events.push(...log([...g.events, ...r.events]).slice(-1));
    expect(g.events.filter((x) => x.type === "undone")).toHaveLength(2);
    expect(g.state).toMatchObject({ undoneSeqs: [3], activeUserId: B, lastRoll: { userId: A } });
  });

  it("works on a game finished by the rules, not after end", () => {
    expect(finished().do(HOST, { type: "undo" }).state).toMatchObject({ status: "running", activeUserId: A });
    expect(errorOf(running().roll(2).do(HOST, { type: "end" }).try(HOST, { type: "undo" }))).toBe("game_over");
  });
});

describe("end and reset", () => {
  it("end needs a running game", () => {
    expect(errorOf(new Game().try(HOST, { type: "end" }))).toBe("no_game");
    expect(errorOf(ended().try(HOST, { type: "end" }))).toBe("game_over");
    expect(running().roll(6).do(HOST, { type: "end" }).state).toMatchObject({ status: "finished", giftOrder: [A] });
  });

  it("reset returns a running or finished game to the lobby", () => {
    expect(errorOf(new Game().try(HOST, { type: "reset" }))).toBe("no_game");
    for (const g of [running(), ended(), finished()]) expect(g.do(HOST, { type: "reset" }).state.status).toBe("lobby");
  });
});

it("decide is pure: the same input gives the same output and the state is untouched", () => {
  const state = initialGameState();
  const ctx = { actorUserId: HOST, actorIsHost: true, players: users(5) as UserId[] };
  const a = decide(state, { type: "start" }, { ...ctx, randomInt: seeded(7) });
  const b = decide(state, { type: "start" }, { ...ctx, randomInt: seeded(7) });
  expect(a).toEqual(b);
  expect(state).toEqual(initialGameState());
});
