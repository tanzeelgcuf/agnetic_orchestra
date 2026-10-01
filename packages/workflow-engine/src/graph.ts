import type { AgentRegistry } from "@orchestra/agents";
import type { StageDefinition, WorkflowDefinition } from "./definition";

export interface GraphValidation {
  ok: boolean;
  errors: string[];
  /** Topological order of stage ids (only meaningful when ok). */
  order: string[];
}

function topologicalOrder(stages: StageDefinition[]): { order: string[]; cycles: string[][] } {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const state = new Map<string, "visiting" | "done">();
  const order: string[] = [];
  const cycles: string[][] = [];
  const path: string[] = [];

  const visit = (id: string): void => {
    const st = state.get(id);
    if (st === "done") return;
    if (st === "visiting") {
      cycles.push([...path.slice(path.indexOf(id)), id]);
      return;
    }
    state.set(id, "visiting");
    path.push(id);
    const stage = byId.get(id);
    for (const dep of stage?.depends_on ?? []) {
      if (byId.has(dep)) visit(dep);
    }
    path.pop();
    state.set(id, "done");
    order.push(id);
  };

  for (const stage of stages) visit(stage.id);
  return { order, cycles };
}

/**
 * Validate a workflow definition against structural rules and the agent
 * registry: unique stage ids, resolvable depends_on references, no cycles,
 * agent stages name a registered agent.
 */
export function validateGraph(def: WorkflowDefinition, registry: AgentRegistry): GraphValidation {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const stage of def.stages) {
    if (ids.has(stage.id)) errors.push(`duplicate stage id "${stage.id}"`);
    ids.add(stage.id);
  }

  for (const stage of def.stages) {
    for (const dep of stage.depends_on) {
      if (!ids.has(dep)) errors.push(`stage "${stage.id}" depends on unknown stage "${dep}"`);
    }
    if (stage.type === "agent" && !stage.agent) {
      errors.push(`agent stage "${stage.id}" does not name an agent`);
    }
    if (stage.type === "agent" && stage.agent && !registry.has(stage.agent)) {
      errors.push(`stage "${stage.id}" references unregistered agent "${stage.agent}"`);
    }
  }

  const { order, cycles } = topologicalOrder(def.stages);
  for (const cycle of cycles) {
    errors.push(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  return { ok: errors.length === 0, errors, order };
}
