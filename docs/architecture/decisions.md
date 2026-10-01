# Architectural Decision Records

## ADR-001 — TypeScript on Node 22, pnpm workspaces

**Decision.** TypeScript everywhere; pnpm workspaces; apps run via `tsx`, packages
export TS source directly (`"main": "./src/index.ts"`).

**Rationale.** One language across API, worker, agents, and web keeps the agent contract
and shared types literal (`import type` across package boundaries). pnpm's strict linking
prevents phantom dependencies. Source-exports avoids a build-order pipeline while the
packages are small; `tsc --noEmit` via root path mapping gives strict type safety, and
packages can gain dist builds when they stabilize.

**Consequences.** Runtime requires `tsx` (a devDependency of each Node app). Bundlers
(web) handle TS source natively.

## ADR-002 — PostgreSQL + Drizzle ORM

**Decision.** PostgreSQL as the durable store for workflow state. Drizzle ORM with
`drizzle-kit` migrations.

**Rationale.** Workflow state is relational (runs → stages → events → approvals) and must
survive process restarts. Drizzle is lightweight, TS-native, and produces explicit SQL
migrations — no runtime schema magic. `jsonb` columns hold the flexible per-run context.

**Consequences.** Migrations are checked in and applied explicitly (`pnpm db:migrate`);
the API/worker fail fast if the schema is behind.

## ADR-003 — PostgreSQL-backed task queue (event bus), Redis later

**Decision.** `TaskQueue` interface in `packages/event-bus`; Phase 1 ships an in-memory
adapter (tests) and a PostgreSQL adapter using `SELECT … FOR UPDATE SKIP LOCKED` with
attempts, backoff, and a dead-letter table.

**Rationale.** The prompt's development guidance names a PG-backed queue. It avoids a
second stateful dependency (Redis) while guaranteeing at-least-once delivery with
visibility timeouts. The interface is the contract; a Redis Streams adapter can be added
without touching the engine.

**Consequences.** Throughput is bounded by Postgres; the adapter is swappable when scale
demands it.

## ADR-004 — Custom workflow engine over YAML DAG definitions

**Decision.** Workflows are declarative YAML graphs (`workflows/*.yaml`): stages with
`agent`, `depends_on`, `parallel[]`, `type: approval`. The engine validates the DAG
(cycles, unknown agents), computes ready stages from persistent stage state, and executes.

**Rationale.** The prompt forbids hard-coding one workflow and forbids agents controlling
the flow. A validated DAG + persistent `stage_runs` gives resumability (a crashed run
resumes from the last completed stage), parallel fan-out, and configurable approval
gates without code changes.

**Consequences.** New workflow shapes require only YAML; new agent types require only a
registered agent + permissions.

## ADR-005 — Agents as versioned contracts with explicit permissions

**Decision.** `Agent` interface (`id/name/version`, `capabilities()`, `permissions()`,
`validate()`, `execute()`), an `AgentRegistry`, permission sets filtering the tool
surface, and a policy engine (configurable blocking rules) used by the engine's failure
handling and the quality gate.

**Rationale.** Agents are privileged automation: they must declare what they may touch,
and their exact version must be recorded per execution for audit/reproducibility. The
policy engine keeps blocking decisions deterministic and configurable per repository.

**Consequences.** Adding an agent is registering an object; no orchestration changes.

## ADR-006 — Fastify API with bearer-token auth in Phase 1

**Decision.** Fastify + zod validation + pino. Auth is a bearer token from
`ORCHESTRA_API_TOKEN` (documented in `.env.example`) enforced by a preHandler hook.

**Rationale.** Fastify's schema validation and plugin model fit the API surface;
bearer-token auth is the smallest mechanism that keeps the API non-anonymous, with a
clean upgrade path (JWT/OIDC) in Phase 8.

**Consequences.** Phase 1 tokens are shared secrets; rotate before any real deployment.

## ADR-007 — Consolidated packages

**Decision.** Integrations (GitHub/Jira/MCP) live in one `packages/integrations` until
they grow; policy + permissions live in `packages/agents`; the CLI is `apps/cli`.

**Rationale.** The prompt's suggested structure is honored in shape, but three
near-empty packages is speculative surface area. Consolidation is reversible — split
when an integration acquires real code (Phase 2 Jira, Phase 3 GitHub).

## ADR-008 — Vitest; integration tests against real Postgres, mocked externals

**Decision.** Vitest at the root. Unit tests (engine, policy, permissions, queue) always
run. Integration tests run against a real Postgres from Docker Compose; external
services (Jira, GitHub) are always mocked in CI.

**Rationale.** The queue's SKIP LOCKED semantics and the engine's resume behavior are
only provably correct against the real database. Mocked externals keep CI deterministic
and credential-free.
