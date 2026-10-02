/**
 * Jira adapter. The Requirements Agent consumes Jira through this interface
 * only — REST (JiraRestAdapter, Phase 2) or a future MCP-backed
 * implementation. InMemoryJiraAdapter backs tests and local development.
 */
import type { ToolRegistry } from "@orchestra/agents";

export interface JiraIssue {
  key: string;
  summary: string;
  description?: string;
  type: string;
  status: string;
  labels?: string[];
  parentKey?: string;
}

export interface JiraAdapter {
  getIssue(key: string): Promise<JiraIssue | null>;
  searchIssues(jql: string): Promise<JiraIssue[]>;
  addComment(key: string, body: string): Promise<void>;
  updateIssue(
    key: string,
    fields: Partial<Pick<JiraIssue, "description" | "labels">>
  ): Promise<void>;
  createSubTask(parentKey: string, summary: string, description?: string): Promise<JiraIssue>;
}

/** In-memory double for tests and local development. */
export class InMemoryJiraAdapter implements JiraAdapter {
  readonly issues = new Map<string, JiraIssue>();
  readonly comments: { key: string; body: string }[] = [];
  private nextSubTask = 1;

  async getIssue(key: string): Promise<JiraIssue | null> {
    return this.issues.get(key) ?? null;
  }

  async searchIssues(_jql: string): Promise<JiraIssue[]> {
    return [...this.issues.values()];
  }

  async addComment(key: string, body: string): Promise<void> {
    this.comments.push({ key, body });
  }

  async updateIssue(
    key: string,
    fields: Partial<Pick<JiraIssue, "description" | "labels">>
  ): Promise<void> {
    const issue = this.issues.get(key);
    if (!issue) return;
    Object.assign(issue, fields);
  }

  async createSubTask(parentKey: string, summary: string, description?: string): Promise<JiraIssue> {
    const key = `${parentKey}-${this.nextSubTask++}`;
    const issue: JiraIssue = {
      key,
      summary,
      description,
      type: "subtask",
      status: "todo",
      parentKey
    };
    this.issues.set(key, issue);
    return issue;
  }
}

/** Jira Cloud REST API v3 (Basic auth email:token). */
export class JiraRestAdapter implements JiraAdapter {
  private readonly authHeader: string;

  constructor(
    private readonly baseUrl: string,
    email: string,
    apiToken: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  async getIssue(key: string): Promise<JiraIssue | null> {
    const body = await this.request<{ key?: string; fields?: Record<string, unknown> }>(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,labels,issuetype,parent`
    );
    if (!body?.fields) return null;
    return {
      key: body.key ?? key,
      summary: str(body.fields.summary) ?? "",
      description: str(body.fields.description) ?? plainTextFromAdf(body.fields.description),
      type: str((body.fields.issuetype as { name?: string } | undefined)?.name) ?? "unknown",
      status: str((body.fields.status as { name?: string } | undefined)?.name) ?? "unknown",
      labels: Array.isArray(body.fields.labels) ? body.fields.labels.map(String) : [],
      parentKey: str((body.fields.parent as { key?: string } | undefined)?.key) ?? undefined
    };
  }

  async searchIssues(jql: string): Promise<JiraIssue[]> {
    const body = await this.request<{ issues?: Record<string, unknown>[] }>(
      `/rest/api/3/search?jql=${encodeURIComponent(jql)}`
    );
    return (body?.issues ?? []).map((raw) => {
      const fields = (raw.fields ?? {}) as Record<string, unknown>;
      return {
        key: str(raw.key) ?? "",
        summary: str(fields.summary) ?? "",
        type: str((fields.issuetype as { name?: string } | undefined)?.name) ?? "unknown",
        status: str((fields.status as { name?: string } | undefined)?.name) ?? "unknown"
      };
    });
  }

  async addComment(key: string, body: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: adfParagraph(body) })
    });
  }

  async updateIssue(
    key: string,
    fields: Partial<Pick<JiraIssue, "description" | "labels">>
  ): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (fields.description !== undefined) {
      payload.description = adfParagraph(fields.description);
    }
    if (fields.labels !== undefined) {
      payload.labels = fields.labels;
    }
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ fields: payload })
    });
  }

  async createSubTask(parentKey: string, summary: string, description?: string): Promise<JiraIssue> {
    const body = await this.request<{ key: string }>("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: parentKey.split("-")[0] ?? parentKey },
          parent: { key: parentKey },
          issuetype: { name: "Subtask" },
          summary,
          ...(description !== undefined ? { description: adfParagraph(description) } : {})
        }
      })
    });
    return {
      key: body?.key ?? "",
      summary,
      description,
      type: "subtask",
      status: "todo",
      parentKey
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T | null> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {})
      }
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`jira ${init?.method ?? "GET"} ${path} failed: HTTP ${res.status}`);
    }
    if (res.status === 204) return null;
    return (await res.json()) as T;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Flatten an Atlassian Document Format doc to plain text. */
function plainTextFromAdf(doc: unknown): string {
  if (typeof doc === "string") return doc;
  if (!doc || typeof doc !== "object") return "";
  const node = doc as { text?: unknown; content?: unknown };
  let out = "";
  if (typeof node.text === "string") out += node.text;
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      out += plainTextFromAdf(child) + "\n";
    }
  }
  return out.trimEnd();
}

function adfParagraph(text: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }]
      }
    ]
  };
}

/**
 * Register a Jira adapter's operations as tools. The engine passes these
 * permission-filtered to agents — an agent's permission set decides which of
 * these it actually receives.
 */
export function registerJiraTools(registry: ToolRegistry, jira: JiraAdapter): void {
  registry.register({
    name: "jira.get_issue",
    description: "Fetch a Jira issue by key",
    execute: async (input) => {
      const key = (input as { key?: unknown }).key;
      if (typeof key !== "string") throw new Error("jira.get_issue requires a string key");
      return jira.getIssue(key);
    }
  });
  registry.register({
    name: "jira.add_comment",
    description: "Add a comment to a Jira issue",
    execute: async (input) => {
      const { key, body } = input as { key?: unknown; body?: unknown };
      if (typeof key !== "string" || typeof body !== "string") {
        throw new Error("jira.add_comment requires string key and body");
      }
      await jira.addComment(key, body);
      return { ok: true };
    }
  });
  registry.register({
    name: "jira.update_issue",
    description: "Update Jira issue fields (description, labels)",
    execute: async (input) => {
      const { key, description, labels } = input as {
        key?: unknown;
        description?: unknown;
        labels?: unknown;
      };
      if (typeof key !== "string") throw new Error("jira.update_issue requires a string key");
      await jira.updateIssue(key, {
        ...(typeof description === "string" ? { description } : {}),
        ...(Array.isArray(labels) ? { labels: labels.map(String) } : {})
      });
      return { ok: true };
    }
  });
}
