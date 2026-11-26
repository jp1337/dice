#!/usr/bin/env bash
# Starts a built image the way production does (NODE_ENV=production, PostgreSQL from docker-compose.yml)
# and runs its own HEALTHCHECK until healthy: the image's CMD, migrations, dist/ layout, user and the check.
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
# Over TCP: on the first start the image runs a temporary init server on the socket only, then restarts.
ready=""
for _ in $(seq 1 60); do "$docker" exec "$run-pg" pg_isready -h 127.0.0.1 -U dice -d dice -q 2>/dev/null && ready=1 && break; sleep 1; done
[[ -n "$ready" ]] || { echo "smoke: PostgreSQL did not come up" >&2; exit 1; }

# Placeholder values only: nothing here reaches Discord, and the legal block is required in production.
"$docker" run -d --name "$run-app" --network "$run" \
  -e BASE_URL=https://dice.example.org \
  -e DATABASE_URL="postgres://dice:smoke@$run-pg:5432/dice" \
  -e SESSION_SECRET=smoke-session-secret-0123456789abcdef \
  -e DISCORD_CLIENT_ID=100000000000000001 -e DISCORD_CLIENT_SECRET=smoke -e DISCORD_GUILD_ID=100000000000000002 \
  -e HOST_DISCORD_IDS=100000000000000010 \
  -e LEGAL_NAME="Erika Muster" -e LEGAL_ADDRESS="Musterstraße 1|12345 Musterstadt" -e LEGAL_EMAIL=dice@example.org \
  "$image" >/dev/null

# The image's own HEALTHCHECK decides, so a broken one fails here too. Run on demand: docker only runs it
# after the image's start period, and rootless podman needs systemd timers for its schedule.
healthy() {
  if [[ "$(basename "$docker")" == podman ]]; then
    "$docker" healthcheck run "$run-app" >/dev/null 2>&1
  else
    local check
    check="$("$docker" inspect -f '{{join .Config.Healthcheck.Test "\x1f"}}' "$run-app")"
    [[ "$check" == CMD$'\x1f'* ]] || { echo "smoke: the image has no exec-form HEALTHCHECK" >&2; exit 1; }
    local args=()
    IFS=$'\x1f' read -r -a args <<<"${check#CMD$'\x1f'}"
    "$docker" exec "$run-app" "${args[@]}" >/dev/null 2>&1
  fi
}
deadline=$((SECONDS + 90))
while ((SECONDS < deadline)); do
  if healthy; then
    user="$("$docker" exec "$run-app" id -un)"
    [[ "$user" == "node" ]] || { echo "smoke: the app runs as '$user', not node" >&2; exit 1; }
    echo "smoke: $image healthy by its own HEALTHCHECK (migrated, user $user)"
    exit 0
  fi
  [[ "$("$docker" inspect -f '{{.State.Running}}' "$run-app")" == "true" ]] || break
  sleep 1
done
echo "smoke: $image did not become healthy" >&2
"$docker" logs "$run-app" 2>&1 | tail -20 >&2
exit 1
