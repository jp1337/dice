# Testing

```bash
npm run lint && npm run typecheck && npm test
```

Tests that need PostgreSQL are skipped without `TEST_DATABASE_URL`, and Vitest says so at the top of the
run. CI always sets it, so a skip there is impossible. Never SQLite, not even locally (spec).

## PostgreSQL with podman

Same image as compose and CI:

```bash
podman run -d --rm --name dice-test-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=dice -e POSTGRES_PASSWORD=dice -e POSTGRES_DB=dice_test \
  docker.io/library/postgres:19-alpine
TEST_DATABASE_URL=postgres://dice:dice@127.0.0.1:55432/dice_test npm test
podman stop dice-test-pg
```

Tests migrate the database themselves and must survive running twice against the same one.

## Files

| File | Covers |
| --- | --- |
| `test/helpers.ts` | `makeApp()` with fictitious config (`dice.example.org`), a fake Vite build, captured log lines |
| `test/fake-discord.ts` | Step 2: local stand-in for Discord's API and CDN; tests set its `state` per case |
| `test/app.test.ts` | Headers on every kind of response, logging, rate limits |
| `test/config.test.ts`, `robots.test.ts` | Configuration rules, `robots.txt` |
| `test/db.test.ts` | Migrations, `/healthz`, a dropped database connection |
| `test/docs.test.ts` | `docs-tech/` stays unpublished, links resolve, every variable documented |

## Rules

- Fictitious values only: the repository is public. `dice.example.org`, IDs like `100000000000000001`.
- Test the real path: `app.inject` against the built app, real PostgreSQL, the fake Discord over HTTP.
- A test that can pass while checking nothing gets a guard that it saw something (see `docs.test.ts`).
