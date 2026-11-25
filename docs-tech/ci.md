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
