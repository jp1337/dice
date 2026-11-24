# Architecture

One process, one database. Client → (Cloudflare) → nginx + CrowdSec → `127.0.0.1:3000` → app → PostgreSQL.
Game state per room lives in memory and is rebuilt from the event log; that is why there is exactly one
instance.

## Source layout

| Path | Holds |
| --- | --- |
| `src/shared/contracts.ts` | zod schemas and types shared by server and web: settings, events and their visibility, `GameState`, WebSocket messages, limits |
| `src/shared/constants.ts` | The zod-free values (reaction emojis, limits); `contracts.ts` re-exports them. `src/web` imports values only from here, types from `contracts.ts` only with `import type`, so zod stays out of the browser bundle (`test/web.test.ts`) |
| `src/server/main.ts` | Start: parse config, pool, build app, migrate, listen; graceful shutdown |
| `src/server/app.ts` | Fastify: headers on every response, one JSON log line per request, rate limits, `/healthz`, legal pages, static files |
| `src/server/config.ts` | `parseConfig(env)`, pure, every variable validated |
| `src/server/auth.ts`, `discord.ts` | Step 2: OAuth flow, sessions, `/api/me`, avatars |
| `src/server/legal.ts`, `robots.ts` | Imprint and privacy notice HTML; `robots.txt` from a sourced crawler list |
| `src/server/db/schema.ts`, `migrate.ts` | Drizzle schema; migrations applied at start |
| `drizzle/` | Generated SQL migrations and their snapshots |
| `src/web/` | React SPA, Vite root; built to `dist/web` and served by the app. `components/` render, `lib/` holds their logic, `public/` is copied as is ([ui-assets.md](ui-assets.md)) |
| `test/` | Vitest; see [testing.md](testing.md) |

## Rules for changing things

| Change | Rule |
| --- | --- |
| A message, event or setting | `contracts.ts` first, then server and web. A new event type must declare its visibility: `eventVisibility` is a `Record<EventType, …>`, so the compiler refuses a gap |
| The schema | Edit `schema.ts`, run `npm run db:generate`, commit SQL and `meta/` together. Never edit a migration that has reached `main`: production has applied it |
| Game logic | Only in the pure `reduce(events, settings)`. Events are append-only, `seq` unique per room; undo is an event, not a delete |
| A response path | Every response carries the no-index and security headers. Routed replies get them from `onSend`; malformed URLs (`frameworkErrors`) and raw parser errors (`clientErrorHandler`) set them by hand. A new early exit must too; `test/app.test.ts` checks each kind |
| A crawler | Add it to `robots.ts` with the vendor's documentation URL beside it |
| Logging | Never tokens, cookies or query strings; `redact` covers headers |
| Configuration | New variable in `config.ts`, `.env.example` and `docs/configuration.md`; `test/docs.test.ts` fails otherwise |
