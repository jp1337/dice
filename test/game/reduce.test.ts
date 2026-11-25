import { describe, expect, it } from "vitest";
import { initialGameState } from "../../src/shared/game/reduce.js";
import { A, B, C, D, HOST, e, run } from "./helpers.js";

describe("lobby and start", () => {
  it("starts in the lobby and keeps lobby events in the history", () => {
    const s = run([e.cohost(A)]);
    expect(s).toEqual({ ...initialGameState(), history: s.history });
    expect(s.history.map((x) => x.type)).toEqual(["cohost_changed"]);
  });

  it("game_started sets the order, round 1 and the first player", () => {
    const s = run([e.start(B, A, C)]);
    expect(s).toMatchObject({ status: "running", round: 1, turnOrder: [B, A, C], activeUserId: B, activeDiceCount: 1 });
  });

  it("a player listed twice in game_started rolls once and gets one place", () => {
    const s = run([e.start(A, B, A), e.roll(A, 6), e.cont(), e.remove(B)]);
    expect(s).toMatchObject({ turnOrder: [], giftOrder: [A], removed: [B], status: "finished" });
  });

  it("ignores game events in the lobby and a second game_started", () => {
    const s = run([e.roll(A, 6), e.pause(), e.skip(A), e.add(A), e.remove(A), e.last(A), e.end(), e.start(A, B), e.start(C)]);
    expect(s).toMatchObject({ status: "running", turnOrder: [A, B], activeUserId: A, pause: null, giftOrder: [] });
  });
});

describe("turn order and rounds", () => {
  it("goes round in the drawn order and counts rounds when it wraps", () => {
    const s0 = run([e.start(A, B, C), e.roll(A, 3), e.roll(B, 4)]);
    expect(s0).toMatchObject({ activeUserId: C, round: 1 });
    const s1 = run([e.start(A, B, C), e.roll(A, 3), e.roll(B, 4), e.roll(C, 2)]);
    expect(s1).toMatchObject({ activeUserId: A, round: 2, lastRoll: { userId: C, dice: [2] } });
  });

  it("ignores a roll by someone who is not active", () => {
    const s = run([e.start(A, B), e.roll(B, 6)]);
    expect(s).toMatchObject({ activeUserId: A, giftOrder: [], lastRoll: null });
  });

  it("keeps rolledBy of a host roll in lastRoll", () => {
    expect(run([e.start(A, B), e.rollFor(A, 2)]).lastRoll).toEqual({ userId: A, dice: [2], rolledBy: HOST });
  });
});

describe("bonus (core rule 6, R3, R4)", () => {
  it("a 1 gives two dice on the next own turn, nobody else", () => {
    const s = run([e.start(A, B), e.roll(A, 1)]);
    expect(s).toMatchObject({ activeUserId: B, activeDiceCount: 1, bonusPending: [A] });
    expect(run([e.start(A, B), e.roll(A, 1), e.roll(B, 3)])).toMatchObject({ activeUserId: A, activeDiceCount: 2 });
  });

  // The last player rolls a 1 and takes the last place: a bonus for someone who never rolls again.
  it("a player who gets a place keeps no bonus", () => {
    const s = run([e.start(A, B), e.roll(A, 6), e.cont(), e.roll(B, 1), e.last(B)]);
    expect(s).toMatchObject({ status: "finished", bonusPending: [] });
  });

  it("the bonus lasts exactly one roll", () => {
    const s = run([e.start(A, B), e.roll(A, 1), e.roll(B, 3), e.roll(A, 3, 4), e.roll(B, 3)]);
    expect(s).toMatchObject({ activeUserId: A, activeDiceCount: 1, bonusPending: [] });
  });

  it.each([
    [true, [A]],
    [false, []],
  ])("bonusChains %s: a 1 without 6 on two dice grants the bonus again or not", (bonusChains, pending) => {
    const s = run([e.start(A, B), e.roll(A, 1), e.roll(B, 3), e.roll(A, 1, 4)], { bonusChains });
    expect(s.bonusPending).toEqual(pending);
    expect(run([e.start(A, B), e.roll(A, 1), e.roll(B, 3), e.roll(A, 1, 1)], { bonusChains }).bonusPending).toEqual(pending);
  });

  it("bonusChains false: a 1 on one die still grants the bonus", () => {
    expect(run([e.start(A, B), e.roll(A, 1)], { bonusChains: false }).bonusPending).toEqual([A]);
  });
});

