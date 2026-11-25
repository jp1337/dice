#!/usr/bin/env bash
# Fails if the text on stdin contains any entry of the personal-data denylist.
# The denylist holds real names, addresses, IDs and domains, so it never enters the repository:
# locally it is .personal-denylist (git-ignored), in CI it comes from a secret.
# Usage: check-personal-data.sh <label> < text
set -euo pipefail

label="${1:-input}"
denylist="${PERSONAL_DENYLIST_FILE:-$(git rev-parse --show-toplevel)/.personal-denylist}"

if [[ ! -s "$denylist" ]]; then
  echo "personal-data check: denylist '$denylist' is missing or empty, refusing to continue." >&2
  echo "Create it with one name, address line, e-mail, domain or ID per line." >&2
  exit 1
fi

# Drop comments and blank lines; match whole words, case-insensitive, as fixed strings.
patterns="$(mktemp)"
trap 'rm -f "$patterns"' EXIT
tr -d '\r' < "$denylist" | grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' > "$patterns" || true
if [[ ! -s "$patterns" ]]; then
  echo "personal-data check: denylist has no entries, refusing to continue." >&2
  exit 1
fi

if hits="$(grep -n -i -w -F -f "$patterns")"; then
  echo "personal-data check: found personal data in $label:" >&2
  # Show only line numbers, so the hit is not echoed into logs again.
  cut -d: -f1 <<<"$hits" | sed 's/^/  line /' >&2
  exit 1
fi
