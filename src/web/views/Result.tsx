// The end (spec 10): the numbered gift order, copyable as text; hosts can take the room back to the lobby.
import type { ClientMessage, RoomView } from "../../shared/contracts.js";
import { type Derived, resultText } from "../lib/room.js";
import { ConfirmButton, CopyButton } from "./Controls.js";
import { GiftOrder, History } from "./Game.js";

export function Result({ view, d, send }: { view: RoomView; d: Derived; send: (message: ClientMessage) => void }) {
  return (
    <div className="result stack">
      <p className="turn" aria-live="polite">
        Fertig! So werden die Geschenke verteilt:
      </p>
      <GiftOrder view={view} />
      <span className="row">
        <CopyButton text={resultText(view)} label="Als Text kopieren" multiline />
        {d.showModeration && (
          <ConfirmButton label="Zurück in die Lobby" question="Raum zurück in die Lobby setzen?" disabled={!d.can.reset} onConfirm={() => send({ type: "reset" })} />
        )}
      </span>
      <History view={view} d={d} />
    </div>
  );
}
