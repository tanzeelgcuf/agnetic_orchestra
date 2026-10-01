import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "@orchestra/shared";
import type { AgentRegistry } from "@orchestra/agents";
import { parseWorkflowDefinition } from "./definition";
import type { WorkflowDefinition } from "./definition";
import { validateGraph } from "./graph";

/**
 * Load and validate every YAML workflow definition in a directory. Invalid
 * definitions throw — a broken workflow must never silently register.
 */
export function loadWorkflows(
  dir: string,
  registry: AgentRegistry
): Record<string, WorkflowDefinition> {
  const definitions: Record<string, WorkflowDefinition> = {};
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    throw new ValidationError(`cannot read workflows directory "${dir}"`);
  }
  if (files.length === 0) {
    throw new ValidationError(`no workflow definitions found in "${dir}"`);
  }

  for (const file of files) {
    const yaml = readFileSync(join(dir, file), "utf8");
    const def = parseWorkflowDefinition(yaml);
    const validation = validateGraph(def, registry);
    if (!validation.ok) {
      throw new ValidationError(
        `workflow "${def.name}" (${file}) failed validation: ${validation.errors.join("; ")}`
      );
    }
    if (definitions[def.name]) {
      throw new ValidationError(`duplicate workflow name "${def.name}" (${file})`);
    }
    definitions[def.name] = def;
  }

  return definitions;
}
