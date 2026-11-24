// The logic behind the web components, the public assets and the CSP rules for src/web. No DOM
// library: the logic lives in plain modules (src/web/lib), the components stay thin.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SixBanner } from "../src/web/components/SixBanner.js";
import * as constants from "../src/shared/constants.js";
import * as contracts from "../src/shared/contracts.js";
import { THEME_KEY, applyTheme, createPrefs, themeOf } from "../src/web/lib/prefs.js";
import { type Clip, createSoundPlayer } from "../src/web/lib/sound.js";
import { AVATAR_TONES, FLOAT_LANES, FLOAT_MS, ROLL_ANIMATION_MS, avatarTone, cooldownLeft, expandBurst, fillTemplate, initials } from "../src/web/lib/ui.js";

const { REACTION_INTERVAL_MS, ROLL_COOLDOWN_MS } = constants;
const web = (file: string) => new URL(`../src/web/${file}`, import.meta.url);
const read = (file: string) => readFileSync(web(file), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(path.join(dir, name)).isDirectory() ? walk(path.join(dir, name)) : [path.join(dir, name)]));
}
const sources = walk(web(".").pathname).filter((file) => /\.(tsx?|html)$/.test(file));

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}
const fail = () => {
  throw new DOMException("blocked", "SecurityError");
};

describe("preferences", () => {
  it("persist in localStorage", () => {
    const storage = memoryStorage();
    createPrefs(() => storage).set(THEME_KEY, "dark");
    expect(storage.getItem(THEME_KEY)).toBe("dark");
    expect(createPrefs(() => storage).get(THEME_KEY)).toBe("dark"); // after a reload
    createPrefs(() => storage).set(THEME_KEY, null);
    expect(storage.getItem(THEME_KEY)).toBeNull();
  });

  it.each([
    ["localStorage itself throws", fail],
    ["every method throws", () => ({ getItem: fail, setItem: fail, removeItem: fail })],
  ])("survive when %s, and hold the choice for the session", (_name, storage) => {
    const prefs = createPrefs(storage);
    expect(prefs.get(THEME_KEY)).toBeNull();
    let notified = 0;
    prefs.subscribe(() => notified++);
    expect(() => prefs.set(THEME_KEY, "light")).not.toThrow();
    expect(prefs.get(THEME_KEY)).toBe("light");
    expect(notified).toBe(1);
  });

  it("read only light and dark as a fixed theme", () => {
    expect([themeOf("light"), themeOf("dark"), themeOf(null), themeOf("purple")]).toEqual(["light", "dark", "system", "system"]);
    const root = { dataset: {} as DOMStringMap };
    applyTheme(root, "dark");
    expect(root.dataset.theme).toBe("dark");
    applyTheme(root, "system");
    expect("theme" in root.dataset).toBe(false);
  });
});

describe("theme-init.js (runs before the first paint)", () => {
  const script = read("public/theme-init.js");
  const run = (localStorage: unknown) => {
    const document = { documentElement: { dataset: {} as Record<string, string> } };
    runInNewContext(script, { document, localStorage });
    return document.documentElement.dataset.theme;
  };

  it("uses the key of prefs.ts", () => {
    expect(script).toContain(`"${THEME_KEY}"`);
  });

  it("applies a stored choice and ignores anything else", () => {
    const storage = memoryStorage();
    storage.setItem(THEME_KEY, "dark");
    expect(run(storage)).toBe("dark");
    storage.setItem(THEME_KEY, "<script>");
    expect(run(storage)).toBeUndefined();
    expect(run(memoryStorage())).toBeUndefined();
  });

  it("does not throw when storage is blocked", () => {
    expect(() => run({ getItem: fail })).not.toThrow();
  });
});

describe("sound player", () => {
  function setup(alreadyActive = false) {
    const clips: (Clip & { plays: { muted: boolean }[] })[] = [];
    const makeClip = () => {
      const clip = { currentTime: 0, muted: false, plays: [] as { muted: boolean }[], pause() {}, play: async () => void clip.plays.push({ muted: clip.muted }) };
      clips.push(clip);
      return clip;
    };
    const target = new EventTarget();
    return { clips, target, player: createSoundPlayer(makeClip, target, alreadyActive) };
  }

  it("plays nothing before the first user gesture", () => {
    const { clips, player } = setup();
    expect(player.play("roll", false)).toBe(false);
    expect(clips).toEqual([]); // not even an Audio object, so no autoplay error
  });

  it("plays after a gesture, unless muted", async () => {
    const { clips, target, player } = setup();
    target.dispatchEvent(new Event("pointerup"));
    expect(clips).toHaveLength(2);
    expect(clips.every((clip) => clip.plays[0]?.muted)).toBe(true); // the silent unlock for iOS
    await Promise.resolve();
    expect(player.play("six", true)).toBe(false);
    expect(player.play("six", false)).toBe(true);
    expect(clips[1]!.plays.at(-1)).toEqual({ muted: false });
  });

  it("plays right away when the page already had a gesture", () => {
    expect(setup(true).player.play("roll", false)).toBe(true);
  });
});

