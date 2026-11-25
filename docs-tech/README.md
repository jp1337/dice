# Technical documentation

For whoever maintains this repository. Never published: not shipped in the image, never linked from `docs/`.
Whoever runs the app reads [`docs/`](../docs/configuration.md) instead.
A page in doubt: would a stranger running dice need it? Yes → `docs/`. Only the next maintainer → here.
[`test/docs.test.ts`](../test/docs.test.ts) holds the boundary.

| Page | Contents |
| --- | --- |
| [spec.md](spec.md) | What to build: rules, roles, events, interfaces, security, retention, tests, steps |
| [architecture.md](architecture.md) | Source layout, request path, contracts and event log, rules for changing them |
| [testing.md](testing.md) | Running the tests, PostgreSQL in podman, the fake Discord |
| [acceptance.md](acceptance.md) | Acceptance harness: app behind real nginx, idle WebSocket, restart, 100 clients |
| [ci.md](ci.md) | CI jobs, required checks, image publishing, repository settings set by hand |
| [ui-assets.md](ui-assets.md) | Generated sounds and preview image, CSP rules for the web code, the UI building blocks |
| [dependencies.md](dependencies.md) | Renovate policy |
| [personal-data.md](personal-data.md) | Hooks, the personal-data denylist, worktrees |
| [decisions.md](decisions.md) | Decisions and why |

Diagrams: draw.io only, never Mermaid. None yet; when the first one comes, copy OpenWhistle's
`scripts/render_diagrams.py` pipeline (source in `docs-tech/_diagrams/`, committed light and dark SVG).
