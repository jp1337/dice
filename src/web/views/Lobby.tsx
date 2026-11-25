// Lobby (spec 10): who is here, who rolls, own nickname, the room link; for hosts and co-hosts settings, public switch,
// simulated players (test rooms) and "Start".
import { type FormEvent, useEffect, useId, useState } from "react";
import { MAX_SIMULATED_PLAYERS, NICKNAME_MAX, SIX_MESSAGE_MAX } from "../../shared/constants.js";
import type { ClientMessage, MeResponse, PatchMeRequest, RoomView } from "../../shared/contracts.js";
import { HowTo } from "../components/HowTo.js";
import { Switch } from "../components/Toggles.js";
import { type Derived, cleanText, nicknameError, nicknameResponseMessage, sixMessageError } from "../lib/room.js";
import { CopyButton } from "./Controls.js";
import { Participants } from "./Participants.js";

type Props = { view: RoomView; d: Derived; send: (message: ClientMessage) => void };

function Nickname({ d }: { d: Derived }) {
  const [value, setValue] = useState("");
  const [current, setCurrent] = useState<string | null>(null); // the saved nickname, null = the Discord name
  const [discordName, setDiscordName] = useState("");
  useEffect(() => {
    let alive = true;
    fetch("/api/me")
      .then(async (res) => {
        if (!res.ok || !alive) return;
        const me = (await res.json()) as MeResponse;
        setCurrent(me.nickname);
        if (me.nickname === null) setDiscordName(me.displayName); // without a nickname, the shown name is the Discord one
        setValue((typed) => typed || (me.nickname ?? ""));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
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
      if (!error) {
        setCurrent(body.nickname);
        if (nickname === null) setValue("");
      }
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
        <input
          id={id}
          type="text"
          value={value}
          placeholder={discordName || "Discord-Name"}
          maxLength={NICKNAME_MAX * 2}
          autoComplete="nickname"
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" disabled={busy || !d.can.editNickname}>
          Speichern
        </button>
        {current !== null && (
          <button type="button" disabled={busy || !d.can.editNickname} onClick={() => void save(null)}>
            Discord-Namen nehmen
          </button>
        )}
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
  const [sent, setSent] = useState(false); // "Gespeichert." once the server's state carries the text
  const id = useId();
  useEffect(() => setValue(saved), [saved]); // another host changed it
  // Compared as sent: with a trailing space the saved text never equalled the field, so "Gespeichert." never came.
  const unchanged = cleanText(value) === saved;

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const invalid = sixMessageError(value);
        setError(invalid);
        if (!invalid) {
          send({ type: "update_settings", settings: { sixMessage: cleanText(value) } });
          setValue(cleanText(value));
        }
        setSent(!invalid);
      }}
    >
      <label htmlFor={id}>Text bei einer 6</label>
      <textarea id={id} rows={2} value={value} maxLength={SIX_MESSAGE_MAX * 2} aria-describedby={`${id}-hint`} onChange={(event) => {
          setValue(event.target.value);
          setSent(false);
        }} />
      <span id={`${id}-hint`} className="hint">
        Platzhalter: {"{name}"} für den Namen, {"{platz}"} für die Geschenk-Nummer.
      </span>
      <span className="form-error" role="alert">
        {error}
      </span>
      <span className="row">
        <button type="submit" disabled={!enabled || unchanged}>
          Text speichern
        </button>
        <span role="status" className="hint">
          {sent && unchanged ? "Gespeichert." : ""}
        </span>
      </span>
    </form>
  );
}

function Settings({ view, d, send }: Props) {
  const s = view.room.settings;
  const update = (settings: Partial<typeof s>) => send({ type: "update_settings", settings });
  const name = useId();
  return (
    <details className="card">
      <summary>Einstellungen</summary>
      <div className="stack">
      <Switch on={s.bonusChains} disabled={!d.can.settings} onChange={(on) => update({ bonusChains: on })} label="Bonus-Kette: eine 1 bei zwei Würfeln gibt erneut 2 Würfel" />
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
      <Switch on={s.reactions} disabled={!d.can.toggleReactions} onChange={(on) => update({ reactions: on })} label="Emoji-Reaktionen erlauben" />
      <SixMessage view={view} send={send} enabled={d.can.settings} />
      </div>
    </details>
  );
}

// The one link of a room (spec 4.8); hosts and co-hosts switch whether it works without a login.
export function RoomLink({ view, d, send }: Props) {
  const { slug, isPublic, guestCount } = view.room;
  return (
    <div className="room-link">
      <span className="row">
        <CopyButton text={`${location.origin}/r/${slug}`} label="Raum-Link kopieren" />
      </span>
      {d.showModeration && (
        <>
          <Switch on={isPublic} disabled={!d.can.setPublic} onChange={(on) => send({ type: "set_public", isPublic: on })} label="Öffentlich" />
          <p className="hint">
            {isPublic
              ? `Jeder mit dem Link kann ohne Anmeldung zuschauen und sieht nur Anzeigenamen. Gäste gerade: ${guestCount ?? 0}`
              : "Nur angemeldete Mitglieder des Discord-Servers sehen den Raum."}
          </p>
        </>
      )}
    </div>
  );
}

function SimulatedPlayers({ view, d, send }: Props) {
  // The limit counts the room's simulated players, so the form offers only what is still free.
  const free = MAX_SIMULATED_PLAYERS - view.members.filter((m) => m.isSimulated).length;
  const [wanted, setCount] = useState(3);
  const count = Math.min(wanted, free); // after adding some, the default never exceeds what is left
  const id = useId();
  const valid = Number.isInteger(count) && count >= 1;
  if (free <= 0) return <p className="hint">{MAX_SIMULATED_PLAYERS} Testspieler sind die Höchstzahl.</p>;
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) send({ type: "add_simulated_players", count });
      }}
    >
      <label htmlFor={id}>Testspieler hinzufügen (1 bis {free})</label>
      <span className="row">
        <input id={id} type="number" min={1} max={free} step={1} value={count} onChange={(event) => setCount(event.target.valueAsNumber)} />
        <button type="submit" disabled={!valid || !d.can.simulatedPlayers}>
          Hinzufügen
        </button>
      </span>
    </form>
  );
}