describe("six (R1, R2)", () => {
  it("one die: next gift place, out of rolling, six pause, next player shown", () => {
    const s = run([e.start(A, B, C), e.roll(A, 6)]);
    expect(s).toMatchObject({ giftOrder: [A], turnOrder: [B, C], activeUserId: B, pause: "six", round: 1 });
  });

  it.each([
    [6, 2],
    [2, 6],
    [6, 6],
  ])("two dice %i+%i: one place, nothing extra", (d1, d2) => {
    const s = run([e.start(A, B, C), e.roll(A, 1), e.roll(B, 2), e.roll(C, 2), e.roll(A, d1, d2)]);
    expect(s).toMatchObject({ giftOrder: [A], turnOrder: [B, C], bonusPending: [], pause: "six" });
  });

  it("a 6 beats a simultaneous 1: no bonus", () => {
    const s = run([e.start(A, B, C), e.roll(A, 1), e.roll(B, 2), e.roll(C, 2), e.roll(A, 6, 1)]);
    expect(s).toMatchObject({ giftOrder: [A], bonusPending: [] });
  });

  it("nobody rolls during the six pause until continued", () => {
    const paused = [e.start(A, B, C), e.roll(A, 6), e.roll(B, 3)];
    expect(run(paused)).toMatchObject({ activeUserId: B, lastRoll: { userId: A } });
    expect(run([...paused, e.cont(), e.roll(B, 3)])).toMatchObject({ activeUserId: C, pause: null, lastRoll: { userId: B } });
  });

  it("the last player in the order rolling a 6 wraps to the next round", () => {
    const s = run([e.start(A, B, C), e.roll(A, 2), e.roll(B, 2), e.roll(C, 6)]);
    expect(s).toMatchObject({ activeUserId: A, round: 2, turnOrder: [A, B] });
  });
});

describe("last player (R5)", () => {
  const twoLeft = [e.start(A, B), e.roll(A, 6)];

  it("choice: the last player keeps rolling, rounds go on, a 6 ends the game", () => {
    const s = run([...twoLeft, e.cont(), e.roll(B, 3)]);
    expect(s).toMatchObject({ status: "running", activeUserId: B, round: 2 });
    const end = run([...twoLeft, e.cont(), e.roll(B, 3), e.roll(B, 6)]);
    expect(end).toMatchObject({ status: "finished", giftOrder: [A, B], turnOrder: [], activeUserId: null, pause: null });
  });

  it("choice: bonus rules still apply to the last player", () => {
    expect(run([...twoLeft, e.cont(), e.roll(B, 1)])).toMatchObject({ activeUserId: B, activeDiceCount: 2 });
  });

  it("choice: last_place_taken gives the last place and ends the game", () => {
    const s = run([...twoLeft, e.cont(), e.last(B)]);
    expect(s).toMatchObject({ status: "finished", giftOrder: [A, B], turnOrder: [] });
  });

  it("a host can assign the last place during the six pause", () => {
    expect(run([...twoLeft, e.last(B)])).toMatchObject({ status: "finished", pause: null, giftOrder: [A, B] });
  });

  it("last_place_taken is ignored while more than one player rolls or for the wrong player", () => {
    expect(run([e.start(A, B), e.last(A)])).toMatchObject({ status: "running", giftOrder: [] });
    expect(run([...twoLeft, e.last(A)])).toMatchObject({ status: "running", giftOrder: [A] });
  });

  it("auto: the last player gets the place at once", () => {
    const s = run(twoLeft, { lastPlayer: "auto" });
    expect(s).toMatchObject({ status: "finished", giftOrder: [A, B], pause: null, activeUserId: null });
  });

  it("a single player: choice waits, auto finishes at the start", () => {
    expect(run([e.start(A)])).toMatchObject({ status: "running", activeUserId: A });
    expect(run([e.start(A)], { lastPlayer: "auto" })).toMatchObject({ status: "finished", giftOrder: [A] });
  });

  it("a latecomer ends the last-player situation", () => {
    const s = run([...twoLeft, e.add(C), e.cont(), e.roll(B, 2)]);
    expect(s).toMatchObject({ turnOrder: [B, C], activeUserId: C });
  });
});

describe("skip (R4)", () => {
  it("skips the active player once and keeps a pending bonus", () => {
    const base = [e.start(A, B, C), e.roll(A, 1), e.roll(B, 2), e.roll(C, 2), e.skip(A)];
    expect(run(base)).toMatchObject({ activeUserId: B, round: 2, bonusPending: [A] });
    const back = run([...base, e.roll(B, 2), e.roll(C, 2)]);
    expect(back).toMatchObject({ activeUserId: A, activeDiceCount: 2, round: 3 });
    expect(run([...base, e.roll(B, 2), e.roll(C, 2), e.roll(A, 3, 4)]).bonusPending).toEqual([]);
  });

  it("ignores a skip for someone who is not active", () => {
    expect(run([e.start(A, B), e.skip(B)]).activeUserId).toBe(A);
  });

  it("works during a pause", () => {
    expect(run([e.start(A, B, C), e.pause(), e.skip(A)])).toMatchObject({ activeUserId: B, pause: "host" });
  });
});

