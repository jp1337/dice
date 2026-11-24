// React glue for the preferences and the sound player. All components share one preference store, so a
// toggle in the header and a player in the game view never disagree.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { MUTED_KEY, THEME_KEY, type ThemeChoice, applyTheme, prefs, themeOf } from "./prefs.js";
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

// A boolean preference that defaults to false (MUTED_KEY, HIDE_REACTIONS_KEY).
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

// Sound on by default; muting is per browser (spec 10.1). play() is silent until the first gesture.
export function useSound() {
  const [muted, setMuted] = useFlag(MUTED_KEY);
  useEffect(() => {
    player ??= createSoundPlayer(
      (url) => Object.assign(new Audio(url), { preload: "auto" }),
      window,
      navigator.userActivation?.hasBeenActive ?? false,
    );
  }, []);
  const play = useCallback((name: SoundName) => player?.play(name, muted) ?? false, [muted]);
  return { play, muted, setMuted };
}
