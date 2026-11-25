// The logic behind the room views, without a DOM: routing, the WebSocket client (backoff, close codes,
// reconnect), what each viewer may click, history and result texts, the roll animation timing.
import { NEXT_ROLL_COUNTDOWN_MS, ROLL_ANIMATION_MS, ROLL_COOLDOWN_MS } from "../src/shared/constants.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/shared/contracts.js";
import type { GameEvent, MemberView, RoomView } from "../src/shared/contracts.js";
import { initialGameState, reduce } from "../src/shared/game/reduce.js";
import {
  BACKOFF_CAP_MS,
  ERROR_PAGE_AFTER,
  type ProbeResult,
  type SocketLike,
  type Status,
  backoffDelay,
  classifyClose,
  closeMessage,
  createConnection,
  parseServerMessage,
  showErrorPage,
  statusLabel,
} from "../src/web/lib/connection.js";
import {
  cleanText,
  createRoomResponseMessage,
  deriveRoom,
  finalSixOpen,
  errorText,
  giftList,
  historyLines,
  lastGiftText,
  rollCaption,
  latecomers,
  nicknameError,
  nicknameResponseMessage,
  pickOption,
  resultText,
  roomNameError,
  sixBannerValues,
  sixMessageError,
  turnList,
  turnText,
} from "../src/web/lib/room.js";
import { countdown, displayedView, initialRoll, rollBusy, rollLocked, rollStep, shownDice } from "../src/web/lib/roll.js";
import { loginHref, parseRoute, socketUrl } from "../src/web/lib/routes.js";

// Fictitious ids and names only.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [HOST, ANNA, BEN, CARL, SIM] = [1, 2, 3, 4, 5].map(id) as [string, string, string, string, string];
const SLUG = "AbCdEfGhIjKlMnOp";

function member(userId: string, displayName: string, extra: Partial<MemberView> = {}): MemberView {
  return { userId, displayName, avatarUrl: null, participation: "player", isHost: false, isCohost: false, isSimulated: false, connected: true, ...extra };
}

let seq = 0;
function ev<T extends GameEvent["type"]>(type: T, payload: Extract<GameEvent, { type: T }>["payload"], actorUserId: string | null = HOST) {
  return { seq: ++seq, type, payload, actorUserId, createdAt: "2026-12-20T18:05:00.000Z" } as GameEvent;
}

function makeView(over: { game?: Partial<RoomView["game"]>; room?: Partial<RoomView["room"]>; viewer?: RoomView["viewer"]; members?: MemberView[] } = {}): RoomView {
  return {
    room: { slug: SLUG, name: "Weihnachten", isTest: false, status: over.game?.status ?? "lobby", settings: defaultSettings, isPublic: true, ...over.room },
    members: over.members ?? [member(HOST, "Hanna", { isHost: true, participation: "spectator" }), member(ANNA, "Anna"), member(BEN, "Ben"), member(CARL, "Carl", { participation: "spectator" })],
    game: { ...initialGameState(), ...over.game },
    viewer: over.viewer ?? { kind: "member", userId: ANNA, isHost: false, canModerate: false },
  };
}
const asHost: RoomView["viewer"] = { kind: "member", userId: HOST, isHost: true, canModerate: true };
const asCohost: RoomView["viewer"] = { kind: "member", userId: CARL, isHost: false, canModerate: true };
const running = (game: Partial<RoomView["game"]> = {}) => ({ status: "running" as const, round: 1, turnOrder: [ANNA, BEN], activeUserId: ANNA, ...game });

describe("routes", () => {
  it("pick the page from the path", () => {
    expect(parseRoute("/")).toEqual({ page: "start" });
    expect(parseRoute(`/r/${SLUG}`)).toEqual({ page: "room", slug: SLUG });
    expect(parseRoute(`/z/${SLUG}`)).toEqual({ page: "start" }); // the old guest links are gone
    expect(parseRoute("/r/short")).toEqual({ page: "start" });
    expect(parseRoute(`/r/${SLUG}/../x`)).toEqual({ page: "start" });
  });

  it("keep the target over the login and pick ws or wss", () => {
    expect(loginHref("/")).toBe("/auth/login");
    expect(loginHref(`/r/${SLUG}`)).toBe(`/auth/login?next=%2Fr%2F${SLUG}`);
    expect(socketUrl({ protocol: "https:", host: "dice.example.org" }, "/ws/rooms/x")).toBe("wss://dice.example.org/ws/rooms/x");
    expect(socketUrl({ protocol: "http:", host: "localhost:3000" }, "/ws/rooms/x")).toBe("ws://localhost:3000/ws/rooms/x");
  });
});

