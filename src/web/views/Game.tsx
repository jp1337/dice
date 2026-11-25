// The running game (spec 10). Phone first, in the order a host needs it: whose turn and the dice, the
// four everyday host tools, gifts and turn order, reactions, the rarer host tools folded away, history.
// Guests see the same without anything that sends.
import { useId, useState } from "react";
import type { RoomView } from "../../shared/contracts.js";
import { Dice } from "../components/Dice.js";
import { HowTo } from "../components/HowTo.js";
import { FloatingReactions, ReactionBar } from "../components/Reactions.js";
import { ReactionsToggle, Switch } from "../components/Toggles.js";
import { useFlag } from "../lib/hooks.js";
import { HIDE_REACTIONS_KEY } from "../lib/prefs.js";
import { type Derived, giftList, historyLines, lastGiftText, latecomers, pickOption, rollCaption, shownTurn, turnList, turnText } from "../lib/room.js";
import { rollBusy, rollLocked, shownDice } from "../lib/roll.js";
import type { useRoom } from "../lib/useRoom.js";
import { ConfirmButton } from "./Controls.js";
import { RoomLink } from "./Lobby.js";
import { Participants } from "./Participants.js";

type Room = ReturnType<typeof useRoom>;
type Props = { view: RoomView; d: Derived; room: Room };
type Option = { userId: string; name: string };

export const RESET_QUESTION = "Raum zurück in die Lobby setzen? Die Geschenk-Reihenfolge verschwindet dann für alle.";

// Nothing is preselected, and a person who leaves the list clears the choice (pickOption).
function PickAndAct({ label, options, action, confirm }: { label: string; options: Option[]; action: (userId: string) => void; confirm?: (name: string) => string }) {
  const [picked, setPicked] = useState("");
  const id = useId();
  const choice = pickOption(options, picked);
  if (options.length === 0) return null;
  return (
    <span className="row">
      <label htmlFor={id} className="sr-only">
        {label}: Person
      </label>
      <select id={id} value={choice?.userId ?? ""} onChange={(event) => setPicked(event.target.value)}>
        <option value="">Person wählen …</option>
        {options.map((o) => (
          <option key={o.userId} value={o.userId}>
            {o.name}
          </option>
        ))}
      </select>
      {confirm ? (
        <ConfirmButton key={choice?.userId ?? ""} label={label} question={choice ? confirm(choice.name) : ""} disabled={!choice} onConfirm={() => choice && action(choice.userId)} />
      ) : (
        <button type="button" disabled={!choice} onClick={() => choice && action(choice.userId)}>
          {label}
        </button>
      )}
    </span>
  );
}

// The everyday tools, two by two.
function HostBar({ view, d, room }: Props) {
  const { can } = d;
  const send = room.send;
  const locked = rollLocked(room.roll);
  const busy = rollBusy(room.roll);
  const seq = d.newestRollSeq;
  const active = view.game.activeUserId;
  // Name the player the heading shows: while the dice tumble that is still whoever rolled, so skip and
  // roll-for wait (disabled) until they land instead of already naming the next player.
  const shown = shownTurn(view, busy);
  return (
    <section className="card stack host-bar" aria-label="Host-Werkzeuge">
      <div className="grid2">
        {view.game.pause ? (
          <button type="button" className="primary" disabled={!can.continue} onClick={() => send({ type: "continue" })}>
            Weiter
          </button>
        ) : (
          <button type="button" disabled={!can.pause} onClick={() => send({ type: "pause" })}>
            Pause
          </button>
        )}
        {/* The player named on the button: if the turn moved on meanwhile, the server answers turn_changed.
            No one active (the last six is still on screen): no name to put on them. */}
        {active && (
          <button type="button" disabled={!can.skip || busy} onClick={() => send({ type: "skip", userId: active })}>
            {d.name(shown)} überspringen
          </button>
        )}
        {active && shown !== d.myId && (
          <button type="button" disabled={!can.rollFor || locked} onClick={() => send({ type: "roll_for", userId: active })}>
            Für {d.name(shown)} würfeln
          </button>
        )}
        {/* key: a newer roll closes an open question instead of taking back the wrong one */}
        <ConfirmButton
          key={seq ?? 0}
          label={d.newestRollName ? `Wurf von ${d.newestRollName} zurücknehmen` : "Wurf zurücknehmen"}
          question={`Wurf von ${d.newestRollName} zurücknehmen?`}
          disabled={!can.undo || seq === null}
          onConfirm={() => seq !== null && send({ type: "undo", seq })}
        />
      </div>
      {can.assignLastPlace && (
        <ConfirmButton key={d.lastPlayer} label="Letzten Platz vergeben" question={`Letzten Platz an ${d.name(d.lastPlayer)} vergeben?`} onConfirm={() => send({ type: "assign_last_place" })} />
      )}
    </section>
  );
}

