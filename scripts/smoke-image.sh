#!/usr/bin/env bash
# Starts a built image the way production does (NODE_ENV=production, PostgreSQL from docker-compose.yml)
# and waits for its own HEALTHCHECK to say healthy: the image's CMD, migrations, dist/ layout and user.
# Usage: scripts/smoke-image.sh <image>   (DOCKER=podman for podman)
set -euo pipefail

image="$1"
docker="${DOCKER:-docker}"
run="dice-smoke-$$"
pg_image="$(sed -n 's/^ *image: \(postgres:.*\)$/\1/p' "$(dirname "$0")/../docker-compose.yml")"

cleanup() { "$docker" rm -f "$run-app" "$run-pg" >/dev/null 2>&1 || true; "$docker" network rm "$run" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$docker" network create "$run" >/dev/null
"$docker" run -d --name "$run-pg" --network "$run" -e POSTGRES_USER=dice -e POSTGRES_DB=dice -e POSTGRES_PASSWORD=smoke "$pg_image" >/dev/null
for _ in $(seq 1 60); do "$docker" exec "$run-pg" pg_isready -U dice -q 2>/dev/null && break; sleep 1; done

# Placeholder values only: nothing here reaches Discord, and the legal block is required in production.
"$docker" run -d --name "$run-app" --network "$run" \
  -e BASE_URL=https://dice.example.org \
  -e DATABASE_URL="postgres://dice:smoke@$run-pg:5432/dice" \
  -e SESSION_SECRET=smoke-session-secret-0123456789abcdef \
  -e DISCORD_CLIENT_ID=100000000000000001 -e DISCORD_CLIENT_SECRET=smoke -e DISCORD_GUILD_ID=100000000000000002 \
  -e HOST_DISCORD_IDS=100000000000000010 \
  -e LEGAL_NAME="Erika Muster" -e LEGAL_ADDRESS="Musterstraße 1|12345 Musterstadt" -e LEGAL_EMAIL=dice@example.org \
  "$image" >/dev/null

# The HEALTHCHECK starts after its start period; ask the same URL directly so the wait is short.
for _ in $(seq 1 60); do
  if "$docker" exec "$run-app" node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    user="$("$docker" exec "$run-app" id -un)"
    [[ "$user" == "node" ]] || { echo "smoke: the app runs as '$user', not node" >&2; exit 1; }
    echo "smoke: $image healthy (migrated, /healthz 200, user $user)"
    exit 0
  fi
  [[ "$("$docker" inspect -f '{{.State.Running}}' "$run-app")" == "true" ]] || break
  sleep 1
done
echo "smoke: $image did not become healthy" >&2
"$docker" logs "$run-app" 2>&1 | tail -20 >&2
exit 1