describe("reconnect timing", () => {
  it("grows, stays within its jitter band and is capped", () => {
    expect(backoffDelay(1, () => 0)).toBe(250);
    expect(backoffDelay(1, () => 1)).toBe(500);
    expect(backoffDelay(4, () => 0)).toBe(2000);
    expect(backoffDelay(4, () => 1)).toBe(4000);
    expect(backoffDelay(30, () => 1)).toBe(BACKOFF_CAP_MS);
    expect(backoffDelay(30, () => 0)).toBe(BACKOFF_CAP_MS / 2);
    for (let attempt = 1; attempt < 12; attempt++) expect(backoffDelay(attempt + 1, () => 1)).toBeGreaterThanOrEqual(backoffDelay(attempt, () => 1));
  });

  it("sorts the server's close codes", () => {
    expect([1012, 1013].map(classifyClose)).toEqual(["reconnect-now", "reconnect-now"]);
    expect([1000, 1001, 1006, 1009, 1011].map(classifyClose)).toEqual(Array(5).fill("reconnect"));
    expect(classifyClose(4001)).toBe("login");
    expect([1008, 4004, 4999].map(classifyClose)).toEqual(["stop", "stop", "stop"]);
  });

  it("shows the server's German reason, else a default", () => {
    expect(closeMessage(1008, "Zu viele offene Tabs in diesem Raum.")).toBe("Zu viele offene Tabs in diesem Raum.");
    expect(closeMessage(4004, "")).toBe("Diesen Raum gibt es nicht mehr.");
    expect(closeMessage(4321, " ")).toBe("Die Verbindung wurde beendet.");
  });

  it("labels the status and decides when the error page replaces the waiting", () => {
    const retry = (attempt: number): Status => ({ kind: "retrying", attempt, delayMs: 1 });
    expect(statusLabel({ kind: "open" }, true)).toBe("verbunden");
    expect(statusLabel({ kind: "connecting", attempt: 0 }, false)).toBe("verbinde …");
    expect(statusLabel({ kind: "connecting", attempt: 2 }, true)).toBe("verbinde neu …");
    expect(statusLabel({ kind: "stopped", message: "x" }, true)).toBe("getrennt");
    expect(showErrorPage(retry(ERROR_PAGE_AFTER - 1), false)).toBe(false);
    expect(showErrorPage(retry(ERROR_PAGE_AFTER), false)).toBe(true);
    expect(showErrorPage(retry(10), true)).toBe(false); // with a state: keep the room, show "verbinde neu"
    expect(showErrorPage({ kind: "stopped", message: "x" }, true)).toBe(true);
    // Once shown, the error stays while the next attempt connects: no flicker every few seconds.
    expect(showErrorPage({ kind: "connecting", attempt: ERROR_PAGE_AFTER }, false)).toBe(true);
    expect(showErrorPage({ kind: "connecting", attempt: ERROR_PAGE_AFTER - 1 }, false)).toBe(false);
  });

  it("accepts only the server's message types", () => {
    expect(parseServerMessage('{"type":"rolled","userId":"x","dice":[3]}')).toEqual({ type: "rolled", userId: "x", dice: [3] });
    expect(parseServerMessage('{"type":"hello"}')).toBeNull();
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage("null")).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(2))).toBeNull();
  });
});

