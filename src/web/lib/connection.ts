// One WebSocket per tab with automatic reconnect (spec 8.1): growing delay with jitter, capped; right away
// after a server-side reload (1012, 1013); a stop with a German message on a terminal close. Every new
// connection gets a fresh `state` from the server, so nothing is replayed. Free of React and the DOM: the
// socket factory is injected, the tests drive it with fakes.
import type { ClientMessage, ServerMessage } from "../../shared/contracts.js";

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;
// Failed attempts in a row without any state before the page shows the error instead of "verbinde …".
export const ERROR_PAGE_AFTER = 3;

// attempt counts failures since the last state (1 = first retry). Equal jitter: between half and all
// of the exponential ceiling, so a server restart does not get every client back in the same millisecond.
export function backoffDelay(attempt: number, random: () => number = Math.random) {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

export type CloseAction = "reconnect-now" | "reconnect" | "login" | "stop";

// The server's codes (rooms.ts): 1008 too many tabs or messages, 4004 room gone, 4001 session ended,
// 1011 join failed, 1012/1013 the room reloads (back within a second, jittered). 1006 is a lost network or a refused upgrade.
export function classifyClose(code: number): CloseAction {
  if (code === 1012 || code === 1013) return "reconnect-now";
  if (code === 4001) return "login";
  if (code === 1008 || (code >= 4000 && code <= 4999)) return "stop";
  return "reconnect";
}

const DEFAULT_MESSAGES: Record<number, string> = {
  1008: "Der Server hat die Verbindung beendet.",
  4001: "Deine Sitzung ist abgelaufen. Bitte melde dich neu an.",
  4004: "Diesen Raum gibt es nicht mehr.",
};

// The server sends a German reason with every close it makes on purpose; it wins over the default.
export function closeMessage(code: number, reason: string) {
  return reason.trim() || DEFAULT_MESSAGES[code] || "Die Verbindung wurde beendet.";
}

export type Status =
  | { kind: "connecting"; attempt: number } // attempt 0: the first connection of this page
  | { kind: "open" }
  | { kind: "retrying"; attempt: number; delayMs: number }
  | { kind: "login"; message: string } // terminal: the session is gone
  | { kind: "stopped"; message: string }; // terminal

export type StatusLabel = "verbunden" | "verbinde …" | "verbinde neu …" | "getrennt";
export function statusLabel(status: Status, hasState: boolean): StatusLabel {
  if (status.kind === "open") return "verbunden";
  if (status.kind === "login" || status.kind === "stopped") return "getrennt";
  return hasState || status.kind === "retrying" || status.attempt > 0 ? "verbinde neu …" : "verbinde …";
}

// No state yet and the connection keeps failing: an error page, not an empty one (spec 8.1). It stays
// while the next attempt connects, so it does not flicker away every few seconds.
export function showErrorPage(status: Status, hasState: boolean) {
  if (status.kind === "login" || status.kind === "stopped") return true;
  return !hasState && status.kind !== "open" && status.attempt >= ERROR_PAGE_AFTER;
}

const SERVER_TYPES = new Set(["state", "rolled", "reactions", "error"]);
// The server is trusted for the shape; this only drops what is not one of its messages.
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const message = JSON.parse(data) as { type?: unknown };
    return message && typeof message === "object" && SERVER_TYPES.has(message.type as string) ? (message as ServerMessage) : null;
  } catch {
    return null;
  }
}

// What a refused upgrade (401, 404 answered before the WebSocket opens) is, asked over HTTP: the
// browser hides the status code of a failed upgrade and reports 1006 like any network loss.
export type ProbeResult = "ok" | "login" | "gone";

export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

type Options = {
  url: string;
  makeSocket: (url: string) => SocketLike;
  onStatus: (status: Status) => void;
  onMessage: (message: ServerMessage) => void;
  probe?: () => Promise<ProbeResult>;
  goneMessage?: string;
  random?: () => number;
};

const OPEN = 1;

export function createConnection({ url, makeSocket, onStatus, onMessage, probe, goneMessage, random = Math.random }: Options) {
  let socket: SocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;
  let probing = false; // retryNow must not start a second socket while the probe decides

  const finish = (status: Extract<Status, { kind: "login" | "stopped" }>) => {
    stopped = true;
    clearTimeout(timer);
    onStatus(status);
  };

  const connect = () => {
    timer = undefined;
    onStatus({ kind: "connecting", attempt });
    const current = makeSocket(url);
    socket = current;
    let opened = false;
    current.onopen = () => {
      opened = true;
      onStatus({ kind: "open" });
    };
    current.onmessage = (event) => {
      const message = parseServerMessage(event.data);
      if (!message) return;
      // Only a state proves the connection works: a socket that opens and is closed at once (join
      // failed) keeps growing the delay instead of reconnecting in a tight loop.
      if (message.type === "state") attempt = 0;
      onMessage(message);
    };
    current.onclose = (event) => {
      if (socket !== current || stopped) return;
      socket = null;
      void closed(event.code, event.reason, opened);
    };
  };

  const closed = async (code: number, reason: string, opened: boolean) => {
    const action = classifyClose(code);
    if (action === "login") return finish({ kind: "login", message: closeMessage(code, reason) });
    if (action === "stop") return finish({ kind: "stopped", message: closeMessage(code, reason) });
    if (!opened && probe) {
      probing = true;
      const result = await probe().catch((): ProbeResult => "ok"); // offline: keep trying
      probing = false;
      if (stopped) return;
      if (result === "login") return finish({ kind: "login", message: "Bitte melde dich an, um mitzumachen." });
      if (result === "gone") return finish({ kind: "stopped", message: goneMessage ?? "Diesen Raum gibt es nicht." });
    }
    attempt++;
    // After a reload every client comes back within a second, spread out instead of all at once.
    const delayMs = action === "reconnect-now" && attempt === 1 ? Math.round(random() * 1000) : backoffDelay(attempt, random);
    onStatus({ kind: "retrying", attempt, delayMs });
    timer = setTimeout(connect, delayMs);
  };

  return {
    start: connect,
    stop() {
      stopped = true;
      clearTimeout(timer);
      const current = socket;
      socket = null;
      current?.close(1000);
    },
    // The error page's button, the tab becoming visible, the network coming back: try now instead of
    // waiting for the timer.
    retryNow() {
      if (stopped || socket || probing) return;
      clearTimeout(timer);
      connect();
    },
    // Not queued: a click while offline must not fire minutes later.
    send(message: ClientMessage): boolean {
      if (socket?.readyState !== OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
  };
}
export type Connection = ReturnType<typeof createConnection>;
