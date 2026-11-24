# Dependencies

Renovate as GitHub App, configured in [`renovate.json`](../renovate.json). Managers: npm, Dockerfile,
compose, GitHub Actions. Nightly window 02:00–05:00 Europe/Berlin; security alerts at any time.

| Update | Handling |
| --- | --- |
| Patch, pin, digest | Merges itself once CI is green |
| Minor, major | Pull request, merged by hand |
| `fastify`, `@fastify/*` (cookie, websocket, static), `pg`, `drizzle-orm`, `zod`, `postgres` | Never automerged, labelled `security-relevant` |
| PostgreSQL image | Grouped, always by hand: a major needs dump and restore |
| Node.js (image, `engines`, `setup-node`) | Grouped as one runtime update |
| Lockfile maintenance | Mondays, by hand |
| `ghcr.io/jp1337/dice` | Ignored: CI builds it |

- `minimumReleaseAge: 3 days` keeps freshly published, possibly compromised versions out.
- Docker images and Actions are pinned by digest; the comment beside an Action SHA names its version.
- Exact versions in `package.json`, lockfile committed.
- Blocked: TypeScript 7 ([decisions.md](decisions.md)).