describe("the room connection", () => {
  type Fake = SocketLike & { sent: string[]; closedWith?: number; open(): void; message(data: unknown): void; drop(code: number, reason?: string): void };
  let sockets: Fake[];
  let statuses: Status[];
  let messages: unknown[];

  function fake(): Fake {
    const socket: Fake = {
      readyState: 0,
      sent: [],
      onopen: null,
      onmessage: null,
      onclose: null,
      send: (data) => void socket.sent.push(data),
      close: (code) => {
        socket.closedWith = code;
        socket.readyState = 3;
      },
      open() {
        socket.readyState = 1;
        socket.onopen?.(new Event("open"));
      },
      message: (data) => socket.onmessage?.({ data } as MessageEvent),
      drop(code, reason = "") {
        socket.readyState = 3;
        socket.onclose?.({ code, reason } as CloseEvent);
      },
    };
    sockets.push(socket);
    return socket;
  }
  const state = JSON.stringify({ type: "state", state: makeView() });
  const connect = (probe?: () => Promise<ProbeResult>, random = () => 1) => {
    const conn = createConnection({ url: "wss://dice.example.org/ws/rooms/x", makeSocket: fake, onStatus: (s) => statuses.push(s), onMessage: (m) => messages.push(m), probe, random });
    conn.start();
    return conn;
  };
  const last = () => sockets.at(-1)!;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    statuses = [];
    messages = [];
  });
  afterEach(() => vi.useRealTimers());

  it("delivers messages, sends only while open, and does not queue", () => {
    const conn = connect();
    expect(conn.send({ type: "roll" })).toBe(false);
    last().open();
    last().message(state);
    expect(conn.send({ type: "roll" })).toBe(true);
    expect(last().sent).toEqual(['{"type":"roll"}']);
    expect(messages).toHaveLength(1);
    expect(statuses.map((s) => s.kind)).toEqual(["connecting", "open"]);
  });

  it("reconnects with a growing delay until a state arrives, then starts over", async () => {
    connect();
    for (const expected of [500, 1000, 2000]) {
      last().open();
      last().drop(1011); // opened, but closed before any state: still counts as a failure
      await vi.advanceTimersByTimeAsync(0);
      expect(statuses.at(-1)).toMatchObject({ kind: "retrying", delayMs: expected });
      await vi.advanceTimersByTimeAsync(expected);
    }
    expect(sockets).toHaveLength(4);
    last().open();
    last().message(state);
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toMatchObject({ kind: "retrying", attempt: 1, delayMs: 500 });
  });

  it("reconnects within a second after a server-side reload, spread out, but not in a tight loop", async () => {
    connect(undefined, () => 0.25);
    last().open();
    last().message(state);
    last().drop(1012);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toMatchObject({ kind: "retrying", delayMs: 250 }); // jitter: every client at once would hammer the restart
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(2);
    last().open();
    last().drop(1013); // no state in between
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toMatchObject({ kind: "retrying", attempt: 2, delayMs: backoffDelay(2, () => 0.25) });
  });

  it("ignores retryNow while the HTTP probe is still asking", async () => {
    let answer: (result: ProbeResult) => void = () => {};
    const conn = connect(() => new Promise((resolve) => (answer = resolve)));
    last().drop(1006);
    conn.retryNow(); // e.g. the tab became visible
    expect(sockets).toHaveLength(1);
    answer("ok");
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
  });

  it.each([
    [1008, "Zu viele offene Tabs in diesem Raum.", "stopped"],
    [4004, "", "stopped"],
    [4001, "Du hast dich abgemeldet. Melde dich wieder an, um weiterzumachen.", "login"],
  ])("stops on %i with a message", async (code, reason, kind) => {
    connect();
    last().open();
    last().message(state);
    last().drop(code, reason);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(statuses.at(-1)).toEqual({ kind, message: closeMessage(code, reason) });
  });

  it("asks over HTTP why an upgrade failed before it opened", async () => {
    const probe = vi.fn<() => Promise<ProbeResult>>().mockResolvedValueOnce("ok").mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce("login");
    connect(probe);
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2); // ok: retry
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(3); // offline: retry
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(3);
    expect(statuses.at(-1)?.kind).toBe("login");
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("does not ask the probe after a connection that worked", async () => {
    const probe = vi.fn<() => Promise<ProbeResult>>().mockResolvedValue("gone");
    connect(probe);
    last().open();
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(probe).not.toHaveBeenCalled();
    last().drop(1006); // never opened
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({ kind: "stopped", message: "Diesen Raum gibt es nicht." });
  });

  it("stops for good on stop(), and retryNow() skips the wait", async () => {
    const conn = connect();
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    conn.retryNow();
    expect(sockets).toHaveLength(2);
    conn.retryNow(); // a socket is already on its way
    expect(sockets).toHaveLength(2);
    conn.stop();
    expect(sockets[1]!.closedWith).toBe(1000);
    sockets[1]!.drop(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
  });
});

