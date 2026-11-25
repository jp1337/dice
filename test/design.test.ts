// DESIGN.md is the design concept; these tests hold the stylesheets to it. Token by token both
// ways, contrast from the component pairs, the host's wishes (no orange, no gold button, no pink
// titles, hover on the whole face) and the format of the file itself.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const DESIGN = read("DESIGN.md");
const STYLE = read("src/web/style.css");
const COMPONENT_CSS = readdirSync(new URL("../src/web/components/", import.meta.url))
  .filter((f) => f.endsWith(".css"))
  .map((f) => `src/web/components/${f}`);
const SHEETS = ["src/web/style.css", "src/web/views/views.css", ...COMPONENT_CSS];

// --- DESIGN.md front matter: the subset of YAML this file uses (two-space blocks, quoted colours).
const [, FRONT = "", BODY = ""] = DESIGN.split(/^---$/m);
function block(name: string) {
  const start = FRONT.indexOf(`\n${name}:\n`);
  if (start < 0) return "";
  const rest = FRONT.slice(start + name.length + 3);
  const end = rest.search(/^\S/m);
  return end < 0 ? rest : rest.slice(0, end);
}
const COLORS = new Map([...block("colors").matchAll(/^ {2}([a-z0-9-]+): "(#[0-9a-f]{6}(?:[0-9a-f]{2})?)"/gm)].map((m) => [m[1]!, m[2]!]));
const COMPONENTS = new Map<string, Record<string, string>>();
{
  let current: Record<string, string> | null = null;
  for (const line of block("components").split("\n")) {
    const head = line.match(/^ {2}([a-z0-9-]+):\s*$/);
    const prop = line.match(/^ {4}([A-Za-z]+): "?([^"]+)"?$/);
    if (head) COMPONENTS.set(head[1]!, (current = {}));
    else if (prop && current) current[prop[1]!] = prop[2]!;
  }
}
const ref = (value: string) => {
  const name = value.match(/^\{colors\.([a-z0-9-]+)\}$/)?.[1];
  const hex = name && COLORS.get(name);
  if (!hex) throw new Error(`unknown colour reference ${value}`);
  return hex;
};

// --- style.css custom properties: light :root and the dark block (the two dark blocks are equal, web.test.ts).
function cssBlock(selector: string) {
  const start = STYLE.indexOf(`${selector} {`);
  return STYLE.slice(start, STYLE.indexOf("\n}\n", start));
}
const hexVars = (css: string) => new Map([...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6,8});/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
const LIGHT = hexVars(cssBlock(":root"));
const DARK = hexVars(cssBlock(':root[data-theme="dark"]'));

