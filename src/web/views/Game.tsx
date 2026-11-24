// The running game (spec 10): dice in the middle, whose turn, order, gifts so far, history, reactions,
// and the host bar with every tool of spec 4.6. Guests see the same without anything that sends.
import { useId, useState } from "react";
import type { RoomView } from "../../shared/contracts.js";
import { Dice } from "../components/Dice.js";
import { FloatingReactions, ReactionBar } from "../components/Reactions.js";
import { ReactionsToggle, Switch } from "../components/Toggles.js";
import { useFlag } from "../lib/hooks.js";
import { HIDE_REACTIONS_KEY } from "../lib/prefs.js";
import { type Derived, giftList, historyLines, latecomers, turnList } from "../lib/room.js";
import { rollBusy, shownDice } from "../lib/roll.js";
import type { useRoom } from "../lib/useRoom.js";
import { ConfirmButton } from "./Controls.js";
import { GuestLink } from "./Lobby.js";
import { Participants } from "./Participants.js";

type Room = ReturnType<typeof useRoom>;
type Props = { view: RoomView; d: Derived; room: Room };

function PickAndAct({ label, options, action, confirm }: { label: string; options: { userId: string; name: string }[]; action: (userId: string) => void; confirm?: (name: string) => string }) {
  const [picked, setPicked] = useState("");
  const id = useId();
  const choice = options.find((o) => o.userId === picked) ?? options[0];
  if (!choice) return null;
  return (
    <span className="row">
      <label htmlFor={id} className="sr-only">
        {label}: Person
      </label>
      <select id={id} value={choice.userId} onChange={(event) => setPicked(event.target.value)}>
        {options.map((o) => (
          <option key={o.userId} value={o.userId}>
            {o.name}
          </option>
        ))}
      </select>
      {confirm ? (
        <ConfirmButton label={label} question={confirm(choice.name)} onConfirm={() => action(choice.userId)} />
      ) : (
        <button type="button" onClick={() => action(choice.userId)}>
          {label}
        </button>
      )}
    </span>
  );
}

function HostBar({ view, d, room }: Props) {
  const { can } = d;
  const send = room.send;
  const turn = turnList(view);
  const late = latecomers(view).map((m) => ({ userId: m.userId, name: m.displayName }));
  return (
    <section className="card stack host-bar" aria-labelledby="host-bar">
      <h2 id="host-bar">Host-Werkzeuge</h2>
      <span className="row">
        {view.game.pause ? (
          <button type="button" className="primary" disabled={!can.continue} onClick={() => send({ type: "continue" })}>
            Weiter
          </button>
        ) : (
          <button type="button" disabled={!can.pause} onClick={() => send({ type: "pause" })}>
            Pause
          </button>
        )}
        <button type="button" disabled={!can.skip} onClick={() => send({ type: "skip" })}>
          {d.activeName} überspringen
        </button>
        <button type="button" disabled={!can.rollFor} onClick={() => send({ type: "roll_for" })}>
          Für {d.activeName} würfeln
        </button>
      </span>
      <span className="row">
        {can.undo && d.newestRollSeq !== null && (
          <ConfirmButton
            label={`Letzten Wurf zurücknehmen (${d.newestRollName})`}
            question={`Wurf von ${d.newestRollName} zurücknehmen?`}
            onConfirm={() => send({ type: "undo", seq: d.newestRollSeq! })}
          />
        )}
        {can.assignLastPlace && (
          <ConfirmButton label="Letzten Platz vergeben" question={`Letzten Platz an ${d.name(d.lastPlayer)} vergeben?`} onConfirm={() => send({ type: "assign_last_place" })} />
        )}
      </span>
      {can.removePlayer && turn.length > 0 && (
        <PickAndAct label="Aus dem Spiel entfernen" options={turn} confirm={(name) => `${name} wirklich entfernen? Er oder sie bekommt keinen Platz.`} action={(userId) => send({ type: "remove_player", userId })} />
      )}
      {can.addPlayer && late.length > 0 && <PickAndAct label="Als Nachzügler anhängen" options={late} action={(userId) => send({ type: "add_player", userId })} />}
      <Switch on={view.room.settings.reactions} onChange={(on) => can.toggleReactions && send({ type: "update_settings", settings: { reactions: on } })} label="Reaktionen im Raum erlaubt" />
      <GuestLink view={view} d={d} send={send} />
      <span className="row">
        <ConfirmButton label="Spiel beenden" question="Spiel wirklich beenden?" disabled={!can.end} className="danger" onConfirm={() => send({ type: "end" })} />
        <ConfirmButton label="Zurück in die Lobby" question="Raum wirklich zurück in die Lobby setzen? Der Spielstand geht verloren." disabled={!can.reset} className="danger" onConfirm={() => send({ type: "reset" })} />
      </span>
    </section>
  );
}