describe("what a viewer may click", () => {
  it("a player in the lobby: own participation and nickname, no host tools", () => {
    const d = deriveRoom(makeView(), true);
    expect(d.me?.displayName).toBe("Anna");
    expect(d.can).toMatchObject({ setOwnParticipation: true, editNickname: true, start: false, settings: false, setCohost: false, roll: false });
    expect(d.showModeration).toBe(false);
    expect(d.players.map((m) => m.userId)).toEqual([ANNA, BEN]);
  });

  it("the active player rolls, except during a pause, and reacts like everyone", () => {
    const d = deriveRoom(makeView({ game: running() }), true);
    expect(d).toMatchObject({ isActive: true });
    expect(turnText(makeView({ game: running() }), ANNA)).toBe("Du bist dran!");
    expect(d.can).toMatchObject({ roll: true, react: true, claimLastPlace: false, setOwnParticipation: false });
    expect(deriveRoom(makeView({ game: running({ pause: "host" }) }), true).can.roll).toBe(false);
    expect(deriveRoom(makeView({ game: running() }), false).can.roll).toBe(false); // offline
  });

  it("everyone else sees whose turn it is and may react, unless the room switched reactions off", () => {
    const view = makeView({ game: running(), viewer: { kind: "member", userId: BEN, isHost: false, canModerate: false } });
    expect(deriveRoom(view, true)).toMatchObject({ can: { roll: false, react: true } });
    expect(turnText(view, BEN)).toBe("Am Zug: Anna");
    expect(deriveRoom({ ...view, room: { ...view.room, settings: { ...defaultSettings, reactions: false } } }, true).can.react).toBe(false);
  });

  it("the last player may take the last place in choice mode only", () => {
    const view = makeView({ game: running({ turnOrder: [ANNA], giftOrder: [BEN] }) });
    expect(deriveRoom(view, true).can.claimLastPlace).toBe(true);
    expect(deriveRoom({ ...view, room: { ...view.room, settings: { ...defaultSettings, lastPlayer: "auto" } } }, true).can.claimLastPlace).toBe(false);
    expect(deriveRoom({ ...view, viewer: asHost }, true).can).toMatchObject({ claimLastPlace: false, assignLastPlace: true });
  });

  it("hosts and co-hosts get the tools; only hosts appoint co-hosts", () => {
    const lobby = deriveRoom(makeView({ viewer: asHost }), true);
    expect(lobby.can).toMatchObject({ start: true, settings: true, setParticipation: true, setCohost: true, simulatedPlayers: false, undo: false });
    expect(deriveRoom(makeView({ viewer: asCohost }), true).can).toMatchObject({ start: true, setCohost: false });
    expect(deriveRoom(makeView({ viewer: asHost, room: { isTest: true } }), true).can.simulatedPlayers).toBe(true);
    expect(deriveRoom(makeView({ viewer: asHost, members: [member(HOST, "Hanna", { participation: "spectator" })] }), true).can.start).toBe(false);
  });

  it("in the game: pause or continue, roll for someone, undo the newest roll in effect", () => {
    const roll1 = ev("rolled", { userId: ANNA, dice: [3] }, ANNA);
    const roll2 = ev("rolled", { userId: BEN, dice: [2] }, BEN);
    const view = makeView({ viewer: asHost, game: running({ history: [roll1, roll2], undoneSeqs: [roll2.seq] }) });
    const d = deriveRoom(view, true);
    expect(d.can).toMatchObject({ pause: true, continue: false, rollFor: true, skip: true, undo: true, end: true, reset: true, settings: false, setParticipation: false });
    expect([d.newestRollSeq, d.newestRollName]).toEqual([roll1.seq, "Anna"]);
    const paused = deriveRoom(makeView({ viewer: asHost, game: running({ pause: "six" }) }), true);
    expect(paused.can).toMatchObject({ pause: false, continue: true, rollFor: false, undo: false });
    // A host whose own turn it is rolls with the big button; "Für <sich> würfeln" would only duplicate it.
    const ownTurn = deriveRoom(makeView({ viewer: asHost, game: running({ activeUserId: HOST, turnOrder: [HOST, ANNA] }) }), true);
    expect(ownTurn.can).toMatchObject({ rollFor: false, skip: true });
    const ended = makeView({ viewer: asHost, game: { status: "finished", history: [roll1, ev("game_ended", {})] } });
    expect(deriveRoom(ended, true).can).toMatchObject({ undo: false, end: false, reset: true });
    expect(deriveRoom(view, false).can.undo).toBe(false);
  });

  // The result page promised "Das Spiel geht dann weiter" for a roll whose undo left the game over.
  it("on the result page offers undo only for a roll the game ended on", () => {
    const start = [ev("game_started", { order: [ANNA, BEN] }), ev("rolled", { userId: ANNA, dice: [6] }, ANNA), ev("continued", {})];
    const afterThree = reduce([...start, ev("rolled", { userId: BEN, dice: [3] }, BEN), ev("last_place_taken", { userId: BEN }, BEN)], defaultSettings);
    expect(afterThree.status).toBe("finished");
    expect(deriveRoom(makeView({ viewer: asHost, game: afterThree }), true).can.undo).toBe(false);
    const afterSix = reduce([...start, ev("last_place_taken", { userId: BEN }, BEN)], defaultSettings);
    expect(afterSix.status).toBe("finished");
    expect(deriveRoom(makeView({ viewer: asHost, game: afterSix }), true).can.undo).toBe(true);
  });

  it("keeps the final six banner for its own roll only", () => {
    const start = [ev("game_started", { order: [ANNA, BEN] }), ev("rolled", { userId: ANNA, dice: [6] }, ANNA), ev("continued", {})];
    const six = ev("rolled", { userId: BEN, dice: [6] }, BEN);
    const done = makeView({ game: reduce([...start, six], defaultSettings) });
    expect(finalSixOpen(done, six.seq)).toBe(true);
    expect(finalSixOpen(done, null)).toBe(false); // closed
    // Back to the lobby, a new game, ended before anyone rolled: the old banner must not hold the screen.
    const next = makeView({ game: reduce([...start, six, ev("game_reset", {}), ev("game_started", { order: [ANNA, BEN] }), ev("game_ended", {})], defaultSettings) });
    expect(next.game.status).toBe("finished");
    expect(finalSixOpen(next, six.seq)).toBe(false);
    // The six taken back, then the last place assigned: not that six's banner either.
    const undone = makeView({ game: reduce([...start, six, ev("undone", { seq: six.seq }), ev("last_place_taken", { userId: BEN })], defaultSettings) });
    expect(undone.game.status).toBe("finished");
    expect(finalSixOpen(undone, six.seq)).toBe(false);
  });

  it("guests can do nothing", () => {
    const d = deriveRoom(makeView({ game: running(), viewer: { kind: "guest" } }), true);
    expect(d.isGuest).toBe(true);
    expect(Object.values(d.can).some(Boolean)).toBe(false);
  });
});

