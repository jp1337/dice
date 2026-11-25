# Specification

English condensation of the operator's German concept (version 9, 2026-11-24, kept outside the repository).
On a conflict the German concept wins; a gap or contradiction is asked about, not decided.

## Goal and scope

A web app for one Discord community's voice event: members roll dice together, and **the order in which
6s fall is the order in which gifts are handed out**. The organizer moderates the voice channel at the
same time, so the app enforces turns itself and pauses on every 6. Built for one event, reusable
without code changes: guild, hosts, rules and texts come from configuration and room settings.

Not built: assigning gifts to people, a Discord bot or DMs, chat (reactions are fixed emojis), voice,
passwords or own accounts, SQLite (not even for tests), PHP, any WebSocket fallback (no long polling, no
SSE), more than one app instance.

## Fixed technical choices

| Area | Choice |
| --- | --- |
| Login | Discord OAuth2 only, members of `DISCORD_GUILD_ID` only. Sole exception: watching a public room read-only |
| Stack | Node.js LTS, TypeScript, Fastify + `@fastify/websocket`, React + Vite SPA served by the backend, Drizzle ORM, Vitest. Deviations only with a written reason |
| Database | PostgreSQL; migrations in the repository, applied at container start |
| Runtime | One multi-stage image, non-root; Docker Compose; behind nginx with CrowdSec, maybe Cloudflare later |
| Real time | WebSockets; the server is the only source of rolls and game state |
| Language | UI German (imprint and privacy notice too). Repository English |
| Domain | Only via `BASE_URL`; examples use `dice.example.org`. The production address appears nowhere |
| Deployment | Pull from the operator's infrastructure repository; no runner attached to this repository |

## Roles

| Property | Who | Can |
| --- | --- | --- |
| Host | Discord ID in `HOST_DISCORD_IDS` (several, about three); never stored in the database | Everything in every room; the only ones who see "create room". Cannot be demoted |
| Co-host | Appointed per room by a host, removable any time | All host tools in that room, except appointing co-hosts and creating rooms. Simulated players cannot be co-hosts |
| Player / spectator | Everyone, hosts included | Players roll. New lobby members are players; the room's creator starts as spectator. In the lobby anyone switches themselves, hosts switch anyone. Joining a running game makes you a spectator until a host appends you |

If one host disconnects, the others carry on without interruption.

## Game flow

1. **Lobby:** logged-in members open the room link and appear in the list. Hosts decide who rolls.
2. **Start:** the server shuffles the players (Fisher-Yates with `crypto.randomInt`) and stores the order.
3. **Turns:** players roll in that order, round after round. Six-sided dice.
4. **Roll:** the active player clicks; the server rolls, stores, broadcasts. Everyone sees the same animation.
5. **Six:** the game pauses with a full-screen banner until a host continues.
6. **End:** once the gift order is complete, it is shown as a numbered list, copyable as text.

The gift order so far is visible to everyone throughout.

## Rules (room `settings`, defaults shown)

| No. | Rule | Setting |
| --- | --- | --- |
| R1 | A 6 gives the next free gift place and removes the player from rolling. Everyone gets exactly one place | fixed (see [decisions](decisions.md)) |
| R2 | With two dice one 6 suffices; two 6s change nothing; a 6 beats a simultaneous 1 | fixed |
| | A 1 grants two dice on the player's next turn (core requirement) | fixed |
| R3 | With two dice, a 1 without a 6 grants the bonus again | `bonusChains: true` |
| R4 | The bonus lasts exactly one actual roll; a skipped player keeps it until they really roll | fixed |
| R5 | The last player chooses: keep rolling until a 6, or take the last place with a button only they see. Hosts can assign it too. `auto` gives it at once | `lastPlayer: "choice"` |
| R6 | Six banner text template, editable in the lobby: `{name} hat eine 6 gewürfelt und bekommt Geschenk Nr. {platz}!` | `sixMessage` |
| | Emoji reactions allowed in the room | `reactions: true` |

## Fairness

- Only the server draws the start order; nobody sets or redraws it once running.
- Every die value is `crypto.randomInt(1, 7)` on the server, also when a host rolls for someone.
- History has two levels, both with name and time; the server filters it per recipient:
  - **public:** every roll; a host rolling for someone is marked ("X rolls for Y");
  - **hosts and co-hosts only:** everything else (skip, undo, pause/continue, remove, add, last place,
    co-host, participation, nickname reset, public on/off, simulated players). Never sent to anyone else.
