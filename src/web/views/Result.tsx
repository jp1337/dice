// The end (spec 10): the numbered gift order, copyable as text. Hosts can take back the last roll (a game
// ended by its last six, not by "Spiel beenden") or take the room back to the lobby.
import type { ClientMessage, RoomView } from "../../shared/contracts.js";
import { type Derived, resultText } from "../lib/room.js";
import { ConfirmButton, CopyButton } from "./Controls.js";
import { GiftOrder, History, RESET_QUESTION } from "./Game.js";

export function Result({ view, d, send }: { view: RoomView; d: Derived; send: (message: ClientMessage) => void }) {
  const seq = d.newestRollSeq;
  return (
    <div className="result stack">
      <p className="turn" aria-live="polite">
        Fertig! So werden die Geschenke verteilt:
      </p>
      <GiftOrder view={view} />
      <span className="row">
        <CopyButton text={resultText(view)} label="Als Text kopieren" multiline />
        {d.can.undo && seq !== null && (
          <ConfirmButton key={seq} label={`Wurf von ${d.newestRollName} zurücknehmen`} question={`Wurf von ${d.newestRollName} zurücknehmen? Das Spiel geht dann weiter.`} onConfirm={() => send({ type: "undo", seq })} />
        )}
        {d.showModeration && <ConfirmButton label="Zurück in die Lobby" question={RESET_QUESTION} disabled={!d.can.reset} onConfirm={() => send({ type: "reset" })} />}
      </span>
      <History view={view} d={d} />
    </div>
  );
}
