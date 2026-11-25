# CI

One workflow, [`ci.yml`](../.github/workflows/ci.yml), on GitHub-hosted runners only. Every pull request and
every push to `main`. Workflow permissions: `contents: read`; only `publish` gets `packages: write`.

| Job | Proves | Required |
| --- | --- | --- |
| `lint` | ESLint | yes |
| `typecheck` | `tsc` over source, tests and configs | yes |
| `test` | Vitest against a PostgreSQL 19 service container | yes |
| `docker` | The image builds | yes |
| `secrets-and-personal-data` | gitleaks over the full history; the denylist over file names, contents, history, commit messages and authors ([personal-data.md](personal-data.md)) | yes |
| `CodeQL` | GitHub's default code scanning setup, no workflow file | yes |
| `publish` | Push to `main` only, after the jobs above except CodeQL (default setup cannot be a `needs`; it ran on the pull request): `ghcr.io/jp1337/dice:sha-<commit>` and `:latest` | |

Pull-request runs cancel their predecessors. Runs on `main` never cancel a running one, but GitHub keeps only one waiting run per group: three pushes within one run drop the middle run, so that commit gets no `sha-` tag. `latest` and the next commit's tag still come.

## Speed

Measured November 2026, seconds. The wall-clock is the slowest job; on `main` plus `publish`.

| | Before | After |
| --- | --- | --- |
| Pull request, wall-clock | 43–69 | 37–43 |
| PostgreSQL ready (`Initialize containers`) | 10–13 | 4–7 |
| `test` | 38–44 | 34–40 |
| `docker`, source changed | 31–49 | 23–25 |
| `docker`, nothing in the image changed | 13–20 | 10–13 |
| `docker`, lock file changed | 58–66 | not yet measured |
| `main`, wall-clock | 72–90 | not yet measured |

| Choice | Why | Saves |
| --- | --- | --- |
| PostgreSQL service without health check, step `Wait for PostgreSQL` | Boots during checkout, Node, `npm ci` instead of before them | 6 s |
| `docker` without `setup-buildx-action` | The runner's Docker uses the containerd image store: its own builder reads and writes the `gha` cache | 10–20 s |
| `docker` with `outputs: type=cacheonly` | Loading the image would download every layer for nothing | 6 s against loading |
| `publish` keeps `setup-buildx-action` | Proven push path; reads the cache `docker` wrote (checked: every step cached) | – |

Not changed: Vitest (one file, `game.test.ts`, takes 13 s of 16), `npm` cache (restore 2 s, `npm ci` 3 s),
checkout depth (only the history scan fetches everything, 1 s).

## Deployment

None from here. The operator's infrastructure repository pins `sha-<commit>@sha256:…`, Renovate raises the
pin, the operator's automation pulls and rolls out. Why: [decisions.md](decisions.md).

## Repository settings, set by hand

| Setting | Value |
| --- | --- |
| Settings → Actions → General → Approval for running fork pull request workflows | Require approval for all external contributors |
| Branch protection on `main` | Pull request required; the six required checks above |
| Secret `PERSONAL_DENYLIST` | The denylist, one entry per line. Without it `secrets-and-personal-data` fails |
| Private vulnerability reporting | On |
| Renovate | GitHub App installed for this repository |

Fork pull requests get no secrets, so their personal-data check fails by design: re-run it from a branch in
this repository before merging.