export function Lobby(props: Props) {
  const { view, d, send } = props;
  const playerCount = d.players.length;
  return (
    <div className="lobby">
      {d.showModeration && (
        <section className="card stack" aria-labelledby="lobby-host">
          <h2 id="lobby-host">
            <span className="icon" aria-hidden="true">🎉</span>
            Spiel starten
          </h2>
          <p>Beim Start lost der Server die Reihenfolge aus allen Würflern aus.</p>
          <span className="row">
            <button type="button" className="primary big" disabled={!d.can.start} onClick={() => send({ type: "start" })}>
              Start
            </button>
          </span>
          {playerCount === 0 && <p className="hint">Es gibt noch keine Würfler.</p>}
          {view.room.isTest && <SimulatedPlayers {...props} />}
        </section>
      )}

      {/* Open for those who play; hosts know the rules and keep the room for their tools. */}
      <HowTo settings={view.room.settings} open={!d.showModeration} />

      <section className="stack" aria-labelledby="lobby-people">
        <h2 id="lobby-people">
          <span className="icon" aria-hidden="true">👥</span>
          Teilnehmer ({view.members.length}, davon {playerCount} Würfler)
        </h2>
        {!d.isGuest && <RoomLink {...props} />}
        <Participants {...props} />
      </section>

      {d.isGuest && <p>Das Spiel hat noch nicht begonnen.</p>}

      {d.me && (
        <section className="card stack" aria-labelledby="lobby-me">
          <h2 id="lobby-me">
            <span className="icon" aria-hidden="true">🙂</span>
            Du
          </h2>
          <Switch
            on={d.me.participation === "player"}
            disabled={!d.can.setOwnParticipation}
            onChange={(on) => send({ type: "set_participation", userId: d.me!.userId, participation: on ? "player" : "spectator" })}
            label="Ich würfle mit"
          />
          <Nickname d={d} />
        </section>
      )}

      {d.showModeration && <Settings {...props} />}
    </div>
  );
}