- Removed players get no place. Latecomers are appended to the end of the turn order.

## Host tools

Pause/continue · skip the current player once · roll for the current player · remove a player · append a
latecomer · undo the last roll · assign the last place · appoint/remove co-hosts (hosts only) · room
public on/off · reset a nickname · switch reactions off · end the game, back to the lobby.

**No turn time limit, no automatic roll.** A host decides to skip or roll for an unresponsive player.

## Test rooms

- Chosen at creation by a host, permanent, labelled "Testraum" for everyone.
- Only there: hosts add (up to 30) and remove simulated players in the lobby; the server refuses them elsewhere.
- Simulated players are `users` rows without Discord ID (`Testspieler 1`, marked in the UI), belong to one
  test room, roll by themselves 6 s after their turn starts (3 s was too fast to watch a roll land), under exactly the same rules and code.
- Real users can join and play: mixed rehearsals work.

## Public room (one link: `/r/:slug`)

- One link per room. Hosts and co-hosts switch "Öffentlich" per room, on for new rooms (rooms from before
  the switch: on only where their old guest link was on).
  - **On:** anyone with the link watches as a guest, without logging in.
  - **Off:** only logged-in members; guests are disconnected at once (4001, asked to log in).
- Logged-in members always get the member view through the same link.
- The slug is the key: never logged (app and nginx example).
- While on, every member sees: "Öffentlicher Raum: Gäste ohne Anmeldung sehen deinen Anzeigenamen."
- Guests read room name, status, turn order, active player, dice and animation, six banner, gift order,
  public history. **Display names with initials only:** no avatars, Discord IDs, usernames, moderation
  entries, or lobby members who neither play nor hold a place.
- Guests send nothing (messages are dropped) and are not listed; hosts see their count.
- Limits: 200 guests per room, 5 guest connections per IP.

## Reconnecting

Membership, role, participation, co-host, place and bonus belong to the Discord ID, never to a connection.
Reopening the link restores all of it; a removed player returns as spectator. The member list shows
connected/disconnected; a disconnected active player is flagged to hosts. Still no automatic roll.

## Nicknames and reactions

- Nickname: 1–32 characters of plain text (control characters and whitespace-only refused), valid in all
  rooms. Shown: nickname, else server nickname, else global Discord name. Hosts also see the Discord name
  and can reset a nickname.
- Reactions: six fixed emojis, by anyone logged in except the active player, flying over the dice without
  names, never stored. 1 per 2 s per person, enforced by the server, which batches bursts. Hideable per
  browser (`localStorage`), switchable off per room by hosts. Respect reduced motion.

## Authentication

- Authorization code flow with `state`; scopes `identify` and `guilds.members.read`; membership via
  `GET /users/@me/guilds/{guild.id}/member`. Non-members get a German message and no session.
- Return target survives the login; only own relative paths.
- Stored: Discord ID, username, display name, avatar. No e-mail; Discord tokens discarded after the check.
- Sessions in PostgreSQL, 7 days, cookie `HttpOnly`, `Secure`, `SameSite=Lax`, not bound to the IP.
- Without a session only `/`, login, `/impressum`, `/datenschutz`, `/robots.txt`, `/healthz` and public rooms
  (guest view) respond. A room link without session always gets the app shell with preview tags; a room
  that is not public then shows a login prompt, no room data.
- Login runs entirely in the browser (no Discord app needed); must also work when the Discord mobile app
  intercepts the link, and in its in-app browser.

**Avatars:** fetched by the server only when the hash changed at login; guild avatar before global one;
none → generated initials, no download. 128 px static, host `cdn.discordapp.com` only, address built
from ID and hash, timeout, 1 MB limit, type check. Failure keeps the old image and never fails the login.
Stored as `bytea`, served at `GET /avatars/:userId/:hash` with a session, `immutable`. Deleted with the user.

## Data and event model

Tables and columns: [`src/server/db/schema.ts`](../src/server/db/schema.ts). Host status is computed
from configuration at runtime; room slugs are random and not guessable.

The game state is never stored; it is `reduce(events, settings) -> GameState` over the append-only
`game_events`. Types, payloads and per-type visibility: [`src/shared/contracts.ts`](../src/shared/contracts.ts).

