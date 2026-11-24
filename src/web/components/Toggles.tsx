// The per-browser switches of spec 10, 10.1 and 4.11, ready to place in the header or footer.
import { useId } from "react";
import { useFlag, useSound, useTheme } from "../lib/hooks.js";
import { HIDE_REACTIONS_KEY, type ThemeChoice } from "../lib/prefs.js";
import "./Toggles.css";

const THEMES: [ThemeChoice, string][] = [
  ["light", "Hell"],
  ["dark", "Dunkel"],
  ["system", "System"],
];

// Native radios: arrow keys and screen readers work without extra code.
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const name = useId();
  return (
    <fieldset className="theme-toggle">
      <legend className="sr-only">Farbschema</legend>
      {THEMES.map(([value, label]) => (
        <label key={value}>
          <input type="radio" name={name} value={value} checked={theme === value} onChange={() => setTheme(value)} />
          <span>{label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button type="button" className="switch" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="switch-track" aria-hidden="true" />
      {label}
    </button>
  );
}

export function SoundToggle() {
  const { muted, setMuted } = useSound();
  return <Switch on={!muted} onChange={(on) => setMuted(!on)} label="Ton" />;
}

export function ReactionsToggle() {
  const [hidden, setHidden] = useFlag(HIDE_REACTIONS_KEY);
  return <Switch on={!hidden} onChange={(on) => setHidden(!on)} label="Reaktionen" />;
}