// --- Colour maths: WCAG contrast and oklch (hue, chroma) from sRGB hex.
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const [r, g, bl] = channels(hex).map(linear) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
function oklch(hex: string) {
  const [r, g, b] = channels(hex).map(linear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { chroma: Math.hypot(A, B), hue: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}
// Orange and orange-brown: oklch hue 20–80 with visible chroma (DESIGN.md "Do's and Don'ts").
const orange = (hex: string) => {
  const { chroma, hue } = oklch(hex.slice(0, 7));
  return chroma >= 0.06 && hue >= 20 && hue <= 80;
};

describe("DESIGN.md", () => {
  it("has the sections of the DESIGN.md format, in its order, each once", () => {
    const order = ["Overview", "Colors", "Typography", "Layout", "Elevation & Depth", "Shapes", "Components", "Do's and Don'ts"];
    const headings = [...BODY.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(order);
    expect(FRONT).toMatch(/^name: .+$/m);
  });

  it("names every colour token in its prose", () => {
    const missing = [...COLORS.keys()].filter((name) => !BODY.includes(`{colors.${name}}`));
    expect(missing).toEqual([]);
  });

  it("every component pair reaches 4.5:1", () => {
    expect(COMPONENTS.size).toBeGreaterThan(20);
    const low = [...COMPONENTS]
      .filter(([, p]) => p.backgroundColor && p.textColor)
      .map(([name, p]) => [name, contrast(ref(p.backgroundColor!), ref(p.textColor!))] as const)
      .filter(([, ratio]) => ratio < 4.5);
    expect(low).toEqual([]);
  });

  it("has a night variant for every component whose colours change at night", () => {
    for (const [name, p] of COMPONENTS) {
      if (name.endsWith("-night")) continue;
      const themed = [p.backgroundColor, p.textColor].some((v) => v && COLORS.has(`night-${v.slice(8, -1)}`));
      if (themed) expect(COMPONENTS.has(`${name}-night`), name).toBe(true);
    }
  });
});

describe("style.css follows DESIGN.md", () => {
  it("every light colour token is the custom property, and back", () => {
    const tokens = [...COLORS].filter(([name]) => !name.startsWith("night-"));
    expect(tokens.filter(([name, hex]) => LIGHT.get(name) !== hex)).toEqual([]);
    expect([...LIGHT.keys()].filter((name) => !COLORS.has(name))).toEqual([]);
  });

  it("every night token is the dark custom property, and back", () => {
    const tokens = [...COLORS].filter(([name]) => name.startsWith("night-")).map(([name, hex]) => [name.slice(6), hex] as const);
    expect(tokens.filter(([name, hex]) => DARK.get(name) !== hex)).toEqual([]);
    expect([...DARK.keys()].filter((name) => !COLORS.has(`night-${name}`))).toEqual([]);
  });

  it("takes every colour from a token: no hex value outside the token blocks", () => {
    for (const path of SHEETS) {
      let css = read(path);
      if (path.endsWith("style.css")) for (const sel of [":root", ':root:not([data-theme="light"])', ':root[data-theme="dark"]']) css = css.replace(cssBlock(sel), "");
      css = css.replace(/url\("data:[^"]*"\)/g, "url()"); // pixel tiles carry their own colours
      // Values of declarations only, so an id selector is not a colour. The bevels' translucent
      // white and black are the one exception: they shade any face.
      const values = [...css.matchAll(/:([^;{}]*);/g)].map((m) => m[1]!);
      const stray = values.flatMap((v) => v.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).filter((hex) => !["#ffffff80", "#ffffff40", "#00000040"].includes(hex.toLowerCase()));
      expect(stray, path).toEqual([]);
    }
  });

  it("has no orange: no token and no literal colour in any sheet", () => {
    expect([...COLORS].filter(([, hex]) => orange(hex))).toEqual([]);
    for (const path of SHEETS) {
      const literals = [...read(path).matchAll(/(?:%23|#)([0-9a-fA-F]{6})\b/g)].map((m) => `#${m[1]}`);
      const rgbs = [...read(path).matchAll(/rgb\((\d+) (\d+) (\d+)/g)].map((m) => `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`);
      expect([...literals, ...rgbs].filter(orange), path).toEqual([]);
    }
  });

  it("loads exactly the fonts DESIGN.md names", () => {
    const named = new Set([...block("typography").matchAll(/fontFamily: (.+)$/gm)].map((m) => m[1]!.trim()));
    const faces = [...STYLE.matchAll(/@font-face \{[^}]*src: url\("\.\/fonts\/([^"]+)"/g)].map((m) => m[1]);
    expect(faces).toEqual(["PixelifySans.ttf", "Jersey10-Regular.ttf"]);
    expect(named).toEqual(new Set(["Pixelify Sans", "Jersey 10", "ui-rounded"]));
  });

  it("keeps the host's wishes: blue button, no gold behind the active player, titles not berry, hover on the whole face", () => {
    const views = read("src/web/views/views.css");
    const rule = (css: string, selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
    expect(rule(STYLE, ".primary")).toContain("--face: var(--primary)");
    expect(rule(STYLE, ".primary:hover:not(:disabled)")).toContain("--face: var(--primary-hover)");
    expect(rule(STYLE, "button:hover:not(:disabled)")).toMatch(/--face: var\(--tint-hover\)/);
    expect(rule(STYLE, "button:hover:not(:disabled)")).not.toContain("--hi");
    expect(rule(views, ".turns .is-active")).toContain("var(--turn-active)");
    expect(rule(views, ".turns .is-active")).not.toContain("wheat");
    expect(rule(views, ".turn.is-me")).toContain("var(--primary)");
    expect(rule(views, "h1")).toContain("var(--title)");
    expect(views).toMatch(/summary::after \{[^}]*var\(--accent\)/);
    expect(oklch(COLORS.get("title")!).hue).toBeGreaterThan(200); // blue, not pink or berry
    expect(oklch(COLORS.get("night-title")!).hue).toBeGreaterThan(200);
  });

  it("keeps the light theme from glaring: no white page or panel", () => {
    for (const name of ["bg", "bg-mid", "bg-low", "surface", "surface-2"]) {
      const [r, g, b] = channels(COLORS.get(name)!);
      expect(Math.min(r!, g!, b!), name).toBeLessThan(0.95);
    }
  });
});