describe("six banner text", () => {
  it("fills both placeholders, every time they occur, in one pass", () => {
    expect(fillTemplate("{name} hat eine 6! Geschenk Nr. {platz}, {name}.", { name: "Anna", platz: 3 })).toBe("Anna hat eine 6! Geschenk Nr. 3, Anna.");
    expect(fillTemplate("{name}: {platz}", { name: "{platz}", platz: 1 })).toBe("{platz}: 1");
    expect(fillTemplate("{other} {NAME}", { name: "x", platz: 1 })).toBe("{other} {NAME}");
  });

  it("renders a name as text, never as HTML", () => {
    const html = renderToStaticMarkup(
      createElement(SixBanner, { template: "{name} bekommt Nr. {platz}", name: '<img src=x onerror="alert(1)">', platz: 2 }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; bekommt Nr. 2");
    expect(html).toMatch(/^<dialog [^>]*role="alertdialog"/);
  });
});

describe("reactions", () => {
  it("cool down for the server's interval", () => {
    expect(cooldownLeft(null, 5000)).toBe(0);
    expect(cooldownLeft(1000, 1500)).toBe(REACTION_INTERVAL_MS - 500);
    expect(cooldownLeft(1000, 1000 + REACTION_INTERVAL_MS)).toBe(0);
  });

  it("turn a large batch into a readable burst", () => {
    const burst = expandBurst([{ emoji: "🎉", count: 50 }, { emoji: "❤️", count: 2 }, { emoji: "👏", count: 40 }, { emoji: "🍀", count: 40 }], 10);
    expect(burst.filter((item) => item.emoji === "🎉")).toHaveLength(4);
    expect(burst.filter((item) => item.emoji === "❤️")).toHaveLength(2);
    expect(burst.filter((item) => item.emoji === "🍀")).toHaveLength(2); // the cap of 12 per burst
    expect(burst.map((item) => item.id)).toEqual(Array.from({ length: 12 }, (_, i) => 10 + i));
    expect(burst.every((item) => item.lane < FLOAT_LANES && item.delay < 4)).toBe(true);
  });
});

describe("avatars", () => {
  it("get initials by code point", () => {
    expect(initials("anna maria schmidt")).toBe("AM");
    expect(initials("  émile ")).toBe("É");
    expect(initials("🎄 Elf")).toBe("🎄E");
    expect(initials("   ")).toBe("?");
  });

  it("get a stable colour from the user id", () => {
    const ids = Array.from({ length: 64 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const tones = ids.map(avatarTone);
    expect(tones).toEqual(ids.map(avatarTone));
    expect(tones.every((tone) => tone >= 0 && tone < AVATAR_TONES)).toBe(true);
    expect(new Set(tones).size).toBe(AVATAR_TONES);
  });
});

describe("timing", () => {
  it("the dice land before the next roll is allowed", () => {
    expect(ROLL_ANIMATION_MS).toBeGreaterThanOrEqual(1200);
    expect(ROLL_ANIMATION_MS).toBeLessThan(ROLL_COOLDOWN_MS);
  });

  it("CSS durations match the constants", () => {
    const css = read("style.css");
    expect(css).toContain(`--roll-duration: ${ROLL_ANIMATION_MS}ms;`);
    expect(css).toContain(`--reaction-interval: ${REACTION_INTERVAL_MS}ms;`);
    expect(css).toContain(`--float-duration: ${FLOAT_MS}ms;`);
  });
});

describe("CSP (default-src 'self', no style-src): nothing inline", () => {
  it("no style attributes or <style> elements, no inline scripts", () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\sstyle=|<style/);
      // Every <script> loads a file.
      for (const tag of text.match(/<script[^>]*>/g) ?? []) expect(tag, file).toMatch(/\ssrc=/);
    }
  });
});

describe("public assets", () => {
  it("sounds are small", () => {
    for (const name of ["roll.wav", "six.wav"]) {
      const file = readFileSync(web(`public/sounds/${name}`));
      expect(file.subarray(0, 4).toString()).toBe("RIFF");
      expect(file.length).toBeLessThan(60_000);
    }
  });

  it("the preview image is a small square PNG, as index.html declares it (spec 10.2)", () => {
    const png = readFileSync(web("public/og.png"));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([256, 256]);
    const html = read("index.html");
    expect(html).toContain('<meta property="og:image:width" content="256" />');
    expect(html).toContain('<meta property="og:image:height" content="256" />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
  });
});

describe("constants.ts", () => {
  it("needs no zod, and contracts.ts re-exports it unchanged", () => {
    expect(readFileSync(new URL("../src/shared/constants.ts", import.meta.url), "utf8")).not.toMatch(/^import(?! type)/m);
    for (const [name, value] of Object.entries(constants)) expect(contracts[name as keyof typeof contracts], name).toBe(value);
  });
});

describe("theme tokens", () => {
  const css = walk(web(".").pathname).filter((file) => file.endsWith(".css"));

  it("avoid light-dark(), which Safari before 17.5 (iOS 16, the Discord in-app browser) drops", () => {
    expect(css.length).toBeGreaterThan(3);
    for (const file of css) expect(readFileSync(file, "utf8"), file).not.toContain("light-dark(");
  });

  it("define dark twice, identically: for the system preference and for the toggle", () => {
    const style = read("style.css");
    const block = (selector: string) => style.slice(style.indexOf(selector)).match(/\{([^}]*)\}/)?.[1]?.replace(/\s+/g, " ").trim();
    const system = block(':root:not([data-theme="light"])');
    expect(system).toMatch(/--bg:/);
    expect(block(':root[data-theme="dark"]')).toBe(system);
  });
});
