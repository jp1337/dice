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

# Drop comments, blank lines and the spaces around an entry. An entry matches as a fixed string,
# case-insensitive, unless a letter touches it: "Mustermann_cv.pdf" and "mustermann2024" are hits,
# "Mustermannstraße" is not (a plain substring match hits ordinary words). The locale is fixed, so
# "MÜLLER" matches "Müller" from a hook or GUI client running under LC_ALL=C too.
entries="$(tr -d '\r' < "$denylist" | grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || true)"
if [[ -z "$entries" ]]; then
  echo "personal-data check: denylist has no entries, refusing to continue." >&2
  exit 1
fi
# The pattern goes through a file, not argv, so the entries never show in a process list.
pattern="$(mktemp)"
trap 'rm -f "$pattern"' EXIT
printf '(?<!\\p{L})(?:%s)(?!\\p{L})\n' "$(sed 's/\\E//g; s/.*/\\Q&\\E/' <<<"$entries" | paste -sd'|')" > "$pattern"

if hits="$(LC_ALL=C.UTF-8 grep -n -i -a -P -f "$pattern")"; then
  echo "personal-data check: found personal data in $label:" >&2
  # Show only line numbers, so the hit is not echoed into logs again.
  cut -d: -f1 <<<"$hits" | sed 's/^/  line /' >&2
  exit 1
fi
