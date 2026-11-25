// Everything the room views compute from a RoomView: names, permissions for each button, turn order, gift
// order, the history in words, the result as text. Pure, tested in test/room-view.test.ts. The server
// decides every action again (spec 7); these only keep buttons from offering what it would refuse.
import { NICKNAME_MAX, ROOM_NAME_MAX, SIX_MESSAGE_MAX, isVisibleText } from "../../shared/constants.js";
import type { GameEvent, MemberView, RoomView, ServerMessage, UserId } from "../../shared/contracts.js";
import { undoReopens } from "../../shared/game/decide.js";

const UNKNOWN = "Unbekannt";

export function namesOf(view: RoomView) {
  const byId = new Map(view.members.map((m) => [m.userId, m]));
  return { byId, name: (id: UserId | null | undefined) => (id && byId.get(id)?.displayName) || UNKNOWN };
}

export const diceText = (dice: readonly number[]) => dice.join(" und ");

// online: the socket is open. Without it every button that sends is off.
export function deriveRoom(view: RoomView, online: boolean) {
  const { byId, name } = namesOf(view);
  const { game, room, viewer } = view;
  const member = viewer.kind === "member";
  const me = member ? (byId.get(viewer.userId) ?? null) : null;
  const myId = member ? viewer.userId : null;
  const canModerate = member && viewer.canModerate && online;
  const isHost = member && viewer.isHost;
  const running = game.status === "running";
  const lobby = game.status === "lobby";
  const isActive = myId !== null && game.activeUserId === myId;
  const lastPlayer = running && game.turnOrder.length === 1 ? (game.turnOrder[0] ?? null) : null;
  const ended = game.history.some((e) => e.type === "game_ended");
  const players = view.members.filter((m) => m.participation === "player");
  const newestRoll = game.history.findLast((e) => e.type === "rolled" && !game.undoneSeqs.includes(e.seq)) ?? null;

  return {
    me,
    myId,
    name,
    byId,
    isGuest: !member,
    isHost,
    // Shown to everyone with a room view, including the moderation tools' visibility.
    showModeration: member && viewer.canModerate,
    isActive,
    lastPlayer,
    players,
    activeName: name(game.activeUserId),
    activeConnected: game.activeUserId ? (byId.get(game.activeUserId)?.connected ?? false) : false,
    newestRollSeq: newestRoll?.seq ?? null,
    newestRollName: newestRoll?.type === "rolled" ? name(newestRoll.payload.userId) : null,
    can: {
      roll: online && running && isActive && !game.pause,
      claimLastPlace: online && running && !game.pause && room.settings.lastPlayer === "choice" && lastPlayer !== null && lastPlayer === myId,
      // Spec 4.11: every logged-in member except the active player, while the room allows it.
      react: online && member && room.settings.reactions,
      setOwnParticipation: online && member && lobby,
      editNickname: online && member,
      // Host tools (spec 4.6)
      start: canModerate && lobby && players.length > 0,
      settings: canModerate && lobby,
      toggleReactions: canModerate,
      setParticipation: canModerate && lobby,
      setCohost: online && isHost,
      resetNickname: canModerate,
      simulatedPlayers: canModerate && lobby && room.isTest,
      setPublic: canModerate,
      pause: canModerate && running && !game.pause,
      continue: canModerate && running && game.pause !== null,
      skip: canModerate && running,
      rollFor: canModerate && running && !game.pause && game.activeUserId !== null && !isActive, // own turn: the big button
      removePlayer: canModerate && running,
      addPlayer: canModerate && running,
      assignLastPlace: canModerate && lastPlayer !== null,
      undo: canModerate && !lobby && !ended && newestRoll !== null && undoReopens(game, room.settings, newestRoll.seq),
      end: canModerate && running,
      reset: canModerate && !lobby,
    },
  };
}
export type Derived = ReturnType<typeof deriveRoom>;

// The banner of the six that ended the game stays until its viewer closes it, but only for that roll. It was
// a flag of its own: left open over a reset, it made the next game's end show the old banner, or (ended
// without a roll) keep the game screen with no way to the result.
export function finalSixOpen(view: RoomView, sixSeq: number | null) {
  const { game } = view;
  return sixSeq !== null && game.status === "finished" && game.history.findLast((e) => e.type === "rolled" && !game.undoneSeqs.includes(e.seq))?.seq === sixSeq;
}

// Co-host switch: never for hosts (always host) or simulated players (spec 4.2).
export const canBeCohost = (m: MemberView) => !m.isHost && !m.isSimulated;

// Spectators and removed players can join a running game at the end of the order (spec 4.5).
export function latecomers(view: RoomView) {
  const inGame = new Set([...view.game.turnOrder, ...view.game.giftOrder]);
  return view.members.filter((m) => !inGame.has(m.userId));
}

