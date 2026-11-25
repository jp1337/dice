---
version: alpha
name: Würfel — Winterabend
description: >-
  A small snowed-in village on the evening of the year-end gathering. Pixel art in
  the spirit of a cosy farming game's winter, all our own: icicles along the top,
  pines on the horizon, a snowfield with flecks, snow falling behind everything.
  Panels are snow paper in evergreen frames, the dice roll on a warm walnut cabin
  table. Blue is the season (sky, ice, shadows, the one button to press), evergreen
  and walnut keep it warm, berry is the six. No orange anywhere: a wish of the host.
  Light is an overcast winter afternoon, never glaring white; dark is a moonlit night.
# Colour tokens = the custom properties in src/web/style.css: `name` is --name in :root,
# `night-name` is --name in the dark theme (both dark blocks). test/design.test.ts holds the match.
colors:
  # Light theme: an overcast afternoon. Nothing brighter than the paper; white only on the dice.
  bg: "#9dbcd8"
  bg-mid: "#bdd2e6"
  bg-low: "#dbe5ef"
  snow-shade: "#c9d7e5"
  fleck: "#b3c3d6"
  star: "#ffffffe6"
  moon: "#ffffffbf"
  surface: "#edf2f7"
  surface-2: "#e1e9f1"
  paper-edge: "#bccbdc"
  field: "#f6f8fb"
  fg: "#1a2a40"
  muted: "#3f5274"
  line: "#bccbdc"
  edge: "#5a7498"
  accent: "#1f5c9e"
  title: "#17406f"
  primary: "#1f5c9e"
  primary-hover: "#174a82"
  on-primary: "#ffffff"
  turn-active: "#d0e3f5"
  turn-active-edge: "#1f5c9e"
  fill: "#2a68b0"
  on-fill: "#ffffff"
  track-off: "#c3cddb"
  tint: "#dde7f1"
  tint-hover: "#cdd9e7"
  tint-wheat: "#f6e6a8"
  tint-berry: "#f3d6dd"
  tint-sky: "#cfe2f4"
  tint-meadow: "#d0e8dc"
  frame: "#1b2a40"
  focus: "#a3233f"
  danger: "#9a1f36"
  shadow: "#28467838"
  # Materials: the same in both themes (wood, dice, signs, the six).
  outline: "#1b2a40"
  holly: "#2a6a52"
  holly-light: "#4b9273"
  holly-dark: "#173f35"
  on-holly: "#ffffff"
  wood: "#6a4a40"
  wood-dark: "#3a2722"
  wood-light: "#8a6a5e"
  plank: "#5e4238"
  wheat: "#f3d35c"
  wheat-light: "#fae7a0"
  wheat-dark: "#b99a2c"
  on-wheat: "#2e2508"
  meadow: "#4b9273"
  berry: "#a8304a"
  berry-light: "#e0607a"
  on-berry: "#ffffff"
  silver: "#c9d2de"
  sky: "#8fc3ea"
  cream: "#fbf6ec"
  parchment: "#fbf8f0"
  ink: "#1b2a40"
  die-face: "#fbfdff"
  die-edge: "#1b2a40"
  pip: "#1b2a40"
  pip-six: "#a8304a"
  # Dark theme: a moonlit night. A token not listed here keeps its light value.
  night-bg: "#0a1430"
  night-bg-mid: "#13244f"
  night-bg-low: "#172440"
  night-snow-shade: "#22345a"
  night-fleck: "#31476e"
  night-star: "#ffffffcc"
  night-moon: "#eef3fb"
  night-surface: "#16213a"
  night-surface-2: "#1c2945"
  night-paper-edge: "#30466b"
  night-field: "#0e1729"
  night-fg: "#eaf1fb"
  night-muted: "#afbed7"
  night-line: "#2f4468"
  night-edge: "#8aa3c8"
  night-accent: "#9ccaf2"
  night-title: "#d6e6f8"
  night-primary: "#9ccaf2"
  night-primary-hover: "#bcdcf7"
  night-on-primary: "#0a1430"
  night-turn-active: "#1d3858"
  night-turn-active-edge: "#9ccaf2"
  night-tint-hover: "#2b3d5f"
  night-fill: "#9ccaf2"
  night-on-fill: "#0a1430"
  night-track-off: "#3a4866"
  night-tint: "#22324f"
  night-tint-wheat: "#3a3522"
  night-tint-berry: "#4b1e30"
  night-tint-sky: "#1a3958"
  night-tint-meadow: "#163a31"
  night-frame: "#a9bddc"
  night-focus: "#f4f8ff"
  night-danger: "#ffa3b4"
  night-shadow: "#00000073"