describe("next roll countdown", () => {
  it("counts the seconds after the dice land, until the server takes the next roll", () => {
    const t = 1_000_000;
    const tumbling = rollStep(initialRoll, { type: "rolled", dice: [3], at: t });
    expect(countdown(tumbling, t + 500)).toBe(0); // dice still in the air: no countdown yet
    const landed = rollStep(tumbling, { type: "settled" });
    expect(countdown(landed, t + ROLL_ANIMATION_MS)).toBe(NEXT_ROLL_COUNTDOWN_MS / 1000);
    expect(countdown(landed, t + ROLL_COOLDOWN_MS - 1)).toBe(1);
    expect(countdown(landed, t + ROLL_COOLDOWN_MS)).toBe(0);
    expect(countdown(rollStep(landed, { type: "cooled" }), t + ROLL_ANIMATION_MS)).toBe(0);
  });
});

describe("lists", () => {
  const view = makeView({
    game: running({ turnOrder: [BEN, ANNA], activeUserId: ANNA, bonusPending: [BEN], giftOrder: [SIM] }),
    members: [...makeView().members, member(SIM, "Testspieler 1", { isSimulated: true })],
  });

  it("turn order marks the active player, the 2-dice bonus and the connection", () => {
    expect(turnList(view)).toEqual([
      { userId: BEN, name: "Ben", active: false, avatarUrl: null, twoDice: true, connected: true, isSimulated: false },
      { userId: ANNA, name: "Anna", active: true, avatarUrl: null, twoDice: false, connected: true, isSimulated: false },
    ]);
  });

  it("while the dice tumble, every panel keeps the view from before the roll", () => {
    // Ben is up; then a state brings his six: a place, Anna's turn, a history line. Then `rolled`.
    const before = makeView({ game: running({ activeUserId: BEN, history: [ev("game_started", { order: [ANNA, BEN] })] }) });
    const six = ev("rolled", { userId: BEN, dice: [6] }, BEN);
    const after = makeView({ game: running({ turnOrder: [ANNA], activeUserId: ANNA, giftOrder: [BEN], lastRoll: { userId: BEN, dice: [6] }, history: [...before.game.history, six] }) });
    let roll = rollStep(initialRoll, { type: "state", view: before, first: true });
    roll = rollStep(roll, { type: "state", view: after, first: false });
    expect(displayedView(roll, after)).toBe(before); // waiting for `rolled`
    roll = rollStep(roll, { type: "rolled", dice: [6] });
    const shown = displayedView(roll, after);
    expect(turnText(shown, ANNA)).toBe("Am Zug: Ben");
    expect(giftList(shown)).toEqual([]);
    expect(historyLines(shown, false)).toHaveLength(historyLines(before, false).length);
    roll = rollStep(roll, { type: "settled" });
    expect(displayedView(roll, after)).toBe(after); // landed: the result everywhere
    expect(turnText(displayedView(roll, after), ANNA)).toBe("Du bist dran!");
  });

  it("turn order carries each player's profile picture", () => {
    const withPicture = { ...view, members: view.members.map((m) => (m.userId === BEN ? { ...m, avatarUrl: "/avatars/ben/abc" } : m)) };
    expect(turnList(withPicture).map((t) => t.avatarUrl)).toEqual(["/avatars/ben/abc", null]);
  });

  it("latecomers are everyone not rolling and without a place", () => {
    expect(latecomers(view).map((m) => m.displayName)).toEqual(["Hanna", "Carl"]);
  });

  it("gift order, the result text and the six banner", () => {
    const done = makeView({ room: { name: "Feier" }, game: { status: "finished", giftOrder: [BEN, ANNA, id(99)], lastRoll: { userId: ANNA, dice: [6] } } });
    expect(giftList(done).map((g) => `${g.place} ${g.name}`)).toEqual(["1 Ben", "2 Anna", "3 Unbekannt"]);
    expect(resultText(done)).toBe("Geschenk-Reihenfolge: Feier\n1. Ben\n2. Anna\n3. Unbekannt");
    expect(sixBannerValues(done)).toEqual({ name: "Anna", platz: 2 });
    expect(sixBannerValues(makeView())).toBeNull();
  });
});

