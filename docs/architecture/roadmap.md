# Implementation Roadmap

Phased build per the master prompt. Each phase follows the loop: inspect → plan →
implement → test → verify → document → commit. A phase is done only when implementation,
tests, lint, typecheck, security considerations, documentation, and integration
verification are all in place.

## Phase 1 — Foundation  *(complete — verified 2026-10-01)*

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

## Phase 2 — Jira + Requirements Agent  *(complete — verified 2026-10-02)*

- [x] Jira adapter (REST via Jira Cloud API v3 + ADF; MCP path via `McpAdapter` interface)
      in `packages/integrations`
- [x] Requirements Agent: parse issues, identify ambiguity/missing acceptance criteria,
      decompose epics → stories → tasks, write structured results back to Jira
      (LLM reasoning via official Anthropic SDK with adaptive thinking, deterministic
      heuristic fallback offline; untrusted-content defense)
- [x] Requirements approval gate in the default workflow
- [x] In-memory Jira double for CI (containerized mock service deferred — the adapter
      interface keeps it swappable)

## Phase 3 — GitHub integration  *(complete — verified 2026-10-02)*

- [x] GitHub adapter (Octokit-backed): repos, branches, commits, PRs, comments,
      checks + `InMemoryGitHubAdapter` for tests
- [x] Inbound webhooks: HMAC-SHA256 signature verification, delivery dedup
      (`webhook_deliveries`), event mapping (`pull_request.*`, `push`,
      `workflow_run`, `deployment_status`), audit, configurable webhook→workflow
      triggers
- [x] Scoped secret resolution: `SecretProvider` (env-backed) + per-integration
      config (GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET, JIRA_*)

## Phase 4 — Claude Code execution  *(complete — verified 2026-10-03)*

- [x] `ClaudeCodeExecutor` over headless Claude Code (`claude -p`): `ClaudeCodeCliExecutor`
      (spawn, timeout, output capture, credential-stripping env filter) +
      `NoopExecutor` for tests; `ORCHESTRA_DEV_EXECUTOR=noop|cli` selects
- [x] Development Agent: plan (read-only tools) → implement + verify
      (read/write/bash) → commit/push (shell-only) loop; untrusted-content
      defense in every prompt; PR creation via `github.create_pull_request`
      tool when available — never merges its own PR
- [x] Workspace isolation: `WorktreeWorkspaceManager` (git worktree in temp
      dirs); engine enforces `agent.validate(input)` before execution (§15)
- [x] PR creation/update path: `registerGitHubTools` (merge deliberately
      excluded); fix-iteration on review findings lands with Phase 5/6 wiring
- [x] Concurrency hardening found during verification: unique index on
      `(run_id, stage_id)` + conflict-refetch + per-run worker serialization

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