typography:
  title:
    fontFamily: Pixelify Sans
    fontSize: 2.6rem
    fontWeight: 700
    lineHeight: 1.1
  turn:
    fontFamily: Pixelify Sans
    fontSize: 2rem
    fontWeight: 700
    lineHeight: 1.15
  heading:
    fontFamily: Pixelify Sans
    fontSize: 1.2rem
    fontWeight: 600
    lineHeight: 1.25
  digits:
    fontFamily: Jersey 10
    fontSize: 1em
    fontWeight: 400
  body:
    fontFamily: ui-rounded
    fontSize: 1rem
    fontWeight: 500
    lineHeight: 1.5
rounded:
  none: 0px
spacing:
  unit: 4px
  gap: 12px
  panel: 18px
components:
  page-title:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.title}"
  page-title-night:
    backgroundColor: "{colors.night-bg}"
    textColor: "{colors.night-title}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
  panel-night:
    backgroundColor: "{colors.night-surface}"
    textColor: "{colors.night-fg}"
  panel-muted:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
  panel-muted-night:
    backgroundColor: "{colors.night-surface}"
    textColor: "{colors.night-muted}"
  link:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.accent}"
  link-night:
    backgroundColor: "{colors.night-surface}"
    textColor: "{colors.night-accent}"
  button:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.fg}"
    rounded: "{rounded.none}"
    height: 44px
  button-hover:
    backgroundColor: "{colors.tint-hover}"
    textColor: "{colors.fg}"
  button-night:
    backgroundColor: "{colors.night-tint}"
    textColor: "{colors.night-fg}"
  button-hover-night:
    backgroundColor: "{colors.night-tint-hover}"
    textColor: "{colors.night-fg}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.none}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-primary-night:
    backgroundColor: "{colors.night-primary}"
    textColor: "{colors.night-on-primary}"
  button-primary-hover-night:
    backgroundColor: "{colors.night-primary-hover}"
    textColor: "{colors.night-on-primary}"
  button-danger:
    backgroundColor: "{colors.tint-berry}"
    textColor: "{colors.danger}"
  button-danger-night:
    backgroundColor: "{colors.night-tint-berry}"
    textColor: "{colors.night-danger}"
  turn-active:
    backgroundColor: "{colors.turn-active}"
    textColor: "{colors.fg}"
  turn-active-night:
    backgroundColor: "{colors.night-turn-active}"
    textColor: "{colors.night-fg}"
  number-token:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.on-fill}"
  number-token-night:
    backgroundColor: "{colors.night-fill}"
    textColor: "{colors.night-on-fill}"
  switch-on:
    backgroundColor: "{colors.holly}"
    textColor: "{colors.on-holly}"
  dice-table:
    backgroundColor: "{colors.wood}"
    textColor: "{colors.cream}"
  dice-table-plank:
    backgroundColor: "{colors.plank}"
    textColor: "{colors.cream}"
  sign:
    backgroundColor: "{colors.parchment}"
    textColor: "{colors.ink}"
  notice:
    backgroundColor: "{colors.berry}"
    textColor: "{colors.on-berry}"
  first-place:
    backgroundColor: "{colors.wheat}"
    textColor: "{colors.on-wheat}"
  second-place:
    backgroundColor: "{colors.silver}"
    textColor: "{colors.ink}"
  badge-gold:
    backgroundColor: "{colors.tint-wheat}"
    textColor: "{colors.fg}"
  badge-gold-night:
    backgroundColor: "{colors.night-tint-wheat}"
    textColor: "{colors.night-fg}"
---

# Würfel — DESIGN.md

## Overview

**Winterabend im Tal.** One evening, one room, forty people in a voice channel, a few
dice. The page is a small snowed-in village: icicles hang from the top edge, pines
stand on the horizon, snow falls behind everything. The panels are snow paper in
evergreen frames; the dice roll on a warm walnut cabin table in the middle. The look
borrows the *feeling* of a cosy pixel farming game in winter — none of its art,
names, fonts or UI frames.

Three rules carry the whole system:

1. **Blue is the season, not the whole palette.** Sky, ice, shadows and the one button
   to press are blue; evergreen frames, walnut wood, wheat gold and berry keep it warm.
   A screen that is only blue is wrong.
2. **Nothing glares.** The light theme is an overcast afternoon: the brightest thing on
   screen is a die face. Panels are `{colors.surface}`, never pure white.
3. **No orange, anywhere.** Wood is low-chroma walnut, gold leans yellow. The test checks
   every colour by its oklch hue.

Both themes are first-class: light follows an overcast afternoon, dark a moonlit night.
The system preference decides unless the footer switch fixed one.

## Colors

### Ground: sky, snowfield, night

The page background is three hard bands like a pixel-art backdrop: sky `{colors.bg}`,
`{colors.bg-mid}` towards the horizon, the snowfield `{colors.bg-low}` below it with
`{colors.fleck}` specks and a `{colors.snow-shade}` line where the snow meets the sky.
`{colors.star}` are glints and falling flakes, `{colors.moon}` a pale sun. At night:
`{colors.night-bg}`, `{colors.night-bg-mid}`, `{colors.night-bg-low}`,
`{colors.night-snow-shade}`, `{colors.night-fleck}`, `{colors.night-star}` and a real
moon `{colors.night-moon}`.

### Paper and text

Panels are `{colors.surface}` with every other row `{colors.surface-2}`, a thin
`{colors.paper-edge}` inside the frame; inputs sit on `{colors.field}`. Text is
`{colors.fg}`, secondary text `{colors.muted}`, decorative rules `{colors.line}`,
borders that must be seen `{colors.edge}`. At night: `{colors.night-surface}`,
`{colors.night-surface-2}`, `{colors.night-paper-edge}`, `{colors.night-field}`,
`{colors.night-fg}`, `{colors.night-muted}`, `{colors.night-line}`,
`{colors.night-edge}`.

### Blue: what to read and what to press

- `{colors.title}` / `{colors.night-title}`: the room name and page titles. Deep ice
  by day, snow at night — never pink, never berry.
- `{colors.accent}` / `{colors.night-accent}`: links and the pixel disclosure arrows.
- `{colors.primary}` / `{colors.night-primary}` with `{colors.on-primary}` /
  `{colors.night-on-primary}`: the one thing to press ("Würfeln", "Start", "Weiter")
  and the "Du bist dran!" plaque — your turn and your button share one colour. Hover
  is `{colors.primary-hover}` / `{colors.night-primary-hover}`.
- `{colors.turn-active}` with a `{colors.turn-active-edge}` bar: the active row in the
  turn order; at night `{colors.night-turn-active}` and `{colors.night-turn-active-edge}`.
  Not gold: gold on night blue turns olive.
- `{colors.fill}` / `{colors.night-fill}` with `{colors.on-fill}` /
  `{colors.night-on-fill}`: number tokens in lists and the chosen theme.

### Controls

Buttons are `{colors.tint}` with `{colors.frame}` outlines; under the pointer the whole
face turns `{colors.tint-hover}`. At night `{colors.night-tint}`,
`{colors.night-tint-hover}`, `{colors.night-frame}`. A switch that is off has a
`{colors.track-off}` / `{colors.night-track-off}` track; on, it is `{colors.holly}`.
Focus rings are `{colors.focus}` (berry against all that blue) and
`{colors.night-focus}` at night. Danger is `{colors.danger}` on `{colors.tint-berry}`,
at night `{colors.night-danger}` on `{colors.night-tint-berry}`. Shadows fall blue on
snow: `{colors.shadow}`, at night `{colors.night-shadow}`.

Badges use the tints: `{colors.tint-sky}` (test player), `{colors.tint-meadow}`
(connected), `{colors.tint-wheat}` (host, two dice); at night
`{colors.night-tint-sky}`, `{colors.night-tint-meadow}`, `{colors.night-tint-wheat}`
(a low-chroma brown-gold, so it does not go olive).

### Materials (both themes)

- Evergreen `{colors.holly}`, `{colors.holly-light}`, `{colors.holly-dark}` with
  `{colors.on-holly}`: panel frames, the garland on the table, switches that are on.
  `{colors.meadow}` is its lighter sister for the garland's highlights.
- Walnut `{colors.wood}`, `{colors.plank}`, `{colors.wood-light}`, `{colors.wood-dark}`:
  the dice table and the signs. Text on it is `{colors.cream}`.