- `reduce` is pure (no network, no database) and holds all rule logic.
- Moderation events live in the same log so history has one source; `reduce` ignores them.
- `undone` names the roll it takes back (`seq`) and counts only while that roll is the newest one still in
  effect: two hosts clicking at once undo one roll. Undone rolls leave the computation, stay in the history,
  and are listed in `GameState.undoneSeqs`.
- Game commands are checked by the pure `decide(state, command, ctx)`, which returns the events to append.
- The server keeps state per room in memory and rebuilds it from the events after a restart.

## Interfaces

**HTTP:** `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` · `GET`/`PATCH /api/me` (nickname
only) · `POST /api/rooms` (hosts), `GET /api/rooms/:slug` (without session: 401 unless public) · `GET /r/:slug`
· `GET /healthz` (database check, no details) · `GET /impressum`, `/datenschutz`, `/robots.txt` ·
`GET /avatars/:userId/:hash`.

**WebSocket `/ws/rooms/:slug`:** session cookie plus `Origin` check against `BASE_URL`.

| Sender | Messages |
| --- | --- |
| Any member | `set_participation` (self, lobby only), `react` |
| Player | `roll`, `claim_last_place` (last player only) |
| Host, co-host | `set_participation` (anyone), `update_settings`, `add_simulated_players`, `remove_simulated_player`, `start`, `pause`, `continue`, `skip`, `roll_for`, `remove_player`, `add_player`, `assign_last_place`, `undo`, `set_public`, `reset_nickname`, `end`, `reset` |
| Host only | `set_cohost` |
| Server | `state` (full room and game state after every change, filtered per recipient), `rolled` (animation trigger), `reactions` (batched), `error` (code + German text) |

**Without a session** (public rooms only, else 401): `/ws/rooms/:slug` with `Origin` sends the guest `state` and
`rolled`, drops everything received.

Server rules: every action is checked against host status, turn and game status; the client decides
nothing. For 6.3 s after a roll no further roll is accepted: 1.3 s of tumbling dice, then a 5 s countdown everyone sees ("Nächster Wurf in 5 …"). JSON only, schema-validated, a few
KB at most. The game never depends on one connection, a host's included.

## Proxy, security, no indexing

- Path: client → maybe Cloudflare → nginx with CrowdSec → app; both variants without code changes.
- `wss` only, under `/ws/` only. Server ping every 25 s, unanswered connections closed. Client reconnects
  with growing, jittered delay and receives the current `state`; no connection → a clear error, not a blank
  page. nginx example in `docs/`; the real config lives in the operator's infrastructure.
- Forwarded headers trusted only from `TRUSTED_PROXIES`. IP used for logs and rate limits only.
- Status codes: 401 no session, 403 no permission, 404 unknown, 429 rate limited; never 200 with an error.
- JSON logs on stdout: time, client IP, method, path, status, user ID; rejected logins logged; never
  tokens, cookies or room slugs (logged as `/r/:slug`, `/api/rooms/:slug`, `/ws/rooms/:slug`).
- Rate limits: login, room creation, WebSocket messages per connection, reactions, room lookups and connections
  without a session per IP.
- Standard methods, small size-limited JSON bodies, no user data in URLs except the room slug.
- Everything from the own domain. Headers: CSP `default-src 'self'`, `connect-src 'self'` + own `wss`,
  `img-src 'self' data:`, `frame-ancestors 'none'`; `X-Content-Type-Options: nosniff`;
  `Referrer-Policy: same-origin`. Hashed assets `immutable`; HTML, `/api`, `/auth` `no-store`.
- No indexing, three layers at once: `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex`
  on **every** response; the same as meta tag; `robots.txt` disallowing all, allowing major search engines
  (so they can see `noindex`) and Discord's preview fetcher, and naming AI crawlers. Lists come from the
  vendors' current documentation, generated from a list in code. No sitemap.

## Legal pages and retention

- `/impressum` (§ 5 DDG) and `/datenschutz`, public, linked from every footer; content from `LEGAL_*`.
  Production refuses to start without `LEGAL_NAME`, `LEGAL_ADDRESS` (`|`-separated lines), `LEGAL_EMAIL`.
  No real data anywhere in the repository.
- The privacy notice describes exactly what the app does, invents no legal bases, and is reviewed by the
  operator. `PRIVACY_CROWDSEC` / `PRIVACY_CLOUDFLARE` switch its sections. One session cookie, no tracking,
  so no cookie banner.
