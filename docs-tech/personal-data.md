# Personal data in a public repository

The repository is public; real names, addresses, e-mail addresses, Discord IDs and the production domain
must never enter it, its history or its commit metadata. Two layers catch them.

| Where | Checks | Denylist from |
| --- | --- | --- |
| `.githooks/pre-commit` | author e-mail is the GitHub noreply address; gitleaks on the staged diff; denylist on added lines and file names (`scripts/scan-personal-data.sh staged`) | `.personal-denylist` |
| `.githooks/commit-msg` | denylist on the message | `.personal-denylist` |
| CI `secrets-and-personal-data` | gitleaks on the whole history; denylist on file names, contents, history, commit messages, authors (`scripts/scan-personal-data.sh repo`) | secret `PERSONAL_DENYLIST` |

`npm install` activates the hooks (`prepare` sets `core.hooksPath`). gitleaks must be installed; the hook
refuses to commit without it. Never `--no-verify`.

Both scans read file names unescaped (`core.quotePath=false`), binary files as text, and ignore external diff
tools; `test/personal-data-scan.test.ts` has one case for each, since each once passed unnoticed.

## The denylist

`.personal-denylist` in the repository root, git-ignored: one name, address line, e-mail, domain or ID per
line; `#` comments allowed. An entry matches as a fixed string, case-insensitive in any locale, unless a
letter touches it: `max_mustermann` and `mustermann2024` are hits, `Mustermannstraße` is not
([`scripts/check-personal-data.sh`](../scripts/check-personal-data.sh)). A missing or empty list fails, it
never passes silently. Hits are reported as line numbers only, so the log does not repeat them.

Changing it: edit the local file, then update the secret with the same content:

```bash
gh secret set PERSONAL_DENYLIST < .personal-denylist
```

## Worktrees

A git worktree has no copy of the git-ignored file. Point the scripts at the main checkout's list:

```bash
export PERSONAL_DENYLIST_FILE=/path/to/main/checkout/.personal-denylist
```

## Writing about people

Roles, not names: "the organizer", "a host". Domains: `dice.example.org`. IDs: fictitious, e.g.
`100000000000000001`. Imprint data comes from `LEGAL_*` at runtime, never from the repository.
If something slipped into `main` already, tell the operator before rewriting history.
