# Acceptance harness

Proves the spec 16 criteria that unit tests cannot: the app image behind a real nginx with
[`docs/nginx.example.conf`](../docs/nginx.example.conf), PostgreSQL 19, wired like production.

```bash
npx tsx scripts/acceptance/run.mjs --quick         # idle check 3 min, about 5 min in total
npx tsx scripts/acceptance/run.mjs                 # idle check 31 min: the real acceptance run
npx tsx scripts/acceptance/run.mjs --idle-minutes=10
```

Needs rootless podman, `openssl` and `npm install`. Not in CI: it needs podman and minutes.
Each check prints `PASS`/`FAIL` with one line of numbers; any `FAIL` exits non-zero. Containers, network,
image and temp dir are removed afterwards, also on Ctrl-C.

## Setup

| Part | How |
| --- | --- |
| Network | own podman network, fixed addresses: nginx `.10`, app `.11`, PostgreSQL `.12`, probe client `.50` |
| nginx | the example file; only `proxy_pass` (app address) and the certificate lines are filled in. Throwaway self-signed cert for `dice.example.org`, made at run time |
| App | built from the `Dockerfile`, `NODE_ENV=production`, `TRUSTED_PROXIES` = nginx only |
| PostgreSQL | the image pinned in `docker-compose.yml` |
| Login | users and sessions inserted into the database (`sessionIdFor`), as in `test/rooms.test.ts`. No fake Discord: it needs `NODE_ENV=test`, which also silences the log that check 3 reads. The cookie is still checked by the app's real code on every request |
| Clients | the `ws` package (dependency of `@fastify/websocket`): Node's own `WebSocket` cannot set SNI, `Host` or a CA |

Difference to production: nginx runs in a container instead of on the host, so it reaches the app by its
address, not via `127.0.0.1:3000`.

## Checks

Order 1, 2, 3, 4, 6, 5: the restart would cut the idle socket.

| # | Proves | Pass when |
| --- | --- | --- |
| 1 | The stack is wired like production | `/healthz` 200 over TLS from nginx, PostgreSQL 19 |
| 2 | Spec 8.3, 8.4: headers on every response | `X-Robots-Tag`, CSP, `nosniff`, `Referrer-Policy` on `/`, `/r/<slug>`, legal pages, `robots.txt`, `/healthz`, an asset, 404s, `/%zz`, 401 |
| 3 | Spec 8.2: client IP | the log shows the probe client's address for a request through nginx, through nginx with a forged `X-Forwarded-For`, and straight to the app port with one |
| 4 | Spec 8.1, 16: idle WebSocket | open after the idle time with only server pings, ≥ one ping per 25 s, then one round trip |
| 5 | Spec 4.9, 16: restart mid-session | `podman restart` under 3 clients; they reconnect by themselves (growing delay, jitter) and get the identical state; nginx's 502s meanwhile carry `X-Robots-Tag`. Rolls as well once the game commands (step 5) exist |
| 6 | Spec 16: 100 clients | 100 sockets join one room; time until all see all; one host broadcast to all, p95 under 1 s |

## Last results

2026-11-25, `--quick`, rootless podman 6.1, nginx 1.31.6, all PASS:

| # | Numbers |
| --- | --- |
| 1 | `/healthz` 200 via nginx/1.31.6, PostgreSQL 19.0 |
| 2 | all 4 headers on 11 responses (200, 404, 400 from nginx, 401) |
| 3 | logged the client's address all 3 times; nginx's and the forged one never |
| 4 | open after 3 min, 7 server pings, round trip answered |
| 5 | restart 0.4 s, all 3 back with identical state after 2.2 s, nginx 502s meanwhile labelled |
| 6 | first state for all 100 after 1.6 s, all see 101 members after 1.9 s; broadcast p50 27 ms, p95 32 ms, max 33 ms |

Full run, 2026-11-25: check 4 PASS, open after 31 min idle, 74 server pings (≥ 73 expected), round trip answered. The other five PASS too (load p95 30 ms); that run predates the shutdown fix, so its restart took 10.4 s.

## Found by the harness

| Bug | Fix | Regression test |
| --- | --- | --- |
| nginx answers `/%zz` (400), 413 and 502 itself, without `X-Robots-Tag` and the security headers (spec 8.4) | the example adds them via `map` + `add_header … always`, only where the app sent none | `test/app.test.ts` "docs/nginx.example.conf adds the same headers …" |
| A client that does not answer the close handshake held the shutdown for ws's 30 s close timeout; `podman restart` killed the app after 10 s | own `preClose`: close with 1012, terminate after `SHUTDOWN_GRACE_MS` (2 s) | `test/rooms.test.ts` "closes every socket with 1012 on shutdown …" |
