import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  extractIssueKey,
  parseGitHubWebhook,
  verifyWebhookSignature
} from "@orchestra/integrations";

function sign(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("webhook signature verification", () => {
  const secret = "whsec-test";
  const payload = JSON.stringify({ action: "opened" });

  it("accepts a valid signature", () => {
    expect(verifyWebhookSignature(payload, sign(payload, secret), secret)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const tampered = JSON.stringify({ action: "opened", evil: true });
    expect(verifyWebhookSignature(tampered, sign(payload, secret), secret)).toBe(false);
  });

  it("rejects a signature from a different secret", () => {
    expect(verifyWebhookSignature(payload, sign(payload, "other"), secret)).toBe(false);
  });

  it("rejects a missing or malformed signature header", () => {
    expect(verifyWebhookSignature(payload, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(payload, "sha1=abc", secret)).toBe(false);
    expect(verifyWebhookSignature(payload, "sha256=", secret)).toBe(false);
  });
});

describe("webhook event parsing", () => {
  it("parses pull_request.opened with traceability", () => {
    const event = parseGitHubWebhook("pull_request", {
      action: "opened",
      repository: { owner: { login: "acme" }, name: "api" },
      pull_request: {
        number: 7,
        title: "PROJ-123: add password reset",
        state: "open",
        head: { ref: "proj-123-password-reset", sha: "abc123" },
        base: { ref: "main" },
        html_url: "https://github.com/acme/api/pull/7"
      }
    });
    expect(event.kind).toBe("pull_request");
    expect(event.action).toBe("opened");
    expect(event.repository).toEqual({ owner: "acme", name: "api" });
    expect(event.pullRequest?.number).toBe(7);
    expect(event.branch).toBe("proj-123-password-reset");
    expect(event.issueKey).toBe("PROJ-123");
  });

  it("parses pull_request.synchronize and closed", () => {
    const sync = parseGitHubWebhook("pull_request", { action: "synchronize", pull_request: { number: 7 } });
    expect(sync.action).toBe("synchronize");
    const closed = parseGitHubWebhook("pull_request", {
      action: "closed",
      pull_request: { number: 7, merged: true }
    });
    expect(closed.action).toBe("closed");
  });

  it("parses push with branch extraction", () => {
    const event = parseGitHubWebhook("push", {
      ref: "refs/heads/PROJ-456-feature",
      after: "deadbeef"
    });
    expect(event.kind).toBe("push");
    expect(event.branch).toBe("PROJ-456-feature");
    expect(event.headSha).toBe("deadbeef");
    expect(event.issueKey).toBe("PROJ-456");
  });

  it("parses workflow_run.completed with conclusion", () => {
    const event = parseGitHubWebhook("workflow_run", {
      action: "completed",
      workflow_run: { head_sha: "abc", head_branch: "main", conclusion: "success" }
    });
    expect(event.kind).toBe("workflow_run");
    expect(event.action).toBe("completed");
    expect(event.conclusion).toBe("success");
  });

  it("maps unknown events to kind unknown without throwing", () => {
    const event = parseGitHubWebhook("mystery_event", { anything: true });
    expect(event.kind).toBe("unknown");
  });

  it("tolerates missing payload fields", () => {
    const event = parseGitHubWebhook("pull_request", {});
    expect(event.kind).toBe("pull_request");
    expect(event.pullRequest?.number).toBe(0);
    expect(event.issueKey).toBeUndefined();
  });
});

describe("traceability extraction", () => {
  it("extracts issue keys from branch, commit, and PR title", () => {
    expect(extractIssueKey("feature/PROJ-123-x")).toBe("PROJ-123");
    expect(extractIssueKey("fix ABC-9 crash")).toBe("ABC-9");
    expect(extractIssueKey("no key here")).toBeUndefined();
    expect(extractIssueKey(undefined, "fallback/XYZ-1")).toBe("XYZ-1");
  });
});
