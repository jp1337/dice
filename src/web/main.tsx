import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <>
      <main>
        <h1>Würfel</h1>
        <p>Hier entsteht das Würfel-Tool für die Geschenk-Reihenfolge.</p>
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