describe("removing players", () => {
  it("a removed player gets no place and loses a pending bonus", () => {
    const s = run([e.start(A, B, C), e.roll(A, 1), e.remove(A)]);
    expect(s).toMatchObject({ turnOrder: [B, C], activeUserId: B, removed: [A], bonusPending: [] });
  });

  it("removing someone before the active player keeps the active player", () => {
    expect(run([e.start(A, B, C), e.roll(A, 2), e.remove(A)])).toMatchObject({ activeUserId: B, turnOrder: [B, C] });
    expect(run([e.start(A, B, C), e.remove(C)])).toMatchObject({ activeUserId: A, turnOrder: [A, B] });
  });

  it("removing the active player hands the turn to the next", () => {
    expect(run([e.start(A, B, C), e.remove(A)])).toMatchObject({ activeUserId: B, round: 1 });
    expect(run([e.start(A, B, C), e.roll(A, 2), e.roll(B, 2), e.remove(C)])).toMatchObject({ activeUserId: A, round: 2 });
  });

  it("removing the last-but-one player leaves the last player (choice) or ends the game (auto)", () => {
    expect(run([e.start(A, B, C), e.roll(A, 6), e.remove(B)])).toMatchObject({ status: "running", activeUserId: C });
    const auto = run([e.start(A, B, C), e.roll(A, 6), e.remove(B)], { lastPlayer: "auto" });
    expect(auto).toMatchObject({ status: "finished", giftOrder: [A, C], removed: [B] });
  });

  it("removing the only player ends the game", () => {
    expect(run([e.start(A, B), e.roll(A, 6), e.remove(B)])).toMatchObject({ status: "finished", giftOrder: [A], removed: [B] });
  });

  it("ignores removing someone who is not rolling", () => {
    expect(run([e.start(A, B, C), e.roll(A, 6), e.remove(A), e.remove(D)])).toMatchObject({ turnOrder: [B, C], removed: [] });
  });
});

describe("latecomers", () => {
  it("are appended to the end of the turn order", () => {
    const s = run([e.start(A, B), e.add(C), e.roll(A, 2), e.roll(B, 2)]);
    expect(s).toMatchObject({ turnOrder: [A, B, C], activeUserId: C, round: 1 });
  });

  it("a removed player can be added again", () => {
    expect(run([e.start(A, B), e.remove(A), e.add(A)])).toMatchObject({ turnOrder: [B, A], removed: [] });
  });

  it("ignores adding someone already rolling or holding a place", () => {
    expect(run([e.start(A, B, C), e.roll(A, 6), e.add(A), e.add(B)]).turnOrder).toEqual([B, C]);
  });
});

describe("pause and continue", () => {
  it("host pause blocks rolls until continued", () => {
    expect(run([e.start(A, B), e.pause(), e.roll(A, 3)])).toMatchObject({ pause: "host", activeUserId: A, lastRoll: null });
    expect(run([e.start(A, B), e.pause(), e.cont(), e.roll(A, 3)])).toMatchObject({ pause: null, activeUserId: B });
  });

  it("a pause during the six pause keeps the six pause; continue without pause changes nothing", () => {
    expect(run([e.start(A, B, C), e.roll(A, 6), e.pause()]).pause).toBe("six");
    expect(run([e.start(A, B), e.cont()])).toMatchObject({ pause: null, activeUserId: A });
  });
});

