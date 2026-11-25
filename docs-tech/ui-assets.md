# UI assets and building blocks

## Generated files

Both scripts are pure Node, deterministic and the only source of their files. Change the script, run it,
commit script and output together; CI fails otherwise. The WAVs are byte-identical everywhere; the PNG's
pixels are, its compressed bytes depend on the zlib build (zlib-ng locally, Node's own in CI), so CI
compares pixels (`--check`).

| File | Script | Size |
| --- | --- | --- |
| `src/web/public/sounds/roll.wav` | `node scripts/generate-sounds.mjs` | 26 KB |
| `src/web/public/sounds/six.wav` | same | 39 KB |
| `src/web/public/og.png` (256×256) | `node scripts/generate-og-image.mjs` | 23 KB |

- Sounds: synthesized (rattle: sine knocks plus filtered noise; six: G major chime), mono 16 bit 22.05 kHz
  WAV, quiet on purpose (voice channel). The script refuses a file over 60 KB.
- Preview image: drawn with signed distance functions, 4×4 supersampled, encoded by a minimal PNG
  writer (`node:zlib`). Square and small: `twitter:card` is `summary`, so Discord shows it as a
  thumbnail beside `og:title` (spec 10.2: "kleines Bild"). No text in it.
- `src/web/public/` is copied unchanged to `dist/web/`; `favicon.svg` and `theme-init.js` are hand-written.

## Look

Tokens after the "Flip7 Card Game" design system (yiujc, DESIGNmd, MIT; its logo, name and artwork are
not used). All in `style.css` as plain custom properties.

| Colour | Used for |
| --- | --- |
| Teal `#2ba8a2` | every control, card accent bar, the felt the dice lie on (`#17766f` → `#0f5e59`) |
| Gold `#ffd23f` | the one call to action ("Würfeln", "Start", "Weiter"), whose turn, first place |
| Coral `#ef6c4a` | the six banner, danger, third place |
| Cream `#fff8e7` | dice, inputs, ribbons |

Patterns: pill buttons (≥ 44 px), gold gradient with gloss for `.primary`, coloured glow instead of
black shadows, 6 px left accent bar on cards, dashed dividers, emoji section titles, folded `.ribbon`
(needs an isolated parent: `.ribbon-wrap`), bunting on `body::before`, `Confetti` on the six and the result.
Motion ≤ 500 ms except the dice (1.3 s) and confetti; all of it off with reduced motion.

### Contrast (WCAG AA: text ≥ 4.5, borders and focus ≥ 3)

| Pair | Light | Dark |
| --- | --- | --- |
| `--fg` on `--bg` / `--surface` / `--field` | 11.4 / 12.4 / 11.7 | 14.3 / 11.8 / 10.6 |
| `--muted` on `--bg` / `--surface` | 5.8 / 6.2 | 8.3 / 6.9 |
| `--accent` on `--bg` (links, h1) | 6.7 | 7.4 |
| Button text `--accent` on `--tint` | 6.5 | 5.5 |
| `--on-fill` on `--fill` (theme toggle) | 6.4 | 7.4 |
| `--danger` on `--tint-coral` | 4.7 | 5.7 |
| `--fg` on `--tint-gold` / `--tint-sky` (badges) | 11.1 / 10.7 | 10.4 / 11.2 |
| `--edge` on `--surface` / `--field` (input border) | 3.6 / 3.4 | 4.3 / 3.8 |
| `--focus` on `--bg` | 4.9 | 9.0 |

Same in both themes:

| Pair | Ratio |
| --- | --- |
| `--on-gold` on gold / gold-dark / gold-light | 9.6 / 7.4 / 11.0 |
| White on felt (lightest `#17766f`) / cream on felt | 5.4 / 5.1 |
| `--ink` on cream (ribbon, six banner text) | 11.7 |
| White on notice `#b53a1e` / on bronze `#c2462a` | 5.9 / 5.0 |
| `--ink` on silver `#b5c1c4` | 6.7 |

The ratios come from the WCAG relative-luminance formula; recompute them when a token changes.

## Server side of the link preview

`index.html` holds `__BASE_URL__` in `og:image`. `app.ts` reads the built file once and replaces it with
the origin of `BASE_URL`; every path in `SPA_ROUTES` gets that same HTML, and `/index.html` itself is
not served. Room paths only match the slug alphabet (base64url, 16 to 64), anything else under `/r/` is a 404.
A new client-side page needs its path in `SPA_ROUTES`. `test/preview.test.ts` checks it. `BASE_URL` is
validated as a plain origin (`config.ts`) and HTML-escaped on top.

## CSP rules for the web code

The CSP has no `style-src`, so `default-src 'self'` applies to styles: no `style=` attributes, no
`<style>`, no inline `<script>`. `test/web.test.ts` scans `src/web` for them.

- Variation (avatar colours, emoji lanes, confetti) comes from a fixed set of classes or `nth-child` rules (`tone-0…7`, `lane-0…5`, `Confetti.css`).
- Theme before first paint: `theme-init.js` is a classic script in `<head>`. It blocks the parser, so it
  sets `data-theme` before `<body>` renders; from our origin, the CSP allows it. `vite-ignore` keeps
  Vite from bundling it. Dark colours stand twice in `style.css` (system preference, toggle), not as
  `light-dark()`, which iOS before 17.5 drops; a test keeps both blocks equal.

## No zod in the browser

The `no-zod-in-browser` plugin in `vite.config.ts` fails the client build when any import reaches zod,
directly or through `contracts.ts`. Values for the browser live in `src/shared/constants.ts`; from
`contracts.ts` the web code takes types only, with `import type`. `test/bundle.test.ts` builds both cases.

## Building blocks

| Import | Use |
| --- | --- |
| `Dice` `{values, rollKey, count?, onSettled?}` | New `rollKey` starts the 1.3 s tumble; `onSettled` when the result shows (six sound, banner) |
| `Confetti` | 12 CSS pieces, `position: fixed`, three falls; hidden with reduced motion |
| `SixBanner` `{template, name, platz, children?}` | Native modal `<dialog>`: the browser keeps the page behind inert; Escape does nothing; `children` = the host's "Weiter" button |
| `ReactionBar` `{onReact, disabled?}` | Client cooldown 2 s, mirrors the server |
| `useFloatingReactions()` → `{items, add}`, `FloatingReactions` `{items, hidden?}` | `add(msg.emojis)`; place in a `.reaction-stage` element |
| `Avatar` `{userId, name, avatarUrl, size?}` | Initials on a colour from the user id when there is no image |
| `ThemeToggle`, `SoundToggle`, `ReactionsToggle`, `Switch` | Per-browser settings |
| `useSound()` → `{play, muted, setMuted}` | `play("roll" \| "six")`, silent until the first gesture |
| `useFlag(HIDE_REACTIONS_KEY)`, `useReducedMotion()` | Shared preference store, motion setting |

Logic sits in `src/web/lib/` (plain functions, tested without a DOM); components only render.

## Views

No router: `main.tsx` picks the page from the path (`lib/routes.ts`); every page is a full load.

| Path | View | Connects to |
| --- | --- | --- |
| `/` | `views/Start.tsx`: login, logged-in user, "Raum erstellen" for hosts | `GET /api/me`, `POST /api/rooms` |
| `/r/:slug` | `views/RoomPage.tsx` → `Lobby`, `Game`, `Result` by game status | `GET /api/rooms/:slug` first (401 login, 404 not found), then `/ws/rooms/:slug` |
| `/z/:token` | same screens, `viewer.kind === "guest"`: nothing that sends | `/ws/watch/:token`; `HEAD /z/:token` 404 = link off |

| Module | Holds |
| --- | --- |
| `lib/connection.ts` | One socket per tab: backoff 0.5 s doubling to 30 s with jitter, reset by the first `state`; 1012/1013 once within 1 s (jittered); visible tab or network back: retry now; 1008, 4xxx stop, 4001 login; a refused upgrade (1006 before open) is asked over HTTP. Error page after 3 failures without a state, kept while the next attempt runs |
| `lib/roll.ts` | The server sends the `state` with a new roll before `rolled`: the new seq holds back six banner and result until the dice land (or 1.5 s without `rolled`); roll buttons wait `ROLL_COOLDOWN_MS`; a reset or reconnect clears it |
| `lib/room.ts` | Permissions per button, lists, history texts, result text, the `visibleText` checks of `constants.ts` |
| `lib/useRoom.ts` | React glue: view, status, roll state, reactions, server errors |

A six that ends the game has no pause, so its banner closes per viewer ("Zum Ergebnis"). Destructive
host tools ask in the page (`ConfirmButton`), never `window.confirm`.