- Daily cleanup, `RETENTION_DAYS` (90): rooms with members and events after the last activity; simulated
  players with their room; users without room membership and last login older than the period; expired
  sessions at once. Logs counts only. No delete button; individual requests by hand (`docs/`).

## Interface

Start (login button with privacy link; hosts: create room, "test room"), lobby, game view, guest view
("Du schaust als Gast zu" with a login link; no buttons, reactions or avatars), six banner (hosts: "continue"), result.
Footer on every page: imprint, privacy notice, GitHub. Mobile-first usable; light and dark following the
system with a toggle (`localStorage`); connection state visible. Distinct short sounds for a roll and a 6,
on by default, per-user mute in `localStorage`, playing from the first click; sound files self-made or
MIT-compatible, origin in the README. Open Graph preview identical for all rooms, no room data, image from
`BASE_URL`, in the served HTML.

## Tests (required)

| Area | Cases |
| --- | --- |
| `reduce` | turn order, bonus after 1, chain, expiry, 6 with one and two dice, 6 with 1, elimination, last player (roll on, claim, host assigns, `auto`), skip with pending bonus, remove, latecomer, undo, every setting both ways |
| WebSocket | roll out of turn refused, host actions from non-hosts refused, no roll while paused, second host takes over, state rebuilt after restart |
| Roles and history | co-host has tools but cannot appoint; non-hosts get no moderation entries; reconnect restores role, place, bonus; removed player returns as spectator; self-switch only in lobby |
| Public room | on by default; off = 401 without a session, guests disconnected at once; guest state has no avatars, IDs, usernames, moderation; guest messages dropped; limits per room and IP; slug never logged |
| Nicknames, reactions | length and character checks, host reset, reaction rate limit, disabled reactions refused |
| Test rooms | simulated players roll by themselves only on their turn, refused in normal rooms, an all-simulated game completes |
| Avatars | same hash no download, new hash replaces, none gives placeholder, failed download does not block login, foreign hosts and oversized files refused |
| Retention | cleanup deletes what is past the period, keeps everything younger |
| Indexing, preview, legal, access | header on every response kind, `robots.txt` content; OG tags identical and without room data; legal pages public and from config, production start fails without `LEGAL_*`; non-member refused, start fails without `DISCORD_GUILD_ID`, untrusted forwarded headers ignored |

Against a real PostgreSQL; Discord replaced by a local fake server.

## Implementation steps

Each step is its own pull request with green CI and leaves a deployed, running app. Section "Proxy,
security, no indexing" applies from step 1.

| Step | Content |
| --- | --- |
| 1 | Skeleton: contracts, Dockerfile, compose with PostgreSQL, migrations, `/healthz`, CI, Renovate |
| 2 | Discord login, sessions, guild check, hosts, imprint and privacy notice (online before the first real login) |
| 3 | Rooms and lobby: create, join by link, WebSocket `state`, participation, reconnect, nicknames |
| 4 | Game logic: `reduce` with tests, rolling, turn checks, bonus, six pause, last player, result |
| 5 | Host tools, co-hosts, two-level history, test rooms, reconnect, restart recovery, cleanup |
| 6 | Polish: animation, sound, banner, reactions, public rooms, theme toggle, link preview, mobile, README |

Work is done by subagents after the main agent has written the contracts and the migration; an
independent subagent reviews every package against this spec before merge.

## Acceptance

- All core functions with at least three browsers connected at once.
- A container restart mid-game loses no roll; clients recover by themselves.
- Manipulated messages cannot roll out of turn. Non-members cannot get in.
- A host can play, and a second host can take over any time.
- Closing the tab and reopening the link restores place and role.
- Login works with Firefox and Chrome on Linux, Chrome or Edge on Windows, Safari on macOS and iOS, Chrome
  on Android and in the Discord in-app browser, without the Discord desktop app.
- A guest sees the game live without avatars, Discord data or moderation entries.
- Legal pages public and linked everywhere; every response carries the no-index header.
- A room link pasted into Discord shows a preview without room data.
- Mute persists across reloads. Expired data disappears without manual work.
- A host alone completes a game in a test room.
- Works behind nginx with the `docs/` settings, WebSocket stable over 30 minutes idle.
- `docker compose up` on a fresh machine with only a filled `.env`.
- 100 clients in one room without noticeable delay.
