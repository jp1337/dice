import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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
          <>
            <h1>Würfel</h1>
            <StartPage />
          </>
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
