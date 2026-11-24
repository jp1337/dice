# Configuration

Everything comes from environment variables, in compose from `.env` (template: [`.env.example`](../.env.example)).
The app checks them at start and exits with a list of what is wrong.
Login, `SESSION_SECRET`, `DISCORD_CLIENT_*` and `PRIVACY_*` take effect with step 2 (Discord login).

## App

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `production` makes `LEGAL_*` required. `.env.example` sets it |
| `BASE_URL` | yes | | Public address, e.g. `https://dice.example.org`: https (http only outside production), no path, query or credentials. Builds the login redirect, the CSP and the WebSocket origin check |
| `PORT` | no | `3000` | Port on `127.0.0.1` that compose publishes. Inside the container always 3000 |

## Database

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `POSTGRES_PASSWORD` | with compose | | URL-safe characters only: `openssl rand -hex 32` |
| `DATABASE_URL` | without compose | | `postgres://user:password@host:5432/db`. Compose builds it from `POSTGRES_PASSWORD` |

## Discord login and access

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `SESSION_SECRET` | yes | | At least 32 characters: `openssl rand -base64 48`. Changing it logs everyone out |
| `DISCORD_CLIENT_ID` | yes | | OAuth2 client ID of your Discord application |
| `DISCORD_CLIENT_SECRET` | yes | | OAuth2 client secret |
| `DISCORD_GUILD_ID` | yes | | Server ID. Only its members can log in; without it the app does not start |
| `HOST_DISCORD_IDS` | no | empty | User IDs, comma-separated. Hosts in every room, the only ones who can create rooms |
| `DISCORD_API_BASE`, `DISCORD_CDN_BASE` | no | Discord | Tests only. Refused unless `NODE_ENV=test` |

How to get the IDs: [deployment.md](deployment.md#1-discord-application).

## Reverse proxy

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `TRUSTED_PROXIES` | yes, behind a proxy | empty | Addresses or networks, comma-separated, whose `X-Forwarded-*` headers count. With compose: `172.31.250.1`. Empty: every client looks like the proxy and shares one rate limit |
| `DICE_SUBNET` | no | `172.31.250.0/24` | Compose network. Change it only if taken, then set `TRUSTED_PROXIES` to its `.1` address |

## Imprint and privacy notice

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `LEGAL_NAME` | in production | | Name on `/impressum` and in the privacy notice |
| `LEGAL_ADDRESS` | in production | | Lines separated by `\|`, e.g. `c/o Example Ltd\|Example Street 1\|12345 Example Town` |
| `LEGAL_EMAIL` | in production | | Contact address |
| `LEGAL_NOTE` | no | empty | One extra line under the imprint |
| `PRIVACY_CROWDSEC` | no | `true` | Shows the CrowdSec section of the privacy notice |
| `PRIVACY_CLOUDFLARE` | no | `false` | Shows the Cloudflare section |

The `PRIVACY_*` switches change text only. Set them to what actually runs in front of the app.
The privacy notice is a draft: check it before going live.

## Retention

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `RETENTION_DAYS` | no | `90` | Days after the last activity before rooms, their events and inactive users are deleted. See [data-and-deletion.md](data-and-deletion.md) |

## Trying it on your own machine

`BASE_URL=http://localhost:3000` and the redirect `http://localhost:3000/auth/callback` in the Developer Portal.
Chrome and Firefox accept the secure session cookie on `localhost` without TLS.
