// The room (/r/:slug): connection, status, error pages, then the screen that fits the game status.
// Without a login a public room shows the guest view: the same screens without anything that sends (spec 4.8, 10).
import { useEffect, useState } from "react";
import type { RoomSummary, RoomView } from "../../shared/contracts.js";
import { SixBanner } from "../components/SixBanner.js";
import { type ProbeResult, showErrorPage, statusLabel } from "../lib/connection.js";
import { deriveRoom, finalSixOpen, sixBannerValues } from "../lib/room.js";
import { rollBusy } from "../lib/roll.js";
import { loginHref, socketUrl } from "../lib/routes.js";
import { useRoom } from "../lib/useRoom.js";
import { Game } from "./Game.js";
import { Lobby } from "./Lobby.js";
import { Result } from "./Result.js";
import { LoginPrompt } from "./Start.js";

const probeRoom = (slug: string) => async (): Promise<ProbeResult> => {
  const res = await fetch(`/api/rooms/${encodeURIComponent(slug)}`);
  return res.status === 401 ? "login" : res.status === 404 ? "gone" : "ok";
};

function NotFound({ title, text }: { title: string; text: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p>{text}</p>
      <p>
        <a className="button" href="/">
          Zur Startseite
        </a>
      </p>
    </>
  );
}

export function RoomPage({ slug }: { slug: string }) {
  // undefined: loading; null: the server did not answer, the WebSocket still gets its chance.
  const [summary, setSummary] = useState<RoomSummary | "login" | "gone" | null | undefined>(undefined);
  useEffect(() => {
    fetch(`/api/rooms/${encodeURIComponent(slug)}`)
      .then(async (res) => {
        if (res.status === 401) return setSummary("login");
        if (res.status === 404) return setSummary("gone");
        setSummary(res.ok ? ((await res.json()) as RoomSummary) : null);
      })
      .catch(() => setSummary(null));
  }, [slug]);

  if (summary === undefined) return <p role="status">Lädt …</p>;
  if (summary === "login") {
    return (
      <>
        <h1>Würfel</h1>
        <LoginPrompt intro="Du wurdest in einen Raum eingeladen. Zum Mitmachen meldest du dich mit deinem Discord-Konto an. Danach bist du direkt im Raum." />
      </>
    );
  }
  if (summary === "gone") return <NotFound title="Raum nicht gefunden" text="Diesen Raum gibt es nicht oder nicht mehr. Prüfe den Link oder frag beim Host nach." />;
  return <Live url={socketUrl(location, `/ws/rooms/${encodeURIComponent(slug)}`)} probe={probeRoom(slug)} title={summary?.name ?? "Raum"} gone="Diesen Raum gibt es nicht mehr." />;
}

function Live({ url, probe, title, gone }: { url: string; probe: () => Promise<ProbeResult>; title: string; gone: string }) {
  const room = useRoom(url, probe, gone);
  const { status, view } = room;
  const label = statusLabel(status, view !== null);

  if (status.kind === "login") {
    return (
      <>
        <h1>{title}</h1>
        <LoginPrompt intro={status.message} />
      </>
    );
  }
  if (showErrorPage(status, view !== null)) {
    const final = status.kind === "stopped";
    return (
      <>
        <h1>{title}</h1>
        <div className="card stack" role="alert">
          <h2>{final ? "Verbindung beendet" : "Keine Verbindung zum Server"}</h2>
          <p>
            {final
              ? status.message
              : "Der Server ist gerade nicht erreichbar. Vielleicht ist dein Netz weg oder der Server startet neu. Die Seite versucht es automatisch weiter."}
          </p>
          <p className="actions">
            {final ? (
              <button type="button" className="primary" onClick={() => location.reload()}>
                Neu laden
              </button>
            ) : (
              <button type="button" className="primary" onClick={room.retryNow}>
                Jetzt erneut versuchen
              </button>
            )}
            <a className="button" href="/">
              Zur Startseite
            </a>
          </p>
        </div>
      </>
    );
  }
  if (!view) {
    return (
      <>
        <h1>{title}</h1>
        <p role="status" className="connecting">
          {label === "verbinde neu …" ? "Verbinde neu …" : "Verbinde mit dem Raum …"}
        </p>
      </>
    );
  }
  return <RoomScreen view={view} room={room} label={label} />;
}

function RoomScreen({ view, room, label }: { view: RoomView; room: ReturnType<typeof useRoom>; label: string }) {
  const online = room.status.kind === "open";
  const d = deriveRoom(view, online);
  const busy = rollBusy(room.roll);
  const [finalSixSeq, setFinalSixSeq] = useState<number | null>(null);
  const finalSix = finalSixOpen(view, finalSixSeq);
  const { status } = view.game;
  // The game view stays while the last roll still tumbles, so the result never spoils the dice.
  const screen = status === "lobby" ? "lobby" : status === "running" || busy || finalSix ? "game" : "result";

  // A six that ends the game has no pause, so no host "Weiter": everyone closes the banner themselves.
  const onSettled = () => {
    room.settled();
    const dice = room.roll.dice ?? [];
    if (dice.includes(6)) {
      room.play("six");
      if (view.game.status === "finished") setFinalSixSeq(d.newestRollSeq);
    }
  };
  const six = sixBannerValues(view);
  const showSix = !busy && six !== null && (view.game.pause === "six" || finalSix);

  return (
    <>
      <title>{`${view.room.name} – Würfel`}</title>
      <header className="room-header">
        <h1>{view.room.name}</h1>
        <p className="badges">
          {view.room.isTest && <span className="badge badge-test">Testraum</span>}
          <span className={`badge conn conn-${online ? "ok" : "lost"}`} role="status">
            {label}
          </span>
        </p>
        {d.isGuest && (
          <p className="note">
            Du schaust als Gast zu. Zum Mitmachen <a href={loginHref(location.pathname)}>mit Discord anmelden</a>.
          </p>
        )}
        {view.room.isPublic && !d.isGuest && <p className="note">Öffentlicher Raum: Gäste ohne Anmeldung sehen deinen Anzeigenamen.</p>}
      </header>
      <p className="notice" role="alert">
        {room.notice?.text}
      </p>
      {screen === "lobby" && <Lobby view={view} d={d} send={room.send} />}
      {screen === "game" && <Game view={view} d={d} room={room} onSettled={onSettled} />}
      {screen === "result" && <Result view={view} d={d} send={room.send} />}
      {showSix && (
        <SixBanner template={view.room.settings.sixMessage} name={six.name} platz={six.platz}>
          {finalSix ? (
            <button type="button" className="primary" onClick={() => setFinalSixSeq(null)}>
              Zum Ergebnis
            </button>
          ) : (
            d.showModeration && (
              <button type="button" className="primary" disabled={!d.can.continue} onClick={() => room.send({ type: "continue" })}>
                Weiter
              </button>
            )
          )}
        </SixBanner>
      )}
    </>
  );
}