function MoreHostTools({ view, d, room }: Props) {
  const { can } = d;
  const send = room.send;
  const late = latecomers(view).map((m) => ({ userId: m.userId, name: m.displayName }));
  return (
    <details className="card more-tools">
      <summary>Weitere Host-Werkzeuge</summary>
      <div className="stack">
        {can.removePlayer && (
          <PickAndAct label="Aus dem Spiel entfernen" options={turnList(view)} confirm={(name) => `${name} wirklich entfernen? Er oder sie bekommt keinen Platz.`} action={(userId) => send({ type: "remove_player", userId })} />
        )}
        {can.addPlayer && <PickAndAct label="Als Nachzügler anhängen" options={late} action={(userId) => send({ type: "add_player", userId })} />}
        <Switch on={view.room.settings.reactions} disabled={!can.toggleReactions} onChange={(on) => send({ type: "update_settings", settings: { reactions: on } })} label="Reaktionen im Raum erlaubt" />
        <RoomLink view={view} d={d} send={send} />
        <span className="row">
          <ConfirmButton label="Spiel beenden" question="Spiel wirklich beenden?" disabled={!can.end} className="danger" onConfirm={() => send({ type: "end" })} />
          <ConfirmButton label="Zurück in die Lobby" question={RESET_QUESTION} disabled={!can.reset} className="danger" onConfirm={() => send({ type: "reset" })} />
        </span>
      </div>
    </details>
  );
}

export function History({ view, d }: { view: RoomView; d: Derived }) {
  const [moderation, setModeration] = useState(false);
  const lines = historyLines(view, d.showModeration && moderation);
  return (
    <section className="panel stack history-panel" aria-labelledby="history">
      <h2 id="history">
        <span className="icon" aria-hidden="true">📜</span>
        Verlauf
      </h2>
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
    <section className="panel stack gifts-panel" aria-labelledby="gifts">
      <h2 id="gifts">
        <span className="icon" aria-hidden="true">🎁</span>
        Geschenk-Reihenfolge
      </h2>
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

function TurnOrder({ view, busy }: { view: RoomView; busy: boolean }) {
  return (
    <section className="panel stack turns-panel" aria-labelledby="order">
      <h2 id="order">
        <span className="icon" aria-hidden="true">🎲</span>
        Zugreihenfolge (Runde {view.game.round})
      </h2>
      <ol className="turns">
        {turnList(view, busy).map((t) => (
          <li key={t.userId} className={t.active ? "is-active" : ""} aria-current={t.active ? "step" : undefined}>
            <span>{t.name}</span>
            <span className="badges">
              {t.twoDice && <span className="badge badge-bonus">2 Würfel</span>}
              {t.isSimulated && <span className="badge badge-test">Testspieler</span>}
              <span className={`badge conn-${t.connected ? "ok" : "lost"}`}>{t.connected ? "verbunden" : "getrennt"}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Game({ view, d, room, onSettled }: Props & { onSettled: () => void }) {
  const [hideReactions] = useFlag(HIDE_REACTIONS_KEY);
  const { game } = view;
  const locked = rollLocked(room.roll);
  const busy = rollBusy(room.roll);
  const inTurn = d.myId !== null && game.turnOrder.includes(d.myId);
  const lastGift = lastGiftText(view);

  return (
    <div className="game">
      {/* Three columns on a desktop (views.css); on a phone the columns dissolve and CSS order restores
          the reading order: dice, host tools, gifts, turns, reactions, more tools, history, participants. */}
      <div className="game-col game-main">
        <section className="reaction-stage stage" aria-labelledby="turn">
          <p id="turn" className={`turn ${d.myId !== null && shownTurn(view, busy) === d.myId ? "is-me" : ""}`} aria-live="polite">
            {turnText(view, d.myId, busy)}
          </p>
          <p className="pause" role="status">
            {game.pause === "host" ? "Pausiert. Ein Host macht gleich weiter." : ""}
          </p>
          {d.showModeration && game.activeUserId && !d.activeConnected && (
            <p className="warning" role="status">
              {d.activeName} ist getrennt. Du kannst überspringen oder für {d.activeName} würfeln.
            </p>
          )}
          <Dice values={shownDice(room.roll, view)} rollKey={room.roll.rollKey} count={game.activeDiceCount} onSettled={onSettled} />
          <p className="roll-caption">{rollCaption(view, d.myId, busy)}</p>
          <FloatingReactions items={room.floating} hidden={hideReactions} />
          {lastGift && <p className="last-gift">{lastGift}</p>}
          {(inTurn || d.can.claimLastPlace) && (
            <p className="actions">
              {inTurn && (
                <button type="button" className="primary big" disabled={!d.can.roll || locked} onClick={() => room.send({ type: "roll" })}>
                  {d.isActive && game.activeDiceCount === 2 ? "Mit 2 Würfeln würfeln" : "Würfeln"}
                </button>
              )}
              {d.can.claimLastPlace && (
                <button type="button" disabled={locked} onClick={() => room.send({ type: "claim_last_place" })}>
                  Letzten Platz nehmen
                </button>
              )}
            </p>
          )}
        </section>

        {d.showModeration && <HostBar view={view} d={d} room={room} />}

        {!d.isGuest && (
          <section className="reactions" aria-label="Reaktionen">
            {!d.isActive && view.room.settings.reactions && <ReactionBar disabled={!d.can.react} onReact={(emoji) => room.send({ type: "react", emoji })} />}
            <ReactionsToggle />
          </section>
        )}
      </div>

      <div className="game-col game-left">
        <GiftOrder view={view} />
        <HowTo settings={view.room.settings} />
        {d.showModeration && <MoreHostTools view={view} d={d} room={room} />}
      </div>

      <div className="game-col game-right">
        <TurnOrder view={view} busy={busy} />
        <History view={view} d={d} />
        {!d.isGuest && (
          <details className="card people-panel">
            <summary>Teilnehmer ({view.members.length})</summary>
            <Participants view={view} d={d} send={room.send} />
          </details>
        )}
      </div>
    </div>
  );
}
