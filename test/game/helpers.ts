// Fixtures for the game-rule tests: fictitious user IDs, an event builder and a deterministic RNG.
import { defaultSettings, type GameEvent, type GameState, type Settings, type UserId } from "../../src/shared/contracts.js";
import { decide, type DecideContext, type GameCommand, type NewEvent } from "../../src/shared/game/decide.js";
import { reduce } from "../../src/shared/game/reduce.js";

const uid = (n: number): UserId => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(uid) as [UserId, UserId, UserId, UserId, UserId];
export const HOST = uid(0xff);
export const users = (n: number) => Array.from({ length: n }, (_, i) => uid(i + 1));

const ev = <T extends NewEvent["type"]>(type: T, payload: Extract<NewEvent, { type: T }>["payload"], actor: UserId | null = HOST) =>
  ({ type, actorUserId: actor, payload }) as NewEvent;

export const e = {
  start: (...order: UserId[]) => ev("game_started", { order }),
  roll: (userId: UserId, ...dice: number[]) => ev("rolled", { userId, dice }, userId),
  rollFor: (userId: UserId, ...dice: number[]) => ev("rolled", { userId, dice, rolledBy: HOST }),
  cont: () => ev("continued", {}),
  pause: () => ev("paused", {}),
  skip: (userId: UserId) => ev("skipped", { userId }),
  remove: (userId: UserId) => ev("player_removed", { userId }),
  add: (userId: UserId) => ev("player_added", { userId }),
  last: (userId: UserId) => ev("last_place_taken", { userId }),
  undo: (seq: number) => ev("undone", { seq }),
  end: () => ev("game_ended", {}),
  reset: () => ev("game_reset", {}),
  cohost: (userId: UserId) => ev("cohost_changed", { userId, isCohost: true }),
};

export const log = (events: readonly NewEvent[]): GameEvent[] =>
  events.map((x, i) => ({ ...x, seq: i + 1, createdAt: "2026-12-01T18:00:00.000Z" }) as GameEvent);

export const settingsWith = (s: Partial<Settings> = {}): Settings => ({ ...defaultSettings, ...s });
export const run = (events: readonly NewEvent[], s: Partial<Settings> = {}) => reduce(log(events), settingsWith(s));

// Deterministic PRNG (mulberry32) behind the randomInt signature of crypto.randomInt.
export function seeded(seed: number): DecideContext["randomInt"] {
  let t = seed >>> 0;
  return (min, max) => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    const f = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    return min + Math.floor(f * (max - min));
  };
}

// Returns the given values in order and checks each lies in the requested range.
export function scripted(...values: number[]): DecideContext["randomInt"] {
  return (min, max) => {
    const v = values.shift();
    if (v === undefined || v < min || v >= max) throw new Error(`scripted RNG: ${v} not in [${min}, ${max})`);
    return v;
  };
}

// Drives decide() and reduce() like the server does: validate, append, recompute.
export class Game {
  events: GameEvent[] = [];
  settings: Settings;
  constructor(
    s: Partial<Settings> = {},
    public randomInt: DecideContext["randomInt"] = scripted(),
  ) {
    this.settings = settingsWith(s);
  }
  get state(): GameState {
    return reduce(this.events, this.settings);
  }
  try(actor: UserId, command: GameCommand, opts: { host?: boolean; players?: UserId[] } = {}) {
    const result = decide(this.state, command, {
      actorUserId: actor,
      actorIsHost: opts.host ?? actor === HOST,
      players: opts.players ?? [],
      randomInt: this.randomInt,
    });
    if ("events" in result)
      for (const x of result.events)
        this.events.push({ ...x, seq: this.events.length + 1, createdAt: "2026-12-01T18:00:00.000Z" } as GameEvent);
    return result;
  }
  do(actor: UserId, command: GameCommand, opts: { host?: boolean; players?: UserId[] } = {}) {
    const result = this.try(actor, command, opts);
    if ("error" in result) throw new Error(`${command.type}: ${result.error.code}`);
    return this;
  }
  // Starts with a fixed order: a scripted shuffle that keeps the given order.
  startFixed(order: UserId[]) {
    const keep = this.randomInt;
    this.randomInt = (_min, max) => max - 1; // j = i at every Fisher–Yates step: identity
    this.do(HOST, { type: "start" }, { players: order });
    this.randomInt = keep;
    return this;
  }
  // Rolls for the active player (as that player) with the given dice values.
  roll(...dice: number[]) {
    if (dice.length !== this.state.activeDiceCount) throw new Error(`expected ${this.state.activeDiceCount} dice`);
    const keep = this.randomInt;
    this.randomInt = scripted(...dice);
    this.do(this.state.activeUserId as UserId, { type: "roll" });
    this.randomInt = keep;
    return this;
  }
}
