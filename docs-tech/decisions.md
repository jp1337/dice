# Decisions

Newest first. A decision changes by a new row, not by editing an old one.

| Date | Decision | Why |
| --- | --- | --- |
| 2026-11-24 | TypeScript stays on 6.0 | `typescript-eslint` 8.74 declares `typescript >=4.8.4 <6.1.0`; the Renovate PR for TypeScript 7 (#5) cannot update the lockfile. Revisit when `typescript-eslint` widens its range |
| 2026-11-24 | Deploy by pull: the infrastructure repository pins `sha-<commit>@sha256:…`, Renovate raises the pin, the operator's automation rolls out. Replaces the self-hosted runner deploy job of step 1 (#4) | A self-hosted runner attached to a public repository can be reached through fork pull requests |
| 2026-11-24 | Publish `sha-<commit>` and `latest` only after every check on `main` passed | The pin names an image that went through CI; the digest makes it immutable |
| 2026-11-24 | PostgreSQL 19 | Newest major at the start; every later major costs a dump and restore. Since 18 the data lives below `/var/lib/postgresql/<major>/`, so the volume mounts `/var/lib/postgresql` |
| 2026-11-24 | Node.js 26 | The Active LTS line |
| 2026-11-24 | `.dockerignore` is an allowlist | `.env`, the denylist, the German concept and `docs-tech/` can never reach the build context |
| 2026-11-24 | The personal-data denylist lives outside the repository: local file, CI secret | The list itself is the personal data it guards against |
