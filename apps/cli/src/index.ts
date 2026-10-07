#!/usr/bin/env node
import { Command } from "commander";

const API_URL = process.env.ORCHESTRA_API_URL ?? "http://localhost:4100";
const TOKEN = process.env.ORCHESTRA_API_TOKEN ?? "dev-token-change-me";

interface ApiError {
  error?: string;
  message?: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(init?.headers ?? {})
    }
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body as ApiError;
    throw new Error(`HTTP ${res.status}${err.error ? ` ${err.error}` : ""}: ${err.message ?? res.statusText}`);
  }
  return body as T;
}

const program = new Command();
program.name("orchestra").description("Agentic Software Development Orchestra CLI").version("0.1.0");

const workflow = program.command("workflow").description("Workflow operations");

workflow
  .command("start")
  .description("Start a workflow run")
  .argument("<definition>", "workflow definition name, e.g. software-delivery")
  .option("--context <json>", "initial workflow context as JSON", "{}")
  .action(async (definition: string, opts: { context: string }) => {
    let context: Record<string, unknown>;
    try {
      context = JSON.parse(opts.context) as Record<string, unknown>;
    } catch {
      throw new Error("--context must be valid JSON");
    }
    const run = await api<{ id: string; definition: string; status: string }>("/workflows", {
      method: "POST",
      body: JSON.stringify({ definition, context })
    });
    console.log(`started workflow ${run.id} (${run.definition}) status=${run.status}`);
  });

  workflow
    .command("dlq replay")
    .description("Replay dead-lettered messages back to pending")
    .action(async () => {
      const replayed = await api<{ ok: boolean; replayed: number }>("/queue/dlq/replay", {
        method: "POST"
      });
      console.log(`replayed ${replayed.replayed} dead message(s)`);
    });

workflow
  .command("status")
  .description("Show workflow run status with stage timeline")
  .argument("<id>", "workflow run id")
  .action(async (id: string) => {
    const detail = await api<{
      run: { id: string; definition: string; status: string };
      stages: {
        stageId: string;
        agent: string;
        kind: string;
        status: string;
        attempts: number;
      }[];
    }>(`/workflows/${id}`);
    console.log(`${detail.run.definition} ${detail.run.id} — ${detail.run.status}`);
    for (const stage of detail.stages) {
      const mark =
        stage.status === "succeeded"
          ? "✓"
          : stage.status === "failed" || stage.status === "blocked"
            ? "✗"
            : stage.status === "awaiting_approval"
              ? "●"
              : stage.status === "running"
                ? "▶"
                : "○";
      console.log(`  ${mark} ${stage.stageId.padEnd(24)} ${stage.agent.padEnd(22)} ${stage.status}${stage.attempts > 1 ? ` (attempt ${stage.attempts})` : ""}`);
    }
  });

workflow
  .command("approve")
  .description("Approve or reject a pending approval stage")
  .argument("<id>", "workflow run id")
  .requiredOption("--stage <stageId>", "approval stage id")
  .option("--by <who>", "who is approving", "cli")
  .option("--reject", "reject instead of approve")
  .option("--note <note>", "decision note")
  .action(async (id: string, opts: { stage: string; by: string; reject?: boolean; note?: string }) => {
    const decision = opts.reject ? "rejected" : "approved";
    await api(`/workflows/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        stageId: opts.stage,
        decision,
        approvedBy: opts.by,
        note: opts.note
      })
    });
    console.log(`${decision} ${opts.stage} on ${id}`);
  });

workflow
  .command("cancel")
  .description("Cancel a workflow run")
  .argument("<id>", "workflow run id")
  .action(async (id: string) => {
    await api(`/workflows/${id}/cancel`, { method: "POST" });
    console.log(`cancelled ${id}`);
  });

workflow
  .command("logs")
  .description("Show the event log for a workflow run")
  .argument("<id>", "workflow run id")
  .action(async (id: string) => {
    const { events } = await api<{
      events: { type: string; stageId?: string; createdAt: string; data?: unknown }[];
    }>(`/workflows/${id}/events`);
    for (const event of events) {
      const stage = event.stageId ? ` [${event.stageId}]` : "";
      console.log(`${event.createdAt}  ${event.type}${stage}`);
    }
  });

const agent = program.command("agent").description("Agent operations");

agent
  .command("list")
  .description("List registered agents")
  .action(async () => {
    const { agents } = await api<{
      agents: {
        id: string;
        name: string;
        version: string;
        description?: string;
        capabilities: string[];
        permissions: Record<string, string[]>;
      }[];
    }>("/agents");
    for (const a of agents) {
      console.log(`${a.id}@${a.version} — ${a.name}`);
      console.log(`  capabilities: ${a.capabilities.join(", ") || "none"}`);
      const perms = Object.entries(a.permissions)
        .map(([resource, actions]) => `${resource}: ${actions.join(", ")}`)
        .join(" | ");
      console.log(`  permissions: ${perms || "none"}`);
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
