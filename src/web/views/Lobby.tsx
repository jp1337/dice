// Lobby (spec 10): who is here, who rolls, own nickname; for hosts and co-hosts settings, guest link,
// simulated players (test rooms) and "Start".
import { type FormEvent, useEffect, useId, useState } from "react";
import { NICKNAME_MAX, SIX_MESSAGE_MAX } from "../../shared/constants.js";
import type { ClientMessage, PatchMeRequest, RoomView } from "../../shared/contracts.js";
import { Switch } from "../components/Toggles.js";
import { type Derived, cleanText, nicknameError, nicknameResponseMessage, sixMessageError } from "../lib/room.js";
import { ConfirmButton, CopyButton } from "./Controls.js";
import { Participants } from "./Participants.js";

type Props = { view: RoomView; d: Derived; send: (message: ClientMessage) => void };

function Nickname({ d }: { d: Derived }) {
  const [value, setValue] = useState(d.me?.displayName ?? "");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  const save = async (nickname: string | null) => {
    if (nickname !== null) {
      const invalid = nicknameError(nickname);
      if (invalid) return setMessage({ ok: false, text: invalid });
    }
    setBusy(true);
    try {
      const body: PatchMeRequest = { nickname: nickname === null ? null : cleanText(nickname) };
      const res = await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const error = nicknameResponseMessage(res.status);
      setMessage(error ? { ok: false, text: error } : { ok: true, text: nickname === null ? "Zurückgesetzt auf deinen Discord-Namen." : "Gespeichert." });
    } catch {
      setMessage({ ok: false, text: "Der Server ist gerade nicht erreichbar." });
    }
    setBusy(false);
  };

  return (
    <form
      className="inline-form"
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void save(value);
      }}
    >
      <label htmlFor={id}>Dein Spitzname (in allen Räumen, 1 bis {NICKNAME_MAX} Zeichen)</label>
      <span className="row">
        <input id={id} type="text" value={value} maxLength={NICKNAME_MAX * 2} autoComplete="nickname" onChange={(event) => setValue(event.target.value)} />
        <button type="submit" disabled={busy || !d.can.editNickname}>
          Speichern
        </button>
        <button type="button" disabled={busy || !d.can.editNickname} onClick={() => void save(null)}>
          Discord-Name
        </button>
      </span>
      <span className={message?.ok ? "form-ok" : "form-error"} role="status">
        {message?.text}
      </span>
    </form>
  );
}

function SixMessage({ view, send, enabled }: { view: RoomView; send: Props["send"]; enabled: boolean }) {
  const saved = view.room.settings.sixMessage;
  const [value, setValue] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  useEffect(() => setValue(saved), [saved]); // another host changed it

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const invalid = sixMessageError(value);
        setError(invalid);
        if (!invalid) send({ type: "update_settings", settings: { sixMessage: cleanText(value) } });
      }}
    >
      <label htmlFor={id}>Text bei einer 6</label>
      <textarea id={id} rows={2} value={value} maxLength={SIX_MESSAGE_MAX * 2} aria-describedby={`${id}-hint`} onChange={(event) => setValue(event.target.value)} />
      <span id={`${id}-hint`} className="hint">
        Platzhalter: {"{name}"} für den Namen, {"{platz}"} für die Geschenk-Nummer.
      </span>
      <span className="form-error" role="alert">
        {error}
      </span>
      <span className="row">
        <button type="submit" disabled={!enabled || value === saved}>
          Text speichern
        </button>
      </span>
    </form>
  );
}

function Settings({ view, d, send }: Props) {
  const s = view.room.settings;
  const update = (settings: Partial<typeof s>) => send({ type: "update_settings", settings });
  const name = useId();
  return (
    <section className="card stack" aria-labelledby={`${name}-h`}>
      <h2 id={`${name}-h`}>Einstellungen</h2>
      <Switch on={s.bonusChains} onChange={(on) => d.can.settings && update({ bonusChains: on })} label="Bonus-Kette: eine 1 bei zwei Würfeln gibt erneut 2 Würfel" />
      <fieldset className="stack">
        <legend>Letzter Würfler</legend>
        <label className="check">
          <input type="radio" name={name} checked={s.lastPlayer === "choice"} disabled={!d.can.settings} onChange={() => update({ lastPlayer: "choice" })} />
          entscheidet selbst: weiterwürfeln oder den letzten Platz nehmen
        </label>
        <label className="check">
          <input type="radio" name={name} checked={s.lastPlayer === "auto"} disabled={!d.can.settings} onChange={() => update({ lastPlayer: "auto" })} />
          bekommt den letzten Platz sofort
        </label>
      </fieldset>
      <Switch on={s.reactions} onChange={(on) => d.can.toggleReactions && update({ reactions: on })} label="Emoji-Reaktionen erlauben" />
      <SixMessage view={view} send={send} enabled={d.can.settings} />
    </section>
  );
}