describe("history", () => {
  const roll = ev("rolled", { userId: ANNA, dice: [6, 1] }, ANNA);
  const forBen = ev("rolled", { userId: BEN, dice: [4], rolledBy: HOST });
  const undone = ev("undone", { seq: forBen.seq });
  const history = [ev("game_started", { order: [ANNA, BEN] }), roll, forBen, undone, ev("skipped", { userId: BEN }), ev("cohost_changed", { userId: CARL, isCohost: true }), ev("participation_changed", { userId: ANNA, participation: "spectator" }, ANNA), ev("simulated_players_changed", { added: [SIM, id(6)], removed: [] }), ev("last_place_taken", { userId: BEN }, BEN), ev("public_changed", { isPublic: false })];
  const view = makeView({ viewer: asHost, game: running({ history, undoneSeqs: [forBen.seq] }) });

  it("shows rolls, 'würfelt für' and taken-back rolls, newest first", () => {
    const lines = historyLines(view, false, "UTC");
    expect(lines.map((l) => [l.time, l.text, l.undone])).toEqual([
      ["18:05", "Hanna würfelt für Ben: 4", true],
      ["18:05", "Anna würfelt: 6 und 1", false],
    ]);
  });

  it("adds the moderation entries when the host switches them on", () => {
    const lines = historyLines(view, true, "UTC").map((l) => l.text);
    expect(lines).toEqual([
      "Hanna macht den Raum nicht öffentlich",
      "Ben nimmt den letzten Platz",
      "Hanna fügt 2 Testspieler hinzu",
      "Anna ist jetzt Zuschauer",
      "Hanna macht Carl zum Co-Host",
      "Hanna überspringt Ben",
      "Hanna nimmt den Wurf von Ben zurück",
      "Hanna würfelt für Ben: 4",
      "Anna würfelt: 6 und 1",
      "Hanna startet das Spiel",
    ]);
  });
});