- Window gold `{colors.wheat}`, `{colors.wheat-light}`, `{colors.wheat-dark}` with
  `{colors.on-wheat}`: first place, the countdown, the pause stripe. **Never a button.**
- Berry `{colors.berry}`, `{colors.berry-light}` with `{colors.on-berry}`: notices,
  the garland's berries, the six's pips `{colors.pip-six}`.
- `{colors.silver}`: second place. `{colors.sky}`: ice in the six sunburst.
- Signs are `{colors.parchment}` with `{colors.ink}` text; dice are `{colors.die-face}`
  with a `{colors.die-edge}` edge and `{colors.pip}` pips. Pixel outlines are
  `{colors.outline}`.

### Contrast

Every text pair in `components` reaches 4.5:1 in its theme (WCAG AA); borders and focus
reach 3:1. `test/design.test.ts` computes them from this file; the table in
`docs-tech/ui-assets.md` lists the numbers.

## Typography

- **Pixelify Sans** (OFL, self-hosted) for the room name, headings, the turn and signs:
  `title` 2.6rem, `turn` 2rem, `heading` 1.2rem.
- **Jersey 10** (OFL, self-hosted) for the digits inside those headings only: Pixelify's
  5 reads as an S and Silkscreen's 4 as a blob. `size-adjust: 145%` matches the cap height.
- The **system rounded face** (`ui-rounded`, then the platform UI font) for everything
  else: `body` 1rem / 500.
- No webfont from a CDN; no third font.

## Layout

Pixel units: everything snaps to a 4 px grid (`spacing.unit`). From 1100 × 540 px the
room is the window: three columns, lists scroll inside their panels, never the page.
On a phone the columns dissolve into one reading order: dice, host tools, guide, gifts,
turns, reactions, history, participants. The footer is one row: small links and the
public-room note stacked on the left, "Ton: Würfel / Gewinner / Dran" and the theme
switch on the right.

## Elevation & Depth

Flat pixel art: no blur anywhere. Depth is a hard offset shadow in `{colors.shadow}`
below panels and buttons, and a bevel on controls (a light line on top, a dark one at
the bottom). The bevels never change on hover.

## Shapes

`rounded.none` everywhere. Frames are notched: four hard box-shadow copies leave the
corners open, like pixel art. Panel frames are a real border (evergreen) plus an inset
outline (paper edge), never inset shadows, so text scrolling inside a panel stays
inside its frame.

## Components

- **Button** — `{colors.tint}` face, `{colors.frame}` notched outline, bevels. Hover:
  the face turns `{colors.tint-hover}`. Press: sinks 2 px.
- **Primary button** — `{colors.primary}`, text `{colors.on-primary}`, weight 800. Hover
  `{colors.primary-hover}`. One per screen.
- **Your turn** — the turn heading becomes a plaque in `{colors.primary}`; the chime
  plays once the dice have landed.
- **Dice table** — walnut planks with an evergreen garland and berries; caption in
  `{colors.cream}`, the countdown in `{colors.wheat-light}`.
- **Turn order** — numbered rows with avatar; the active row `{colors.turn-active}`
  with a `{colors.turn-active-edge}` bar and a `{colors.primary}` number.
- **Gift order** — first place gold, second `{colors.silver}`, third evergreen.
- **Switch** — knob left on a grey track with "aus", knob right on an evergreen track
  with "an": position, colour and word, never colour alone.
- **Disclosure arrow** — a two-bar pixel arrow in `{colors.accent}`.
- **Six banner** — sunburst of `{colors.sky}` and snow rays, the six on a sign, the
  banner opens one second after the dice land.
- **Reactions** — rise left and right of the dice, never across the result.

## Do's and Don'ts

- **Do** take every colour from a token; a hex value outside the token blocks is a bug. The one
  exception is the translucent white and black of the bevels (`#ffffff80`, `#ffffff40`, `#00000040`).
- **Do** keep blue for the season and for "press this"; use walnut and evergreen for warmth.
- **Do** change the whole face on hover.
- **Don't** use orange, or a brown that reads orange (oklch hue 20–80 with chroma ≥ 0.06).
- **Don't** make a button gold or put gold behind the active player.
- **Don't** colour titles or arrows berry or pink; berry is the six, notices and focus.
- **Don't** let the light theme glare: no white panels, no white page background.
- **Don't** blur shadows or round corners.
