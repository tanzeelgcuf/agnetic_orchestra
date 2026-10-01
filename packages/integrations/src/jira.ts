/**
 * Jira adapter interface (Phase 2 implementation). Connects via REST and/or
 * MCP; the Requirements Agent consumes it through this interface only.
 */
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

/** Phase 2 ships a real REST/MCP adapter; this one backs tests and local dev. */
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