describe("form checks mirror the server", () => {
  it("nicknames: 1 to 32 visible characters after trimming", () => {
    expect(nicknameError("  Elfe ")).toBeNull();
    expect(nicknameError("   ")).toMatch(/Spitznamen/);
    expect(nicknameError("x".repeat(33))).toBe("Höchstens 32 Zeichen.");
    expect(nicknameError("x".repeat(32))).toBeNull();
    for (const bad of ["a\u200Bb", "a\u202Eb", "\u3164", "a\u00A0b", "x\u0301\u0302\u0303"]) expect(nicknameError(bad), JSON.stringify(bad)).toMatch(/sichtbare/);
    expect(cleanText(" e\u0301 ")).toBe("\u00E9");
  });

  it("room names and the six text", () => {
    expect(roomNameError("Weihnachten 2026")).toBeNull();
    expect(roomNameError("x".repeat(61))).toBe("Höchstens 60 Zeichen.");
    expect(sixMessageError("{name} hat eine 6!")).toBeNull();
    expect(sixMessageError("")).toMatch(/leer/);
  });

  it("explains the HTTP answers", () => {
    expect(nicknameResponseMessage(204)).toBeNull();
    expect(nicknameResponseMessage(429)).toMatch(/warte/);
    expect(createRoomResponseMessage(201)).toBeNull();
    expect(createRoomResponseMessage(403)).toMatch(/Hosts/);
  });
});

describe("roll animation timing", () => {
  const withRoll = (dice: number[], userId = ANNA) => {
    const e = ev("rolled", { userId, dice }, userId);
    return makeView({ game: running({ history: [e], lastRoll: { userId, dice } }) });
  };

  it("the first state of a connection is the baseline: no tumble for missed rolls", () => {
    const s = rollStep(initialRoll, { type: "state", view: withRoll([4]), first: true });
    expect(rollBusy(s)).toBe(false);
    expect(shownDice(s, withRoll([4]))).toEqual([4]);
  });

  it("a new roll in a state holds the result back until the dice have landed", () => {
    let s = rollStep(initialRoll, { type: "state", view: makeView({ game: running() }), first: true });
    const view = withRoll([6]);
    s = rollStep(s, { type: "state", view, first: false });
    expect(s.waiting).toBe(true); // the six banner waits
    s = rollStep(s, { type: "rolled", dice: [6] });
    expect(s).toMatchObject({ waiting: false, tumbling: true, rollKey: 1 });
    expect(shownDice(s, view)).toEqual([6]);
    expect(rollStep(s, { type: "state", view, first: false })).toBe(s); // a later state with the same roll
    s = rollStep(s, { type: "settled" });
    expect(rollBusy(s)).toBe(false);
  });

  it("does not wait forever for a lost `rolled`", () => {
    let s = rollStep(initialRoll, { type: "state", view: withRoll([2]), first: false });
    expect(rollBusy(s)).toBe(true);
    s = rollStep(s, { type: "timeout" });
    expect(rollBusy(s)).toBe(false);
  });
});

