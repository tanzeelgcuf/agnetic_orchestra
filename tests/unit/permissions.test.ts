import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@orchestra/agents";
import type { Tool } from "@orchestra/agents";

function tool(name: string): Tool {
  return { name, description: name, execute: async () => undefined };
}

describe("tool registry permissions", () => {
  it("filters tools by resource and action", () => {
    const registry = new ToolRegistry();
    registry.register(tool("jira.read_issue"));
    registry.register(tool("jira.update_issue"));
    registry.register(tool("github.create_pull_request"));

    const allowed = registry.forPermissions({ jira: ["read_issue"] });
    expect(allowed.map((t) => t.name)).toEqual(["jira.read_issue"]);
  });

  it("supports wildcard resource access", () => {
    const registry = new ToolRegistry();
    registry.register(tool("jira.read_issue"));
    registry.register(tool("jira.update_issue"));
    registry.register(tool("github.create_pull_request"));

    const allowed = registry.forPermissions({ github: ["*"] });
    expect(allowed.map((t) => t.name)).toEqual(["github.create_pull_request"]);
  });

  it("returns nothing for agents with no permissions (least privilege)", () => {
    const registry = new ToolRegistry();
    registry.register(tool("jira.read_issue"));
    expect(registry.forPermissions({})).toEqual([]);
  });

  it("ignores malformed tool names", () => {
    const registry = new ToolRegistry();
    registry.register(tool("noNamespace"));
    expect(registry.forPermissions({ noNamespace: ["*"] })).toEqual([]);
  });
});