export function History({ view, d }: { view: RoomView; d: Derived }) {
  const [moderation, setModeration] = useState(false);
  const lines = historyLines(view, d.showModeration && moderation);
  return (
    <section className="stack" aria-labelledby="history">
      <h2 id="history">Verlauf</h2>
      {d.showModeration && <Switch on={moderation} onChange={setModeration} label="Moderationsverlauf zeigen" />}
      {lines.length === 0 ? (
        <p className="hint">Noch nichts passiert.</p>
      ) : (
        <ul className="history">
          {lines.map((line) => (
            <li key={line.seq} className={`${line.undone ? "is-undone" : ""} ${line.moderation ? "is-moderation" : ""}`}>
              <time>{line.time}</time> {line.undone ? <s>{line.text}</s> : line.text}
              {line.undone && <span className="badge">zurückgenommen</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function GiftOrder({ view }: { view: RoomView }) {
  const gifts = giftList(view);
  return (
    <section className="stack" aria-labelledby="gifts">
      <h2 id="gifts">Geschenk-Reihenfolge</h2>
      {gifts.length === 0 ? (
        <p className="hint">Noch hat niemand eine 6.</p>
      ) : (
        <ol className="gifts">
          {gifts.map((g) => (
            <li key={g.userId}>{g.name}</li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function Game({ view, d, room, onSettled }: Props & { onSettled: () => void }) {
  const [hideReactions] = useFlag(HIDE_REACTIONS_KEY);
  const { game } = view;
  const busy = rollBusy(room.roll);
  const turn = turnList(view);
  const inTurn = d.myId !== null && game.turnOrder.includes(d.myId);

  return (
    <div className="game">
      <section className="reaction-stage stage" aria-labelledby="turn">
        <p id="turn" className={`turn ${d.isActive ? "is-me" : ""}`} aria-live="polite">
          {d.turnText}
        </p>
        {game.pause === "host" && <p className="pause">Pausiert. Ein Host macht gleich weiter.</p>}
        {d.showModeration && game.activeUserId && !d.activeConnected && (
          <p className="warning" role="status">
            {d.activeName} ist getrennt. Du kannst überspringen oder für {d.activeName} würfeln.
          </p>
        )}
        <Dice values={shownDice(room.roll, view)} rollKey={room.roll.rollKey} count={game.activeDiceCount} onSettled={onSettled} />
        <FloatingReactions items={room.floating} hidden={hideReactions} />
        {(inTurn || d.can.claimLastPlace) && (
          <p className="actions">
            {inTurn && (
              <button type="button" className="primary big" disabled={!d.can.roll || busy} onClick={() => room.send({ type: "roll" })}>
                {d.isActive && game.activeDiceCount === 2 ? "Mit 2 Würfeln würfeln" : "Würfeln"}
              </button>
            )}
            {d.can.claimLastPlace && (
              <button type="button" disabled={busy} onClick={() => room.send({ type: "claim_last_place" })}>
                Letzten Platz nehmen
              </button>
            )}
          </p>
        )}
      </section>

      {!d.isGuest && (
        <section className="reactions" aria-label="Reaktionen">
          {!d.isActive && view.room.settings.reactions && <ReactionBar disabled={!d.can.react} onReact={(emoji) => room.send({ type: "react", emoji })} />}
          <ReactionsToggle />
        </section>
      )}

      {d.showModeration && <HostBar view={view} d={d} room={room} />}

      <div className="columns">
        <section className="stack" aria-labelledby="order">
          <h2 id="order">Zugreihenfolge (Runde {game.round})</h2>
          <ol className="turns">
            {turn.map((t) => (
              <li key={t.userId} className={t.active ? "is-active" : ""} aria-current={t.active ? "step" : undefined}>
                <span>{t.name}</span>
                {t.twoDice && <span className="badge badge-bonus">2 Würfel</span>}
                {t.isSimulated && <span className="badge badge-test">Testspieler</span>}
                {!d.isGuest && <span className={`badge conn-${t.connected ? "ok" : "lost"}`}>{t.connected ? "verbunden" : "getrennt"}</span>}
              </li>
            ))}
          </ol>
        </section>
        <GiftOrder view={view} />
        <History view={view} d={d} />
      </div>

      {!d.isGuest && (
        <details className="card">
          <summary>Teilnehmer ({view.members.length})</summary>
          <Participants view={view} d={d} send={room.send} />
        </details>
      )}
    </div>
  );
}
