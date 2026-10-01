# agentic-dev-orchestra

Orchestration platform that coordinates specialized AI agents across the software
development lifecycle — requirements, development (Claude Code), parallel review
(code/security/architecture/test), CI/CD, quality gates, human approvals, and
deployment — with persistent workflow state and explicit handoffs.

See `docs/architecture/overview.md` for the system design, `decisions.md` for
technology choices, and `roadmap.md` for the phased build plan.

## Quickstart

```bash
make setup        # pnpm install + postgres (docker) + migrations
make dev          # api + worker + web (parallel)
```

The dashboard runs at http://localhost:5173, the API at http://localhost:4100.

```bash
# start a workflow (requires ORCHESTRA_API_TOKEN, see .env.example)
orchestra workflow start software-delivery --context '{"issue_key":"PROJ-123"}'
```

## Commands

| Command | Purpose |
|---|---|
| `make setup` | Install deps, start Postgres, run migrations |
| `make dev` | Run api + worker + web in parallel |
| `make test` | Vitest (unit + integration) |
| `make lint` | ESLint |
| `make typecheck` | TypeScript strict typecheck |
| `make down` / `make clean` | Stop / stop+wipe Postgres |

## Layout

```
apps/           api · worker · web · cli
packages/       shared · observability · database · event-bus
                workflow-engine · agents · integrations · claude-code
workflows/      YAML workflow definitions (software-delivery.yaml)
docs/           architecture (overview, decisions, roadmap)
```
