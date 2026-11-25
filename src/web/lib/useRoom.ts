// React glue for one room connection: the latest RoomView, the connection status, the roll animation
// state, floating reactions and the server's error messages. The logic lives in connection.ts and roll.ts.
import { useCallback, useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { ROLL_COOLDOWN_MS } from "../../shared/constants.js";
import type { ClientMessage, RoomView } from "../../shared/contracts.js";
import { useFloatingReactions } from "../components/Reactions.js";
import { type Connection, type ProbeResult, type Status, createConnection } from "./connection.js";
import { useSound } from "./hooks.js";
import { errorText } from "./room.js";
import { ROLLED_WAIT_MS, initialRoll, rollStep } from "./roll.js";

export type Notice = { id: number; text: string };

export function useRoom(url: string, probe?: () => Promise<ProbeResult>, goneMessage?: string) {
  const [status, setStatus] = useState<Status>({ kind: "connecting", attempt: 0 });
  const [view, setView] = useState<RoomView | null>(null);
  const [roll, dispatchRoll] = useReducer(rollStep, initialRoll);
  const [notice, setNotice] = useState<Notice | null>(null);
  const floating = useFloatingReactions();
  const { play } = useSound();
  const connection = useRef<Connection | null>(null);
  const firstState = useRef(true);
  const playRoll = useEffectEvent(() => play("roll"));

  const say = useCallback((text: string) => setNotice({ id: Date.now(), text }), []);

  useEffect(() => {
    const conn = createConnection({
      url,
      probe,
      goneMessage,
      makeSocket: (target) => new WebSocket(target),
      onStatus: (next) => {
        if (next.kind !== "open") firstState.current = true;
        setStatus(next);
      },
      onMessage: (message) => {
        switch (message.type) {
          case "state":
            dispatchRoll({ type: "state", view: message.state, first: firstState.current });
            firstState.current = false;
            setView(message.state);
            break;
          case "rolled":
            dispatchRoll({ type: "rolled", dice: message.dice, at: Date.now() });
            playRoll();
            break;
          case "reactions":
            floating.add(message.emojis);
            break;
          case "error":
            say(errorText(message));
            break;
        }
      },
    });
    connection.current = conn;
    conn.start();
    return () => conn.stop();
    // probe and goneMessage belong to the url; a new url is a new room.
  }, [url]);

  // A state with a new roll whose `rolled` never arrives must not hold the view back for good.
  useEffect(() => {
    if (!roll.waiting) return;
    const timer = setTimeout(() => dispatchRoll({ type: "timeout" }), ROLLED_WAIT_MS);
    return () => clearTimeout(timer);
  }, [roll.waiting, roll.seenSeq]);

  // The server refuses the next roll for ROLL_COOLDOWN_MS after one; the buttons wait as long.
  useEffect(() => {
    if (!roll.cooling) return;
    const timer = setTimeout(() => dispatchRoll({ type: "cooled" }), ROLL_COOLDOWN_MS);
    return () => clearTimeout(timer);
  }, [roll.cooling, roll.rollKey]);

  // Phones freeze background tabs and drop sockets: back in front, or back online, try at once.
  useEffect(() => {
    const retry = () => document.visibilityState === "visible" && connection.current?.retryNow();
    document.addEventListener("visibilitychange", retry);
    window.addEventListener("online", retry);
    return () => {
      document.removeEventListener("visibilitychange", retry);
      window.removeEventListener("online", retry);
    };
  }, []);

  // Server errors fade after a while; the next one replaces them.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const send = useCallback(
    (message: ClientMessage) => {
      if (!connection.current?.send(message)) say("Keine Verbindung zum Server. Bitte warte, bis sie wieder steht.");
    },
    [say],
  );
  const settled = useCallback(() => dispatchRoll({ type: "settled" }), []);
  const retryNow = useCallback(() => connection.current?.retryNow(), []);

  return { status, view, roll, settled, notice, say, send, retryNow, floating: floating.items, play };
}
