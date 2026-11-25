// Per-browser preferences: theme (spec 10), sound (10.1), hidden reactions (4.11). localStorage can be
// missing or throw (private mode, blocked site data), so a value set in this session is also kept in
// memory: the choice then holds until the page is reloaded instead of silently doing nothing.

// test/web.test.ts checks that src/web/public/theme-init.js reads the same key.
export const THEME_KEY = "dice.theme";
export const MUTED_KEY = "dice.muted"; // before the two switches: both sounds off; read once, then moved
export const SOUND_OFF_KEYS = { roll: "dice.muted.roll", six: "dice.muted.six" } as const; // per sound, spec 10.1

export type ThemeChoice = "light" | "dark" | "system";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createPrefs(storage: () => Store) {
  const memory = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  return {
    get(key: string): string | null {
      if (memory.has(key)) return memory.get(key) ?? null;
      try {
        return storage().getItem(key);
      } catch {
        return null;
      }
    },
    // null removes the key: the default applies again.
    set(key: string, value: string | null) {
      memory.set(key, value);
      try {
        if (value === null) storage().removeItem(key);
        else storage().setItem(key, value);
      } catch {
        // Not persisted; the in-memory value holds until reload.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export const prefs = createPrefs(() => localStorage);

export const themeOf = (stored: string | null): ThemeChoice => (stored === "light" || stored === "dark" ? stored : "system");

// "system" removes the attribute, so the prefers-color-scheme media query decides.
export function applyTheme(root: { dataset: DOMStringMap }, choice: ThemeChoice) {
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
}
