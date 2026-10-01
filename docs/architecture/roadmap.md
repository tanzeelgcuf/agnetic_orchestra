# Implementation Roadmap

Phased build per the master prompt. Each phase follows the loop: inspect → plan →
implement → test → verify → document → commit. A phase is done only when implementation,
tests, lint, typecheck, security considerations, documentation, and integration
verification are all in place.

## Phase 1 — Foundation  *(in progress — current build)*

- [x] Monorepo (pnpm workspaces), TypeScript strict, ESLint, Vitest, Makefile
- [x] Shared domain model, config loading, errors (`packages/shared`)
- [x] Observability: structured logging with secret redaction (`packages/observability`)
- [x] Database: schema + migrations + repositories (`packages/database`)
- [x] Event bus: in-memory + PostgreSQL adapters, retries, DLQ (`packages/event-bus`)
- [x] Workflow engine: YAML DAG, validation, parallel stages, retries, approvals, resume
      (`packages/workflow-engine`)
- [x] Agent contract, registry (versioned), permissions, policy engine (`packages/agents`)
- [x] API: workflows, events, approve/cancel, agents; bearer auth (`apps/api`)
- [x] Worker: queue consumer driving the engine (`apps/worker`)
- [x] CLI: `orchestra workflow start/status/approve/cancel`, `agent list`, `logs`
- [x] Web dashboard: workflows, timelines, approvals (`apps/web`)
- [x] Docker Compose (postgres + api + worker + web), CI workflow

## Phase 2 — Jira + Requirements Agent

- [ ] Jira adapter (REST + MCP path) in `packages/integrations`
- [ ] Requirements Agent: parse issues, identify ambiguity/missing acceptance criteria,
      decompose epics → stories → tasks, write structured results back to Jira
- [ ] Requirements approval gate in the default workflow
- [ ] Mock Jira service for CI

## Phase 3 — GitHub integration

- [ ] GitHub adapter: repos, branches, commits, PRs, comments, checks, workflows
- [ ] Inbound webhooks (`pull_request.*`, `workflow_run.completed`, `push`)
- [ ] Repository access tokens scoped per project

## Phase 4 — Claude Code execution

- [ ] `ClaudeCodeExecutor` over headless Claude Code (`claude -p`)
- [ ] Development Agent: plan → implement smallest logical change → verify loop
- [ ] Workspace isolation, command allowlists, env filtering
- [ ] PR creation/updates; iterate until quality gates pass

## Phase 5 — Review orchestra

- [ ] Code/Security/Architecture/Test review agents (parallel fan-out)
- [ ] Finding dedup + severity classification
- [ ] Review consensus policy (single critical security finding blocks)

## Phase 6 — Quality gates

- [ ] Quality Gate Agent: deterministic aggregation of reviews + CI + SAST + coverage
- [ ] Policy engine per-repository blocking rules
- [ ] Semgrep/CodeQL/Gitleaks/Trivy integrations feeding the security agent

## Phase 7 — Deployment

- [ ] Deployment Agent over GitHub Actions
- [ ] Environment policies, production approval gate, smoke tests, rollback

## Phase 8 — Production hardening

- [ ] Observability (GlitchTip/Langfuse-style tracing of agent runs)
- [ ] Audit logging hardening, rate limiting, cost controls (token/tool/runtime budgets)
- [ ] Retry/failure recovery tuning, agent evaluation framework
- [ ] JWT/OIDC auth, secret manager integration (Vault/Cloud)
