import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { MeResponse } from "../shared/contracts.js";

// After the login Discord sends the user back to the page they came from.
function loginHref() {
  const here = location.pathname + location.search;
  return here === "/" ? "/auth/login" : `/auth/login?next=${encodeURIComponent(here)}`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

async function logout() {
  await fetch("/auth/logout", { method: "POST" });
  location.reload();
}

function Start() {
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

  if (failed) return <p>Der Server ist gerade nicht erreichbar. Bitte lade die Seite in einer Minute neu.</p>;
  if (me === undefined) return null;
  if (me === null) {
    return (
      <>
        <p>
          Hier würfeln wir gemeinsam aus, in welcher Reihenfolge die Geschenke verteilt werden. Zum Mitmachen meldest du
          dich mit deinem Discord-Konto an. Das klappt nur, wenn du auf unserem Discord-Server bist.
        </p>
        <p className="login">
          <a className="button" href={loginHref()}>
            Mit Discord anmelden
          </a>{" "}
          <a href="/datenschutz">Datenschutzhinweis</a>
        </p>
      </>
    );
  }
  return (
    <>
      <p className="me">
        {me.avatarUrl ? (
          <img className="avatar" src={me.avatarUrl} alt="" width={48} height={48} />
        ) : (
          <span className="avatar placeholder" aria-hidden="true">
            {initials(me.displayName)}
          </span>
        )}
        <span>Angemeldet als {me.displayName}</span>
        <button type="button" onClick={logout}>
          Abmelden
        </button>
      </p>
      {me.isHost && (
        <p>
          <button type="button" disabled>
            Raum erstellen (kommt bald)
          </button>
        </p>
      )}
    </>
  );
}

function App() {
  return (
    <>
      <main>
        <h1>Würfel</h1>
        <Start />
      </main>
      <footer>
        <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a> ·{" "}
        <a href="https://github.com/jp1337/dice">GitHub</a>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
