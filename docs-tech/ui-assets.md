# UI assets and building blocks

## Generated files

Both scripts are pure Node, deterministic (same output bytes on every run) and the only source of
their files. Change the script, run it, commit script and output together.

| File | Script | Size |
| --- | --- | --- |
| `src/web/public/sounds/roll.wav` | `node scripts/generate-sounds.mjs` | 26 KB |
| `src/web/public/sounds/six.wav` | same | 39 KB |
| `src/web/public/og.png` (1200×630) | `node scripts/generate-og-image.mjs` | 89 KB |

- Sounds: synthesized (rattle: sine knocks plus filtered noise; six: G major chime), mono 16 bit 22.05 kHz
  WAV, quiet on purpose (voice channel). The script refuses a file over 60 KB.
- Preview image: drawn with signed distance functions, 2×2 supersampled, encoded by a minimal PNG
  writer (`node:zlib`). No text: Discord prints `og:title` beside it.
- `src/web/public/` is copied unchanged to `dist/web/`; `favicon.svg` and `theme-init.js` are hand-written.

## Server side of the link preview

`index.html` holds `__BASE_URL__` in `og:image`. `app.ts` reads the built file once and replaces it with
the origin of `BASE_URL`; every path in `SPA_ROUTES` gets that same HTML, and `/index.html` itself is
not served. A new client-side page needs its path in `SPA_ROUTES`. `test/preview.test.ts` checks it.

## CSP rules for the web code

The CSP has no `style-src`, so `default-src 'self'` applies to styles: no `style=` attributes, no
`<style>`, no inline `<script>`. `test/web.test.ts` scans `src/web` for them.

- Variation (avatar colours, emoji lanes) comes from a fixed set of classes (`tone-0…7`, `lane-0…5`).
- Theme before first paint: `theme-init.js` is a classic script in `<head>`. It blocks the parser, so it
  sets `data-theme` before `<body>` renders; from our origin, the CSP allows it. `vite-ignore` keeps
  Vite from bundling it. Colours use `light-dark()`, switched by `color-scheme` per `data-theme`.

## Building blocks

| Import | Use |
| --- | --- |
| `Dice` `{values, rollKey, count?, onSettled?}` | New `rollKey` starts the 1.3 s tumble; `onSettled` when the result shows (six sound, banner) |
| `SixBanner` `{template, name, platz, children?}` | Full screen; `children` = the host's "Weiter" button |
| `ReactionBar` `{onReact, disabled?}` | Client cooldown 2 s, mirrors the server |
| `useFloatingReactions()` → `{items, add}`, `FloatingReactions` `{items, hidden?}` | `add(msg.emojis)`; place in a `.reaction-stage` element |
| `Avatar` `{userId, name, avatarUrl, size?}` | Initials on a colour from the user id when there is no image |
| `ThemeToggle`, `SoundToggle`, `ReactionsToggle`, `Switch` | Per-browser settings |
| `useSound()` → `{play, muted, setMuted}` | `play("roll" \| "six")`, silent until the first gesture |
| `useFlag(HIDE_REACTIONS_KEY)`, `useReducedMotion()` | Shared preference store, motion setting |

Logic sits in `src/web/lib/` (plain functions, tested without a DOM); components only render.
