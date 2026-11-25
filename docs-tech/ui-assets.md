# UI assets and building blocks

## Generated files

Both scripts are pure Node, deterministic and the only source of their files. Change the script, run it,
commit script and output together; CI fails otherwise. The WAV is byte-identical everywhere; the PNG's
pixels are, its compressed bytes depend on the zlib build (zlib-ng locally, Node's own in CI), so CI
compares pixels (`--check`).

| File | Script | Size |
| --- | --- | --- |
| `src/web/public/sounds/six.wav` | `node scripts/generate-sounds.mjs` | 35 KB |
| `src/web/public/og.png` (256×256) | `node scripts/generate-og-image.mjs` | 1 KB |

- Both sounds: mono 16 bit 22.05 kHz WAV, peak −9 dBFS (quiet on purpose: voice channel), under 60 KB,
  roll no longer than `ROLL_ANIMATION_MS` so it ends before the six sound (tests).

| Sound | Made of | Length |
| --- | --- | --- |
| Six | Synthesized: marimba arpeggio G–B–D–G, partials 1× and 3.9× (higher ones would alias), soft mallet attack | 0.8 s |
| Roll | Recorded, not generated (synthesized dice sounded like clinking glass): Kenney "Casino Audio" 1.1, CC0, from `opengameart.org/content/54-casino-sound-effects-cards-dice-chips`. First 0.65 s of `dice-shake-2.ogg` (fade out from 0.5 s), then `dice-throw-1.ogg`; command below | 1.25 s |

```sh
ffmpeg -i dice-shake-2.ogg -i dice-throw-1.ogg -filter_complex "[0]atrim=0:0.65,afade=t=out:st=0.5:d=0.15[s];[s][1]concat=n=2:v=0:a=1,silenceremove=start_periods=1:start_threshold=-50dB,aresample=22050,pan=mono|c0=0.5*c0+0.5*c1,afade=t=out:st=1.14:d=0.05,apad=whole_dur=1.25" -ac 1 -f f32le stage.raw
# then: volume to a −9.1 dBFS peak, -c:a pcm_s16le -bitexact -map_metadata -1 (plain 44-byte header, the test reads it)
```
- Preview image: pixel art like the app, two dice on a plank table under bunting, sky and hills, drawn
  on a 64×64 grid in the colours of `style.css` and scaled ×4 without smoothing; encoded by a minimal PNG
  writer (`node:zlib`). Square and small: `twitter:card` is `summary`, so Discord shows it as a
  thumbnail beside `og:title` (spec 10.2: "kleines Bild"). No text in it.
- `src/web/public/` is copied unchanged to `dist/web/`; `favicon.svg` (a 16×16 pixel die showing six, `shape-rendering="crispEdges"`) and `theme-init.js` are hand-written.
- `src/web/fonts/PixelifySans.ttf` (77 KB, variable 400–700): Pixelify Sans by the Pixelify Sans
  Project Authors, SIL Open Font License 1.1 (`OFL.txt` beside it), unmodified, from
  `github.com/google/fonts/tree/main/ofl/pixelifysans`. `style.css` imports it relatively, so Vite hashes it into `/assets/` (cached for a year).
- `src/web/fonts/Silkscreen-Bold.ttf` (30 KB): Silkscreen by the Silkscreen Project Authors, OFL 1.1
  (`OFL-Silkscreen.txt`), unmodified, from `github.com/google/fonts/tree/main/ofl/silkscreen`; digits only.

## Look

Harvest festival in a small valley town: parchment panels in wooden frames, a plank table for the dice,
pixel bevels on every control. Original work; no assets, names or UI frames from any game. All in
`style.css` as plain custom properties. No orange anywhere, by wish of the event's host: wood is
brown, the call to action evergreen, title and links berry.

| Colour | Used for |
| --- | --- |
| Holly `#3f7d2a` | the one call to action ("Würfeln", "Start", "Weiter"), the active turn token |
| Wheat `#f2c14e` | your turn plaque, first place, the six sunburst with holly |
| Wood `#7b5434` / `#4e2a12` | frames, the plank table, number tokens |
| Parchment `#fbf0d4` | panels (light), signs and dice (both themes) |
| Meadow `#3d7424` / berry `#a8304a` | switches on, connection / danger, notices |
| Sky bands `#cbe7ef` → `#e2efcc` | page background; dark: night `#1b2033` with stars |

| Pattern | How |
| --- | --- |
| Pixel frame | four hard `box-shadow` copies, no blur; the corners stay notched. Buttons swap `--face`, `--hi`, `--lo`, `--frame` |
| Sign (`.ribbon`) | parchment in a plank frame on two ropes; needs an isolated parent (`.ribbon-wrap`, `.hero`) |
| Headings | Pixelify Sans for `h1`–`h3`, `summary`, sign, turn; body stays the system face. Its 5 reads as an S, so digits come from Silkscreen Bold (`"Pixel Digits"`, `unicode-range` 0–9) |
| Motion | ≤ 500 ms except the dice (1.3 s) and confetti; stepped bob on the roll button; all off with reduced motion |

### Desktop shell

From 1100 × 540 px the page is the window (`#root` is `100dvh`). Each room screen is a grid; long lists
(participants, turn order, gift order, history) scroll inside their own panel, never the page. Below that
size the page scrolls as before.

| Screen | Columns |
| --- | --- |
| Lobby | host card · "Du" + settings · participants (non-hosts: two columns) |
| Game | gifts + more host tools · dice, host bar, reactions · turn order, history, participants |
| Result | sign, gift order, buttons · history |

On a phone the game's column wrappers are `display: contents` and CSS `order` restores the reading order;
the DOM order already matches the focus order. Every scroller is `position: relative`, or the `.sr-only`
text inside it would stretch the page.

### Contrast (WCAG AA: text ≥ 4.5, borders and focus ≥ 3)

| Pair | Light | Dark |
| --- | --- | --- |
| `--fg` on `--bg` / `--bg-low` / `--surface` / `--field` | 10.8 / 11.6 / 12.4 / 13.5 | 13.1 / 11.8 / 11.9 / 13.4 |
| `--fg` on `--tint` (buttons) | 10.7 | 9.1 |
| `--muted` on `--bg` / `--surface` | 6.1 / 7.0 | 8.7 / 7.9 |
| `--accent` on `--bg` / `--surface` (links, title) | 6.6 / 7.6 | 7.7 / 7.0 |
| `--on-fill` on `--fill` (theme toggle) | 5.4 | 7.9 |
| `--danger` on `--tint-berry` | 6.1 | 7.1 |
| `--fg` on `--tint-wheat` / `--tint-sky` / `--tint-meadow` (badges) | 10.9 / 11.3 / 11.5 | 8.5 / 9.7 / 9.5 |
| `--edge` on `--field` / `--surface` (input border) | 4.7 / 4.3 | 5.1 / 4.5 |
| `--focus` on `--bg` / `--surface` | 5.1 / 5.8 | 10.2 / 9.2 |

Same in both themes:

| Pair | Ratio |
| --- | --- |
| `--on-holly` on holly (primary button, turn token) | 4.8 |
| `--on-wheat` on wheat | 8.7 |
| Cream on wood / plank / wood-dark (table text, tokens) | 6.1 / 7.0 / 11.5 |
| `--ink` on parchment (signs, six banner) | 12.4 |
| White on berry (notice) / on bronze `#8d6e4f` | 6.6 / 4.7 |
| `--ink` on silver `#c9c2b4` | 7.9 |

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
| `HowTo` `{settings, open?}` | "So wird gewürfelt": the rules in four lines, worded after the room settings; everyone sees it (lobby: open for non-hosts; game: folded) |
| `Confetti` | 12 square CSS pieces, `position: fixed`, three falls; hidden with reduced motion |
| `SixBanner` `{template, name, platz, children?}` | Native modal `<dialog>`: the browser keeps the page behind inert; Escape does nothing; `children` = the host's "Weiter" button |
| `ReactionBar` `{onReact, disabled?}` | Client cooldown 2 s, mirrors the server |
| `useFloatingReactions()` → `{items, add}`, `FloatingReactions` `{items, hidden?}` | `add(msg.emojis)`; place in a `.reaction-stage` element |
| `Avatar` `{userId, name, avatarUrl, size?}` | Initials on a colour from the user id when there is no image |
| `ThemeToggle`, `SoundToggles` (Würfel-Ton, Gewinner-Ton), `ReactionsToggle`, `Switch` | Per-browser settings |
| `useSound()` → `{play, rollOff, setRollOff, sixOff, setSixOff}` | `play("roll" \| "six")`, silent until the first gesture; each sound muted on its own (`SOUND_OFF_KEYS`), the old `dice.muted` carried over once |
| `useFlag(HIDE_REACTIONS_KEY)`, `useReducedMotion()` | Shared preference store, motion setting |

Logic sits in `src/web/lib/` (plain functions, tested without a DOM); components only render.

## Views

No router: `main.tsx` picks the page from the path (`lib/routes.ts`); every page is a full load.

| Path | View | Connects to |
| --- | --- | --- |
| `/` | `views/Start.tsx`: login, logged-in user, "Raum erstellen" for hosts | `GET /api/me`, `POST /api/rooms` |
| `/r/:slug` | `views/RoomPage.tsx` → `Lobby`, `Game`, `Result` by game status; a guest (public room, no session) gets the same screens without anything that sends | `GET /api/rooms/:slug` first (401 login, 404 not found), then `/ws/rooms/:slug` |

| Module | Holds |
| --- | --- |
| `lib/connection.ts` | One socket per tab: backoff 0.5 s doubling to 30 s with jitter, reset by the first `state`; 1012/1013 once within 1 s (jittered); visible tab or network back: retry now; 1008, 4xxx stop, 4001 login; a refused upgrade (1006 before open) is asked over HTTP. Error page after 3 failures without a state, kept while the next attempt runs |
| `lib/roll.ts` | The server sends the `state` with a new roll before `rolled`: the new seq holds back six banner and result until the dice land (or 1.5 s without `rolled`); roll buttons wait `ROLL_COOLDOWN_MS` (tumble + 5 s countdown, `countdown()`); heading, turn order and host bar keep naming the roller until the dice land (`shownTurn`); a reset or reconnect clears it |
| `lib/room.ts` | Permissions per button, lists, history texts, result text, the `visibleText` checks of `constants.ts` |
| `lib/useRoom.ts` | React glue: view, status, roll state, reactions, server errors |

A six that ends the game has no pause, so its banner closes per viewer ("Zum Ergebnis"). Destructive
host tools ask in the page (`ConfirmButton`), never `window.confirm`.
