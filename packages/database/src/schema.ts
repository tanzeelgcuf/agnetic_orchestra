import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  bigserial,
  index,
  uniqueIndex
} from "drizzle-orm/pg-core";

export const workflowRuns = pgTable("workflow_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  definition: text("definition").notNull(),
  status: text("status").notNull().default("pending"),
  context: jsonb("context").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const stageRuns = pgTable(
  "stage_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stageId: text("stage_id").notNull(),
    agent: text("agent").notNull(),
    agentVersion: text("agent_version").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("stage_runs_run_id_idx").on(t.runId),
    // One stage run per (run, stage): concurrent engine advances race on
    // creation; the unique index + conflict-refetch keeps them idempotent.
    uniqueIndex("stage_runs_run_stage_idx").on(t.runId, t.stageId)
  ]
);

export const workflowEvents = pgTable(
  "workflow_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id").notNull(),
    stageId: text("stage_id"),
    type: text("type").notNull(),
    data: jsonb("data"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("workflow_events_run_id_idx").on(t.runId)]
);

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  stageId: text("stage_id").notNull(),
  decision: text("decision").notNull().default("pending"),
  approvedBy: text("approved_by"),
  note: text("note"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true })
});

export const queueMessages = pgTable(
  "queue_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("queue_messages_status_idx").on(t.status, t.availableAt)]
);

export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  resource: text("resource").notNull(),
  data: jsonb("data"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    deliveryId: text("delivery_id").notNull(),
    event: text("event").notNull(),
    action: text("action"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("webhook_deliveries_source_idx").on(t.source, t.deliveryId)]
);
