import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DieFace } from "./components/Dice.js";
import { SoundToggles, ThemeToggle } from "./components/Toggles.js";
import { parseRoute } from "./lib/routes.js";
import { RoomPage } from "./views/RoomPage.js";
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
      </main>
      <footer>
        <span>
          <a href="/">Start</a> · <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a> · <a href="https://github.com/jp1337/dice">GitHub</a>
        </span>
        {/* A room page puts its privacy note here (RoomPage, portal): it took a whole line at the top. */}
        <span id="footer-note" className="footer-note" />
        <div className="me">
          <SoundToggles />
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
