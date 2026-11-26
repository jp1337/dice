# Deployment

One app container and one PostgreSQL container, behind your own reverse proxy with TLS.
The app is never reachable from the internet directly: compose binds it to `127.0.0.1`.

## 1. Discord application

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **OAuth2** → copy the client ID and reset the secret: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`.
3. **OAuth2 → Redirects** → add `${BASE_URL}/auth/callback`, e.g. `https://dice.example.org/auth/callback`.
   It must match exactly.
4. Nothing else: no bot, no URL generator. The app asks for the scopes `identify` and
   `guilds.members.read` itself.
5. IDs: Discord → **Settings → Advanced → Developer Mode** on. Right-click the server → **Copy Server ID**
   (`DISCORD_GUILD_ID`); right-click a person → **Copy User ID** (`HOST_DISCORD_IDS`).

## 2. Start

```bash
cp .env.example .env    # every variable: configuration.md
docker compose up -d
docker compose logs -f app
```

The app migrates the database before it listens. `GET /healthz` answers `ok` once the database is reachable,
`503` otherwise.

## 3. Reverse proxy

Start from [nginx.example.conf](nginx.example.conf). What the app needs from any proxy:

| Need | Why |
| --- | --- |
| `Upgrade` and `Connection` headers on `/ws/` | WebSockets carry the game; there is no fallback |
| `proxy_read_timeout` well above 25 s | The app pings every 25 s; shorter timeouts drop idle players |
| `X-Forwarded-For`, `X-Forwarded-Proto` | Client IP for logs and rate limits |
| `TRUSTED_PROXIES` = the address the proxy connects from | Otherwise those headers are ignored. Compose default: `172.31.250.1` |
| `X-Robots-Tag` and the security headers on the proxy's own error pages | nginx answers malformed URLs (400), bodies over its limit (413) and 502 during a restart itself; the example's `map` + `add_header` fills them in only there |

Behind Cloudflare: let nginx restore the client address (`set_real_ip_from` with Cloudflare's ranges,
`real_ip_header CF-Connecting-IP`) and set `PRIVACY_CLOUDFLARE=true`.

## 4. Images and updates

CI publishes after the checks pass on `main` (CodeQL ran on the pull request):

| Tag | Points to |
| --- | --- |
| `ghcr.io/jp1337/dice:sha-<commit>` | that commit, never moves |
| `ghcr.io/jp1337/dice:latest` | the newest green commit on `main` |

For production, pin tag **and** digest, `ghcr.io/jp1337/dice:sha-<commit>@sha256:<digest>`, and let a tool
such as Renovate raise the pin. The reference deployment does exactly that from a separate infrastructure
repository: it pulls; nothing in this repository pushes to a server.

- Migrations run at start and only go forward. Take a backup before an update; it is your way back.
- A PostgreSQL major update needs a dump and restore, never just a new image tag.

## 5. Backup

```bash
docker compose exec -T postgres pg_dump -U dice dice > dice-$(date +%F).sql
```

Restore: the app migrates at start, so its database is never empty. Stop it and recreate the database first:

```bash
docker compose stop app
docker compose exec -T postgres dropdb -U dice dice
docker compose exec -T postgres createdb -U dice dice
docker compose exec -T postgres psql -U dice -v ON_ERROR_STOP=1 dice < dice-2026-12-01.sql
docker compose start app
```

## 6. Logs

One JSON line per request on stdout: time, shortened client IP, method, path without query string or room slug, status, user ID.
Rejected logins get their own line. No tokens, no cookies.
Limit how long your server keeps them: [data-and-deletion.md](data-and-deletion.md#logs).