describe("undo", () => {
  // run() numbers the events from seq 1, so e.undo(n) targets the n-th event.
  it("undoes a normal roll: the player is active again", () => {
    const s = run([e.start(A, B), e.roll(A, 3), e.undo(2)]);
    expect(s).toMatchObject({ activeUserId: A, lastRoll: null, round: 1, undoneSeqs: [2] });
  });

  it("undoes a six with its place and its pause", () => {
    const s = run([e.start(A, B, C), e.roll(A, 6), e.undo(2)]);
    expect(s).toMatchObject({ activeUserId: A, giftOrder: [], turnOrder: [A, B, C], pause: null });
    // continued after the six no longer applies
    expect(run([e.start(A, B, C), e.roll(A, 6), e.cont(), e.undo(2)])).toMatchObject({ activeUserId: A, pause: null });
  });

  it("undoes a bonus-granting 1, and a bonus-consuming roll gives the bonus back", () => {
    expect(run([e.start(A, B), e.roll(A, 1), e.undo(2)]).bonusPending).toEqual([]);
    const back = run([e.start(A, B), e.roll(A, 1), e.roll(B, 2), e.roll(A, 3, 4), e.undo(4)]);
    expect(back).toMatchObject({ activeUserId: A, activeDiceCount: 2, lastRoll: { userId: B } });
  });

  it("undo chains: each undo takes the newest roll still in effect (never a redo)", () => {
    const s = run([e.start(A, B, C), e.roll(A, 1), e.roll(B, 6), e.undo(3), e.undo(2)]);
    expect(s).toMatchObject({ activeUserId: A, giftOrder: [], bonusPending: [], lastRoll: null, undoneSeqs: [3, 2] });
  });

  it("after undo and a new roll, the next undo takes the new roll", () => {
    const s = run([e.start(A, B), e.roll(A, 2), e.roll(B, 6), e.undo(3), e.roll(B, 3), e.undo(5)]);
    expect(s).toMatchObject({ activeUserId: B, giftOrder: [], lastRoll: { userId: A, dice: [2] }, undoneSeqs: [3, 5] });
  });

  it("two hosts undoing at once take back exactly one roll", () => {
    const s = run([e.start(A, B, C), e.roll(A, 2), e.roll(B, 3), e.undo(3), e.undo(3)]);
    expect(s).toMatchObject({ activeUserId: B, lastRoll: { userId: A }, undoneSeqs: [3] });
  });

  it("ignores an undo whose target is not the newest roll in effect", () => {
    const s = run([e.start(A, B, C), e.roll(A, 2), e.roll(B, 3), e.undo(2), e.undo(1), e.undo(9)]);
    expect(s).toMatchObject({ activeUserId: C, lastRoll: { userId: B }, undoneSeqs: [] });
    expect(run([e.start(A, B), e.undo(1), e.roll(A, 2)])).toMatchObject({ activeUserId: B, lastRoll: { userId: A } });
  });

  it("history keeps undone rolls and lists them in undoneSeqs", () => {
    const s = run([e.start(A, B), e.roll(A, 2), e.roll(B, 3), e.undo(3)]);
    expect(s.history.map((x) => x.type)).toEqual(["game_started", "rolled", "rolled", "undone"]);
    expect(s.undoneSeqs).toEqual([3]);
  });

  it("undo of the finishing six reopens the game; a stale claim is ignored", () => {
    expect(run([e.start(A, B), e.roll(A, 6), e.undo(2)], { lastPlayer: "auto" })).toMatchObject({
      status: "running",
      activeUserId: A,
      giftOrder: [],
    });
    expect(run([e.start(A, B), e.roll(A, 6), e.last(B), e.undo(2)])).toMatchObject({ status: "running", giftOrder: [] });
  });

  it("a stale skip is ignored after an undo", () => {
    expect(run([e.start(A, B), e.roll(A, 2), e.skip(B), e.undo(2)])).toMatchObject({ activeUserId: A });
  });

  it("is ignored after game_ended", () => {
    expect(run([e.start(A, B), e.roll(A, 6), e.end(), e.undo(2)])).toMatchObject({ giftOrder: [A], undoneSeqs: [] });
  });
});

describe("end and reset", () => {
  it("game_ended finishes with the gift order so far and ignores later game events", () => {
    const s = run([e.start(A, B, C), e.roll(A, 6), e.end(), e.cont(), e.roll(B, 6), e.pause(), e.add(D), e.end()]);
    expect(s).toMatchObject({ status: "finished", giftOrder: [A], pause: null, activeUserId: null });
  });

  it("game_reset returns to the lobby and ignores everything before", () => {
    const s = run([e.start(A, B), e.roll(A, 6), e.reset()]);
    expect(s).toEqual({ ...initialGameState(), history: [expect.objectContaining({ type: "game_reset" })] });
    expect(run([e.start(A, B), e.roll(A, 3), e.reset(), e.undo(2), e.start(C, D)])).toMatchObject({
      status: "running",
      turnOrder: [C, D],
      lastRoll: null,
    });
  });
});

describe("settings", () => {
  it("moderation events and the non-rule settings do not change the game", () => {
    const events = [e.start(A, B), e.roll(A, 2), e.cohost(B)];
    const s = run(events);
    expect(run(events, { reactions: false, sixMessage: "x" })).toEqual(s);
    expect(s.history).toHaveLength(3);
  });
});
