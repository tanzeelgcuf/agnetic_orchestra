/**
 * MCP (Model Context Protocol) adapter interface. MCP tools are capabilities:
 * the bridge surfaces remote MCP tools as Tool objects that flow through the
 * permission-filtered ToolRegistry — business logic never couples to a
 * particular MCP implementation.
 */
export interface McpServerRef {
  name: string;
  command?: string;
  url?: string;
}

export interface McpToolDescriptor {
  /** Fully-qualified tool name: `${serverName}.${toolName}`. */
  name: string;
  description: string;
}

export interface McpAdapter {
  connect(server: McpServerRef): Promise<void>;
  listTools(serverName: string): Promise<McpToolDescriptor[]>;
  callTool(name: string, input: unknown): Promise<unknown>;
  disconnect(serverName: string): Promise<void>;
}