describe("review fixes", () => {
  const rolledView = (status: "lobby" | "running") => {
    const e = ev("rolled", { userId: ANNA, dice: [3] }, ANNA);
    return makeView({ game: status === "lobby" ? { status } : running({ history: [e], lastRoll: { userId: ANNA, dice: [3] } }) });
  };

  it("a reset during the tumble does not leave the dice busy for good", () => {
    let s = rollStep(initialRoll, { type: "state", view: makeView({ game: running() }), first: true });
    s = rollStep(s, { type: "state", view: rolledView("running"), first: false });
    s = rollStep(s, { type: "rolled", dice: [3] });
    expect(rollBusy(s)).toBe(true);
    s = rollStep(s, { type: "state", view: rolledView("lobby"), first: false }); // the Dice unmount, onSettled never comes
    expect(rollLocked(s)).toBe(false);
  });

  it("a reconnect during the tumble does not leave the dice busy", () => {
    let s = rollStep(initialRoll, { type: "rolled", dice: [3] });
    s = rollStep(s, { type: "state", view: rolledView("running"), first: true });
    expect(rollLocked(s)).toBe(false);
  });

  it("the roll buttons stay locked for the server's cooldown, not only the animation", () => {
    let s = rollStep(initialRoll, { type: "rolled", dice: [3] });
    s = rollStep(s, { type: "settled" });
    expect(rollBusy(s)).toBe(false);
    expect(rollLocked(s)).toBe(true);
    s = rollStep(s, { type: "cooled" });
    expect(rollLocked(s)).toBe(false);
  });

  it("a chosen person never silently becomes someone else", () => {
    const options = [{ userId: ANNA, name: "Anna" }, { userId: BEN, name: "Ben" }];
    expect(pickOption(options, "")).toBeNull();
    expect(pickOption(options, BEN)).toEqual({ userId: BEN, name: "Ben" });
    expect(pickOption(options.slice(0, 1), BEN)).toBeNull(); // Ben left the list: the choice is cleared
  });

  it("names whose dice lie on the table, also while they tumble", () => {
    expect(rollCaption(makeView({ game: running() }), ANNA, false)).toBe("Noch hat niemand gewürfelt.");
    const rolled = makeView({ game: running({ lastRoll: { userId: BEN, dice: [3, 1] }, activeUserId: ANNA }) });
    expect(rollCaption(rolled, ANNA, true)).toBe("Ben würfelt …");
    expect(rollCaption(rolled, ANNA, false)).toBe("Ben hat 3 und 1 gewürfelt.");
    expect(rollCaption(rolled, BEN, false)).toBe("Du hast 3 und 1 gewürfelt.");
  });

  it("names the newest gift in one line", () => {
    expect(lastGiftText(makeView({ game: running() }))).toBeNull();
    expect(lastGiftText(makeView({ game: running({ giftOrder: [BEN, ANNA] }) }))).toBe("Zuletzt: Anna → Geschenk Nr. 2");
  });

  it("guests read 'Ein Host würfelt für' when they do not know the host", () => {
    const forBen = ev("rolled", { userId: BEN, dice: [4], rolledBy: HOST });
    const view = makeView({ viewer: { kind: "guest" }, members: [member(BEN, "Ben")], game: running({ history: [forBen] }) });
    expect(historyLines(view, false, "UTC").map((l) => l.text)).toEqual(["Ein Host würfelt für Ben: 4"]);
  });

  it("the result offers undo while the last six is not ended by a host", () => {
    const six = ev("rolled", { userId: ANNA, dice: [6] }, ANNA);
    const done = makeView({ viewer: asHost, game: { status: "finished", history: [six], giftOrder: [BEN, ANNA] } });
    expect(deriveRoom(done, true).can.undo).toBe(true);
  });
});

describe("server errors", () => {
  it("say what to do after a stale host click", () => {
    expect(errorText({ type: "error", code: "turn_changed", message: "Inzwischen ist jemand anderes dran." })).toBe(
      "Inzwischen ist jemand anderes dran. Nichts ist passiert: schau, wer jetzt am Zug ist, und entscheide neu.",
    );
    expect(errorText({ type: "error", code: "paused", message: "Das Spiel ist pausiert." })).toBe("Das Spiel ist pausiert.");
  });
});
