#!/usr/bin/env bash
# Runs check-personal-data.sh over what a commit adds (`staged`, the pre-commit hook) or over the whole
# repository (`repo`, CI). Usage: scan-personal-data.sh staged|repo
set -euo pipefail
check="$(dirname "$0")/check-personal-data.sh"
# core.quotePath=false: by default git prints "M\303\274ller.txt", which no denylist entry matches.
# --text: binary files show their content instead of "Binary files differ".
# --no-ext-diff --no-textconv: an external diff tool or textconv would replace the diff git hands us.
git=(git -c core.quotePath=false)
diff=(--no-color --text --no-ext-diff --no-textconv)

case "${1:-}" in
  staged)
    # Added lines and file names. Not filtering "+++ " lines: that also dropped added lines starting
    # with "++ ", and the header only adds the file name, which is checked anyway.
    {
      "${git[@]}" diff --cached "${diff[@]}" -U0 --diff-filter=ACMR | grep -a -E '^\+' || true
      "${git[@]}" diff --cached --name-only --diff-filter=ACMR
    } | "$check" "the staged changes"
    ;;
  repo)
    "${git[@]}" ls-files | "$check" "tracked file names"
    "${git[@]}" ls-files -z | xargs -0 cat -- | "$check" "tracked file contents"
    "${git[@]}" log --all -p "${diff[@]}" --diff-merges=first-parent --format= | "$check" "the history of all files"
    "${git[@]}" log --all --format=%B | "$check" "commit messages"
    "${git[@]}" log --all --format='%an%n%ae%n%cn%n%ce' | "$check" "commit authors and committers"
    ;;
  *)
    echo "usage: $0 staged|repo" >&2
    exit 2
    ;;
esac
