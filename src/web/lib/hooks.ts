// React glue for the preferences and the sound player. All components share one preference store, so a
// toggle in the header and a player in the game view never disagree.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { MUTED_KEY, SOUND_OFF_KEYS, THEME_KEY, type ThemeChoice, applyTheme, prefs, themeOf } from "./prefs.js";
import { type SoundName, createSoundPlayer } from "./sound.js";

const usePref = (key: string) => useSyncExternalStore(prefs.subscribe, () => prefs.get(key));

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const theme = themeOf(usePref(THEME_KEY));
  const setTheme = useCallback((choice: ThemeChoice) => {
    prefs.set(THEME_KEY, choice === "system" ? null : choice);
    applyTheme(document.documentElement, choice);
  }, []);
  return [theme, setTheme];
}

// A boolean preference that defaults to false (SOUND_OFF_KEYS).
export function useFlag(key: string): [boolean, (on: boolean) => void] {
  const on = usePref(key) === "1";
  const set = useCallback((value: boolean) => prefs.set(key, value ? "1" : null), [key]);
  return [on, set];
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)");
export function useReducedMotion() {
  return useSyncExternalStore(
    (onChange) => {
      const query = reducedMotion();
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => reducedMotion().matches,
  );
}

let player: ReturnType<typeof createSoundPlayer> | undefined;

// The old single switch muted both sounds: carry that over to the two switches, once.
export function migrateMuted(store: Pick<typeof prefs, "get" | "set"> = prefs) {
  if (store.get(MUTED_KEY) !== "1") return;
  store.set(SOUND_OFF_KEYS.roll, "1");
  store.set(SOUND_OFF_KEYS.six, "1");
  store.set(MUTED_KEY, null);
}

// Both sounds on by default; each can be muted per browser (spec 10.1). play() is silent until the first gesture.
export function useSound() {
  const [rollOff, setRollOff] = useFlag(SOUND_OFF_KEYS.roll);
  const [sixOff, setSixOff] = useFlag(SOUND_OFF_KEYS.six);
  useEffect(() => {
    migrateMuted();
    player ??= createSoundPlayer(
      (url) => Object.assign(new Audio(url), { preload: "auto" }),
      window,
      navigator.userActivation?.hasBeenActive ?? false,
    );
  }, []);
  const play = useCallback((name: SoundName) => player?.play(name, name === "roll" ? rollOff : sixOff) ?? false, [rollOff, sixOff]);
  return { play, rollOff, setRollOff, sixOff, setSixOff };
}