// Whose turn to show. The server moves the turn on as it rolls; while the dice still tumble (busy),
// the next name would make the result look like theirs, so the turn stays with whoever rolled.
export function shownTurn(view: RoomView, busy: boolean) {
  return (busy && view.game.lastRoll?.userId) || view.game.activeUserId;
}

// The live region of the game view (spec 4.3): read out on every change of turn.
export function turnText(view: RoomView, myId: UserId | null, busy: boolean) {
  if (view.game.status !== "running") return "";
  const who = shownTurn(view, busy);
  return who !== null && who === myId ? "Du bist dran!" : `Am Zug: ${namesOf(view).name(who)}`;
}

export function turnList(view: RoomView, busy = false) {
  const { byId, name } = namesOf(view);
  const active = shownTurn(view, busy);
  return view.game.turnOrder.map((userId) => ({
    userId,
    name: name(userId),
    active: userId === active,
    twoDice: view.game.bonusPending.includes(userId),
    connected: byId.get(userId)?.connected ?? false,
    isSimulated: byId.get(userId)?.isSimulated ?? false,
  }));
}

export function giftList(view: RoomView) {
  const { name } = namesOf(view);
  return view.game.giftOrder.map((userId, i) => ({ userId, place: i + 1, name: name(userId) }));
}

// The banner on a six (R6): the newest effective roll's player and the place it gave.
export function sixBannerValues(view: RoomView) {
  const roll = view.game.lastRoll;
  if (!roll) return null;
  const place = view.game.giftOrder.indexOf(roll.userId);
  return { name: namesOf(view).name(roll.userId), platz: place >= 0 ? place + 1 : view.game.giftOrder.length };
}

// One line under the dice: who got the newest gift.
// Who the dice on the table belong to. The turn line names the next player as soon as the state
// arrives, while the dice still tumble; without this nobody can tell whose result they show.
export function rollCaption(view: RoomView, myId: UserId | null, busy: boolean) {
  const roll = view.game.lastRoll;
  if (!roll) return "Noch hat niemand gewürfelt.";
  const mine = roll.userId === myId;
  const who = mine ? "Du" : namesOf(view).name(roll.userId);
  if (busy) return `${who} ${mine ? "würfelst" : "würfelt"} …`;
  return `${who} ${mine ? "hast" : "hat"} ${diceText(roll.dice)} gewürfelt.`;
}

export function lastGiftText(view: RoomView) {
  const gifts = view.game.giftOrder;
  const last = gifts.at(-1);
  return last ? `Zuletzt: ${namesOf(view).name(last)} → Geschenk Nr. ${gifts.length}` : null;
}

// A person chosen in a list. A choice that left the list is gone, never replaced by someone else.
export function pickOption<T extends { userId: UserId }>(options: readonly T[], picked: string): T | null {
  return options.find((o) => o.userId === picked) ?? null;
}

export function resultText(view: RoomView) {
  const lines = giftList(view).map((gift) => `${gift.place}. ${gift.name}`);
  return [`Geschenk-Reihenfolge: ${view.room.name}`, ...lines].join("\n");
}

// --------------------------------------------------------------------------------------------------
// History (spec 4.5): rolls for everyone, the rest for hosts and co-hosts only (the server filters).

export type HistoryLine = { seq: number; time: string; text: string; undone: boolean; moderation: boolean };

export function formatTime(iso: string, timeZone?: string) {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", ...(timeZone && { timeZone }) });
}

