import { NotFoundError, ValidationError } from "@orchestra/shared";
import type { Agent } from "./contract";

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  register(agent: Agent): void {
    if (this.agents.has(agent.id)) {
      throw new ValidationError(`agent "${agent.id}" is already registered`);
    }
    this.agents.set(agent.id, agent);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  get(id: string): Agent {
    const agent = this.agents.get(id);
    if (!agent) throw new NotFoundError("agent", id);
    return agent;
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }
}
