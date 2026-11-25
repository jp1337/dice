import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DieFace } from "./components/Dice.js";
import { SoundToggle, ThemeToggle } from "./components/Toggles.js";
import { parseRoute } from "./lib/routes.js";
import { GuestPage, RoomPage } from "./views/RoomPage.js";
import { StartPage } from "./views/Start.js";
import "./views/views.css";

function App() {
  const route = parseRoute(location.pathname);
  return (
    <>
      <main>
        {route.page === "start" && (
          <div className="start">
            <header className="hero">
              <div className="hero-dice">
                <DieFace value={5} />
                <DieFace value={6} />
              </div>
              <h1 className="ribbon">Würfel</h1>
            </header>
            <StartPage />
          </div>
        )}
        {route.page === "room" && <RoomPage slug={route.slug} />}
        {route.page === "guest" && <GuestPage token={route.token} />}
      </main>
      <footer>
        <span>
          <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a> · <a href="https://github.com/jp1337/dice">GitHub</a>
        </span>
        <div className="me">
          <SoundToggle />
          <ThemeToggle />
        </div>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
