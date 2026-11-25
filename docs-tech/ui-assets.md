# UI assets and building blocks

## Generated files

Both scripts are pure Node, deterministic and the only source of their files. Change the script, run it,
commit script and output together; CI fails otherwise. The WAV is byte-identical everywhere; the PNG's
pixels are, its compressed bytes depend on the zlib build (zlib-ng locally, Node's own in CI), so CI
compares pixels (`--check`).

| File | Script | Size |
| --- | --- | --- |
| `src/web/public/sounds/six.wav` | `node scripts/generate-sounds.mjs` | 35 KB |
| `src/web/public/sounds/turn.wav` | same | 31 KB |
| `src/web/public/og.png` (256×256) | `node scripts/generate-og-image.mjs` | 1 KB |

- Both sounds: mono 16 bit 22.05 kHz WAV, peak −9 dBFS (quiet on purpose: voice channel), under 60 KB,
  roll no longer than `ROLL_ANIMATION_MS` so it ends before the six sound (tests).

| Sound | Made of | Length |
| --- | --- | --- |
| Six | Synthesized: marimba arpeggio G–B–D–G, partials 1× and 3.9× (higher ones would alias), soft mallet attack | 0.8 s |
| Turn | Synthesized: two glockenspiel strikes A5, E6 (partials 1×, 2.76×, 5.4×), played to whoever is up once the dice have landed and the game is not paused | 0.7 s |
| Roll | Recorded, not generated (synthesized dice sounded like clinking glass): Kenney "Casino Audio" 1.1, CC0, from `opengameart.org/content/54-casino-sound-effects-cards-dice-chips`. First 0.65 s of `dice-shake-2.ogg` (fade out from 0.5 s), then `dice-throw-1.ogg`; command below | 1.25 s |

```sh
ffmpeg -i dice-shake-2.ogg -i dice-throw-1.ogg -filter_complex "[0]atrim=0:0.65,afade=t=out:st=0.5:d=0.15[s];[s][1]concat=n=2:v=0:a=1,silenceremove=start_periods=1:start_threshold=-50dB,aresample=22050,pan=mono|c0=0.5*c0+0.5*c1,afade=t=out:st=1.14:d=0.05,apad=whole_dur=1.25" -ac 1 -f f32le stage.raw
# then: volume to a −9.1 dBFS peak, -c:a pcm_s16le -bitexact -map_metadata -1 (plain 44-byte header, the test reads it)
```
- Preview image: pixel art like the app, two dice on a walnut table under icicles, snowy pines and sky, drawn
  on a 64×64 grid in the colours of `style.css` and scaled ×4 without smoothing; encoded by a minimal PNG
  writer (`node:zlib`). Square and small: `twitter:card` is `summary`, so Discord shows it as a
  thumbnail beside `og:title` (spec 10.2: "kleines Bild"). No text in it.
- `src/web/public/` is copied unchanged to `dist/web/`; `favicon.svg` (a 16×16 pixel die showing six in ink, snow and berry, `shape-rendering="crispEdges"`) and `theme-init.js` are hand-written.
- `src/web/fonts/Jersey10-Regular.ttf` (78 KB): Jersey 10 by the Soft Type Project Authors, OFL 1.1
  (`OFL-Jersey10.txt`), unmodified, from `github.com/google/fonts/tree/main/ofl/jersey10`; the one
  pixel face (`"Pixel"`, `size-adjust: 130%`). Pixelify Sans (Z like B, 5 like S) and Silkscreen
  (4 a blob) were tried first. `style.css` imports it relatively, so Vite hashes it into `/assets/`.

## Look

The design concept, every colour token with its role, the type scale, the components and the
rules live in [`DESIGN.md`](../DESIGN.md) (the DESIGN.md format). `test/design.test.ts` holds
`style.css` to it: every token both ways and both themes, contrast of every component pair,
no orange, no raw hex value outside the token blocks, the fonts, and the host's wishes. Change a
colour in both files at once; the test says which one is behind.

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
| `ReactionBar` `{onReact, disabled?}` | Client cooldown 0.5 s, mirrors the server; emojis rise left and right of the dice, never across them |
| `useFloatingReactions()` → `{items, add}`, `FloatingReactions` `{items, hidden?}` | `add(msg.emojis)`; place in a `.reaction-stage` element |
| `Avatar` `{userId, name, avatarUrl, size?}` | Initials on a colour from the user id when there is no image |
| `ThemeToggle`, `SoundToggles` ("Ton:" Würfel, Gewinner, Dran; group "Töne"), `Switch` | Per-browser settings; reactions have no personal switch, hosts switch them for the room |
| `useSound()` → `{play, rollOff, setRollOff, sixOff, setSixOff, turnOff, setTurnOff}` | `play("roll" \| "six" \| "turn")`, silent until the first gesture; each sound muted on its own (`SOUND_OFF_KEYS`), the old `dice.muted` carried over once |
| `useFlag(key)`, `useReducedMotion()` | Shared preference store, motion setting |

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
