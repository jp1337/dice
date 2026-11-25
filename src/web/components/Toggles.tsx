// The per-browser switches of spec 10, 10.1 and 4.11, ready to place in the header or footer.
import { useId } from "react";
import { useSound, useTheme } from "../lib/hooks.js";
import type { ThemeChoice } from "../lib/prefs.js";
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

// showState: "ja"/"nein" after the label, for switches in a list where the track alone is easy to misread.
// ariaLabel: names the switch with its context ("Anna würfelt mit"); it must contain the visible label.
type SwitchProps = { on: boolean; onChange: (on: boolean) => void; label: string; ariaLabel?: string; disabled?: boolean; showState?: boolean };

export function Switch({ on, onChange, label, ariaLabel, disabled = false, showState = false }: SwitchProps) {
  return (
    <button type="button" className="switch" role="switch" aria-checked={on} aria-label={ariaLabel} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="switch-track" aria-hidden="true" />
      <span>
        {label}
        {showState && <span className="switch-state">{on ? ": ja" : ": nein"}</span>}
      </span>
    </button>
  );
}

// Two switches: some want the six's jingle but not thirty dice rolls, or the other way round.
export function SoundToggles() {
  const { rollOff, setRollOff, sixOff, setSixOff, turnOff, setTurnOff } = useSound();
  return (
    // Short labels under one "Ton:" so the footer stays one line; the group names them for screen readers.
    <div className="sound-toggles" role="group" aria-label="Töne">
      <span aria-hidden="true">Ton:</span>
      <Switch on={!rollOff} onChange={(on) => setRollOff(!on)} label="Würfel" />
      <Switch on={!sixOff} onChange={(on) => setSixOff(!on)} label="Gewinner" />
      <Switch on={!turnOff} onChange={(on) => setTurnOff(!on)} label="Dran" />
    </div>
  );
}