export function describeEvent(
  event: GameEvent,
  name: (id: UserId | null) => string,
  rollOf: (seq: number) => string,
  known: (id: UserId) => boolean = () => true,
): string {
  const actor = event.actorUserId === null ? "Der Server" : name(event.actorUserId);
  switch (event.type) {
    case "rolled": {
      const { userId, dice, rolledBy } = event.payload;
      // Guests may not know the host (not rolling, no place): still say clearly that someone else rolled.
      const by = rolledBy && (known(rolledBy) ? name(rolledBy) : "Ein Host");
      return by ? `${by} würfelt für ${name(userId)}: ${diceText(dice)}` : `${name(userId)} würfelt: ${diceText(dice)}`;
    }
    case "game_started":
      return `${actor} startet das Spiel`;
    case "continued":
      return `${actor} macht weiter`;
    case "paused":
      return `${actor} pausiert das Spiel`;
    case "skipped":
      return `${actor} überspringt ${name(event.payload.userId)}`;
    case "player_removed":
      return `${actor} entfernt ${name(event.payload.userId)} aus dem Spiel`;
    case "player_added":
      return `${actor} hängt ${name(event.payload.userId)} als Nachzügler an`;
    case "last_place_taken":
      return event.actorUserId === event.payload.userId
        ? `${name(event.payload.userId)} nimmt den letzten Platz`
        : `${actor} vergibt den letzten Platz an ${name(event.payload.userId)}`;
    case "undone":
      return `${actor} nimmt den Wurf von ${rollOf(event.payload.seq)} zurück`;
    case "game_ended":
      return `${actor} beendet das Spiel`;
    case "game_reset":
      return `${actor} setzt den Raum zurück in die Lobby`;
    case "cohost_changed":
      return event.payload.isCohost ? `${actor} macht ${name(event.payload.userId)} zum Co-Host` : `${actor} entfernt ${name(event.payload.userId)} als Co-Host`;
    case "participation_changed": {
      const role = event.payload.participation === "player" ? "Würfler" : "Zuschauer";
      return event.actorUserId === event.payload.userId ? `${actor} ist jetzt ${role}` : `${actor} stellt ${name(event.payload.userId)} auf ${role}`;
    }
    case "nickname_reset":
      return `${actor} setzt den Spitznamen von ${name(event.payload.userId)} zurück`;
    case "public_changed":
      return `${actor} macht den Raum ${event.payload.isPublic ? "öffentlich" : "nicht öffentlich"}`;
    case "simulated_players_changed": {
      const { added, removed } = event.payload;
      const parts = [added.length > 0 && `fügt ${added.length} Testspieler hinzu`, removed.length > 0 && `entfernt ${removed.length} Testspieler`];
      return `${actor} ${parts.filter(Boolean).join(" und ") || "ändert die Testspieler"}`;
    }
  }
}

// Newest first. withModeration: the hosts' switch; off, only the rolls show.
export function historyLines(view: RoomView, withModeration: boolean, timeZone?: string): HistoryLine[] {
  const { name, byId } = namesOf(view);
  const rolls = new Map(view.game.history.flatMap((e) => (e.type === "rolled" ? [[e.seq, name(e.payload.userId)] as const] : [])));
  const rollOf = (seq: number) => rolls.get(seq) ?? UNKNOWN;
  return view.game.history
    .filter((e) => withModeration || e.type === "rolled")
    .map((e) => ({
      seq: e.seq,
      time: formatTime(e.createdAt, timeZone),
      text: describeEvent(e, name, rollOf, (id) => byId.has(id)),
      undone: e.type === "rolled" && view.game.undoneSeqs.includes(e.seq),
      moderation: e.type !== "rolled",
    }))
    .reverse();
}

// --------------------------------------------------------------------------------------------------
// Form checks: the server's visibleText rule (contracts.ts), German messages. The server's answer wins.

function textError(value: string, max: number, empty: string): string | null {
  const text = value.normalize("NFC").trim();
  if (text.length === 0) return empty;
  if (text.length > max) return `Höchstens ${max} Zeichen.`;
  if (!isVisibleText(text)) return "Bitte nur sichtbare Zeichen: keine Steuerzeichen, Sonderleerzeichen oder unsichtbaren Zeichen.";
  return null;
}

export const nicknameError = (value: string) => textError(value, NICKNAME_MAX, "Bitte gib einen Spitznamen ein.");
export const roomNameError = (value: string) => textError(value, ROOM_NAME_MAX, "Bitte gib dem Raum einen Namen.");
export const sixMessageError = (value: string) => textError(value, SIX_MESSAGE_MAX, "Der Text darf nicht leer sein.");
// What the server stores; send this, not the raw input.
export const cleanText = (value: string) => value.normalize("NFC").trim();

// A server error as shown. A stale host click (two hosts, or the turn moved on) changed nothing: say so.
export function errorText(error: Extract<ServerMessage, { type: "error" }>) {
  if (error.code === "turn_changed" || error.code === "undo_stale") return `${error.message} Nichts ist passiert: schau, wer jetzt am Zug ist, und entscheide neu.`;
  return error.message;
}

// PATCH /api/me answers (spec 4.10).
export function nicknameResponseMessage(status: number): string | null {
  if (status === 204) return null;
  if (status === 400) return "Diesen Spitznamen nimmt der Server nicht an.";
  if (status === 401) return "Deine Sitzung ist abgelaufen. Bitte melde dich neu an.";
  if (status === 429) return "Zu viele Änderungen. Bitte warte eine Minute.";
  return "Das hat nicht geklappt. Bitte versuche es noch einmal.";
}

// POST /api/rooms answers.
export function createRoomResponseMessage(status: number): string | null {
  if (status === 201 || status === 200) return null;
  if (status === 400) return "Bitte prüfe den Namen.";
  if (status === 401) return "Deine Sitzung ist abgelaufen. Bitte melde dich neu an.";
  if (status === 403) return "Räume erstellen dürfen nur Hosts.";
  if (status === 429) return "Zu viele neue Räume. Bitte warte eine Minute.";
  return "Das hat nicht geklappt. Bitte versuche es noch einmal.";
}
