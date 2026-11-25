// Start page (spec 10): what this is, the login, and for hosts "Raum erstellen".
import { type FormEvent, useEffect, useId, useState } from "react";
import { ROOM_NAME_MAX } from "../../shared/constants.js";
import type { CreateRoomRequest, CreateRoomResponse, MeResponse } from "../../shared/contracts.js";
import { Avatar } from "../components/Avatar.js";
import { cleanText, createRoomResponseMessage, roomNameError } from "../lib/room.js";
import { loginHref } from "../lib/routes.js";

async function logout() {
  await fetch("/auth/logout", { method: "POST" });
  location.assign("/");
}

export function LoginPrompt({ intro }: { intro: string }) {
  return (
    <>
      <p className="lead">{intro}</p>
      <p className="login">
        <a className="button primary" href={loginHref(location.pathname + location.search)}>
          Mit Discord anmelden
        </a>{" "}
        <a href="/datenschutz">Datenschutzhinweis</a>
      </p>
    </>
  );
}

function CreateRoom() {
  const [name, setName] = useState("");
  const [isTest, setIsTest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const errorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = roomNameError(name);
    setError(invalid);
    if (invalid) return;
    setBusy(true);
    try {
      const body: CreateRoomRequest = { name: cleanText(name), isTest };
      const res = await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const message = createRoomResponseMessage(res.status);
      if (message) throw new Error(message);
      const { slug } = (await res.json()) as CreateRoomResponse;
      location.assign(`/r/${encodeURIComponent(slug)}`);
    } catch (err) {
      setError(err instanceof TypeError ? "Der Server ist gerade nicht erreichbar." : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit} noValidate>
      <h2>
        <span className="icon" aria-hidden="true">✨</span>
        Raum erstellen
      </h2>
      <label htmlFor={nameId}>Name des Raums</label>
      <input
        id={nameId}
        type="text"
        value={name}
        maxLength={ROOM_NAME_MAX * 2}
        autoComplete="off"
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => setName(event.target.value)}
      />
      <label className="check">
        <input type="checkbox" checked={isTest} onChange={(event) => setIsTest(event.target.checked)} />
        Testraum (mit simulierten Mitspielern zum Proben; lässt sich später nicht ändern)
      </label>
      <p id={errorId} className="form-error" role="alert">
        {error}
      </p>
      <button type="submit" className="primary" disabled={busy}>
        Raum erstellen
      </button>
    </form>
  );
}

export function StartPage() {
  // undefined = loading, null = not logged in
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then(async (res) => {
        if (res.status === 401) return setMe(null);
        if (!res.ok) throw new Error(String(res.status));
        setMe((await res.json()) as MeResponse);
      })
      .catch(() => setFailed(true));
  }, []);

  const intro =
    "Hier würfeln wir gemeinsam aus, in welcher Reihenfolge die Geschenke verteilt werden. Zum Mitmachen meldest du dich mit deinem Discord-Konto an. Das klappt nur, wenn du auf unserem Discord-Server bist.";

  if (failed) return <p role="alert">Der Server ist gerade nicht erreichbar. Bitte lade die Seite in einer Minute neu.</p>;
  if (me === undefined) return <p role="status">Lädt …</p>;
  if (me === null) return <LoginPrompt intro={intro} />;
  return (
    <>
      <p className="me">
        <Avatar userId={me.userId} name={me.displayName} avatarUrl={me.avatarUrl} />
        <span>Angemeldet als {me.displayName}</span>
        <button type="button" onClick={logout}>
          Abmelden
        </button>
      </p>
      {me.isHost ? (
        <CreateRoom />
      ) : (
        <p>Den Link zum Raum bekommst du von einem Host. Öffne ihn einfach, du bist dann sofort dabei.</p>
      )}
    </>
  );
}
