import { NotFoundError, ValidationError } from "@orchestra/shared";
import type { PermissionSet } from "@orchestra/shared";
import type { Tool } from "./contract";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new ValidationError(`tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) throw new NotFoundError("tool", name);
    return tool;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * Filter the tool surface down to what a permission set allows. This filtered
   * list is what agents receive — never the full registry.
   */
  forPermissions(permissions: PermissionSet): Tool[] {
    return this.list().filter((tool) => {
      const dot = tool.name.indexOf(".");
      if (dot <= 0) return false;
      const resource = tool.name.slice(0, dot);
      const action = tool.name.slice(dot + 1);
      const allowed = permissions[resource];
      if (!allowed) return false;
      return allowed.includes("*") || allowed.includes(action);
    });
  }
}