export function GuestLink({ view, d, send }: Props) {
  const { watchLinkActive, watchUrl, guestCount } = view.room;
  return (
    <div className="stack">
      <h3>Zuschauer-Link für Gäste ohne Discord</h3>
      {watchLinkActive ? (
        <>
          {watchUrl && <CopyButton text={watchUrl} label="Zuschauer-Link kopieren" />}
          <p className="hint">Gäste gerade: {guestCount ?? 0}</p>
          <span className="row">
            <ConfirmButton label="Neu erzeugen" question="Neuen Link erzeugen? Alle Gäste werden getrennt." disabled={!d.can.watchLink} onConfirm={() => send({ type: "set_watch_link", action: "regenerate" })} />
            <ConfirmButton label="Ausschalten" question="Link ausschalten? Alle Gäste werden getrennt." disabled={!d.can.watchLink} onConfirm={() => send({ type: "set_watch_link", action: "disable" })} />
          </span>
        </>
      ) : (
        <span className="row">
          <button type="button" disabled={!d.can.watchLink} onClick={() => send({ type: "set_watch_link", action: "enable" })}>
            Zuschauer-Link einschalten
          </button>
        </span>
      )}
    </div>
  );
}

function SimulatedPlayers({ d, send }: Props) {
  const [count, setCount] = useState(3);
  const id = useId();
  const valid = Number.isInteger(count) && count >= 1 && count <= 30;
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) send({ type: "add_simulated_players", count });
      }}
    >
      <label htmlFor={id}>Testspieler hinzufügen (1 bis 30)</label>
      <span className="row">
        <input id={id} type="number" min={1} max={30} step={1} value={count} onChange={(event) => setCount(event.target.valueAsNumber)} />
        <button type="submit" disabled={!valid || !d.can.simulatedPlayers}>
          Hinzufügen
        </button>
      </span>
    </form>
  );
}

export function Lobby(props: Props) {
  const { view, d, send } = props;
  const roomLink = `${location.origin}/r/${view.room.slug}`;
  const playerCount = d.players.length;
  return (
    <div className="lobby">
      <section className="stack" aria-labelledby="lobby-people">
        <h2 id="lobby-people">
          Teilnehmer ({view.members.length}, davon {playerCount} Würfler)
        </h2>
        {!d.isGuest && (
          <span className="row">
            <CopyButton text={roomLink} label="Raum-Link kopieren" />
          </span>
        )}
        <Participants {...props} />
      </section>

      {d.isGuest && <p>Das Spiel hat noch nicht begonnen.</p>}

      {d.me && (
        <section className="card stack" aria-labelledby="lobby-me">
          <h2 id="lobby-me">Du</h2>
          <Switch
            on={d.me.participation === "player"}
            onChange={(on) => d.can.setOwnParticipation && send({ type: "set_participation", userId: d.me!.userId, participation: on ? "player" : "spectator" })}
            label="Ich würfle mit"
          />
          <Nickname d={d} />
        </section>
      )}

      {d.showModeration && (
        <>
          <section className="card stack" aria-labelledby="lobby-host">
            <h2 id="lobby-host">Spiel starten</h2>
            <p>Beim Start lost der Server die Reihenfolge aus allen Würflern aus.</p>
            <span className="row">
              <button type="button" className="primary big" disabled={!d.can.start} onClick={() => send({ type: "start" })}>
                Start
              </button>
            </span>
            {playerCount === 0 && <p className="hint">Es gibt noch keine Würfler.</p>}
            {view.room.isTest && <SimulatedPlayers {...props} />}
            <GuestLink {...props} />
          </section>
          <Settings {...props} />
        </>
      )}
    </div>
  );
}
