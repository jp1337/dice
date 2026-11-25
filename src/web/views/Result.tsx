// The end (spec 10): the numbered gift order, copyable as text. Hosts can take back the last roll (a game
// ended by its last six, not by "Spiel beenden") or take the room back to the lobby.
import type { ClientMessage, RoomView } from "../../shared/contracts.js";
import { Confetti } from "../components/Confetti.js";
import { type Derived, resultText } from "../lib/room.js";
import { ConfirmButton, CopyButton } from "./Controls.js";
import { GiftOrder, History, RESET_QUESTION } from "./Game.js";

export function Result({ view, d, send }: { view: RoomView; d: Derived; send: (message: ClientMessage) => void }) {
  const seq = d.newestRollSeq;
  // "Spiel beenden" before anyone rolled a six: nothing to celebrate, nothing to distribute.
  const none = view.game.giftOrder.length === 0;
  return (
    <div className="result stack">
      {!none && <Confetti />}
      <div className="ribbon-wrap">
        <p className="ribbon" aria-live="polite">
          {none ? "Spiel beendet. Niemand hat eine 6 gewürfelt." : "Fertig! So werden die Geschenke verteilt:"}
        </p>
      </div>
      {!none && <GiftOrder view={view} />}
      <span className="row">
        {!none && <CopyButton text={resultText(view)} label="Als Text kopieren" multiline />}
        {d.can.undo && seq !== null && (
          <ConfirmButton key={seq} label={`Wurf von ${d.newestRollName} zurücknehmen`} question={`Wurf von ${d.newestRollName} zurücknehmen? Das Spiel geht dann weiter.`} onConfirm={() => send({ type: "undo", seq })} />
        )}
        {d.showModeration && <ConfirmButton label="Zurück in die Lobby" question={RESET_QUESTION} disabled={!d.can.reset} onConfirm={() => send({ type: "reset" })} />}
      </span>
      <History view={view} d={d} />
    </div>
  );
}
