import { z } from "zod";
import { parse } from "yaml";
import { ValidationError } from "@orchestra/shared";

const RawStageSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["agent", "approval", "parallel"]).default("agent"),
  agent: z.string().min(1).optional(),
  parallel: z.array(z.string().min(1)).optional(),
  depends_on: z.array(z.string().min(1)).default([]),
  max_attempts: z.number().int().positive().max(10).default(3),
  timeout_ms: z.number().int().positive().default(300_000),
  input: z.record(z.unknown()).default({}),
  /** Failure edge (§49 fix-iterate): on failure, reset this stage + its
   * dependents back to pending and re-run, bounded by max_rework. */
  rework_to: z.string().min(1).optional(),
  max_rework: z.number().int().nonnegative().max(5).default(1)
});

const RawDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  stages: z.array(RawStageSchema).min(1)
});

export interface StageDefinition {
  id: string;
  type: "agent" | "approval" | "barrier";
  agent?: string;
  depends_on: string[];
  max_attempts: number;
  timeout_ms: number;
  input: Record<string, unknown>;
  rework_to?: string;
  max_rework: number;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  stages: StageDefinition[];
}

/**
 * Parse a workflow YAML definition. `parallel` groups expand into concrete
 * agent stages (`<group>:<agent-id>`) plus a synthetic barrier stage carrying
 * the group's id, so downstream `depends_on: [group]` references work naturally.
 */
export function parseWorkflowDefinition(yaml: string): WorkflowDefinition {
  let raw: unknown;
  try {
    raw = parse(yaml);
  } catch (e) {
    throw new ValidationError(`invalid workflow YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = RawDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(`invalid workflow definition: ${parsed.error.message}`);
  }
  const rawDef = parsed.data;
  const stages: StageDefinition[] = [];

  for (const stage of rawDef.stages) {
    if (stage.type === "parallel") {
      if (!stage.parallel || stage.parallel.length === 0) {
        throw new ValidationError(`parallel stage "${stage.id}" must list at least one agent`);
      }
      const parallel = stage.parallel;
      const duplicates = parallel.filter((a, i) => parallel.indexOf(a) !== i);
      if (duplicates.length > 0) {
        throw new ValidationError(
          `parallel stage "${stage.id}" lists duplicate agents: ${[...new Set(duplicates)].join(", ")}`
        );
      }
      for (const agentId of stage.parallel) {
        stages.push({
          id: `${stage.id}:${agentId}`,
          type: "agent",
          agent: agentId,
          depends_on: [...stage.depends_on],
          max_attempts: stage.max_attempts,
          timeout_ms: stage.timeout_ms,
          input: stage.input,
          max_rework: stage.max_rework
        });
      }
      stages.push({
        id: stage.id,
        type: "barrier",
        depends_on: stage.parallel.map((a) => `${stage.id}:${a}`),
        max_attempts: 1,
        timeout_ms: stage.timeout_ms,
        input: {},
        max_rework: 0
      });
      continue;
    }

    if (stage.type === "agent" && !stage.agent) {
      throw new ValidationError(`stage "${stage.id}" must specify an agent`);
    }
    if (stage.type !== "agent" && stage.rework_to) {
      throw new ValidationError(`rework_to is only valid on agent stages ("${stage.id}")`);
    }
    stages.push({
      id: stage.id,
      type: stage.type,
      agent: stage.agent,
      depends_on: [...stage.depends_on],
      max_attempts: stage.max_attempts,
      timeout_ms: stage.timeout_ms,
      input: stage.input,
      ...(stage.rework_to !== undefined ? { rework_to: stage.rework_to } : {}),
      max_rework: stage.max_rework
    });
  }

  return { name: rawDef.name, description: rawDef.description, stages };
}
