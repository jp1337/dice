#!/usr/bin/env bash
# Runs inside the gitleaks image (see ci.yml). gitleaks exits 0 when git itself fails and nothing
# was scanned, so the scan only counts if it reports at least one commit and no error.
set -euo pipefail
log="$(mktemp)"
gitleaks git --redact --no-banner . 2>&1 | tee "$log"
if grep -q 'ERR' "$log" || ! grep -Eq '[1-9][0-9]* commits scanned' "$log"; then
  echo "gitleaks did not scan the history (see the log above), failing." >&2
  exit 1
fi
