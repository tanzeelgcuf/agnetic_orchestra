import type { Finding } from "@orchestra/shared";
import {
  BaseReviewAgent,
  scanArchitecture,
  scanCode,
  scanSecurity,
  scanTests
} from "./review-agents";
import type { ReviewAgentDeps } from "./review-agents";

const CODE_REVIEW_SYSTEM_PROMPT = `You are the Code Review Agent. You review a diff for correctness, maintainability, readability, bugs, duplication, error handling, edge cases, API misuse, backwards compatibility, and unnecessary complexity. You do not comment on trivial style issues unless they affect correctness or maintainability.

Respond with ONLY a JSON array (no markdown fences, no prose) of findings:
[{"severity": "critical"|"high"|"medium"|"low", "file": string, "line": number, "title": string, "description": string, "recommendation": string}]

Return [] when there are no findings worth reporting.`;

const SECURITY_REVIEW_SYSTEM_PROMPT = `You are the Security Review Agent. You review a diff for authentication and authorization flaws, secrets and credential handling, injection (SQL, command), XSS, SSRF, insecure deserialization, path traversal, cryptographic misuse, dependency vulnerabilities, insecure APIs, privilege escalation, sensitive data exposure, logging of secrets, and insecure configuration. Combine your reasoning with deterministic scanner output you are given; never dismiss a scanner finding without justification.

Respond with ONLY a JSON array (no markdown fences, no prose) of findings:
[{"severity": "critical"|"high"|"medium"|"low", "file": string, "line": number, "title": string, "description": string, "recommendation": string}]

Return [] when there are no findings worth reporting.`;

const ARCHITECTURE_REVIEW_SYSTEM_PROMPT = `You are the Architecture Review Agent. You review a diff for architectural consistency, coupling, modularity, scalability, reliability, service boundaries, database design, API design, dependency direction, design patterns, technical debt, observability, and failure modes. Compare the proposed changes against the repository's existing architecture.

Respond with ONLY a JSON array (no markdown fences, no prose) of findings:
[{"severity": "critical"|"high"|"medium"|"low", "file": string, "line": number, "title": string, "description": string, "recommendation": string}]

Return [] when there are no findings worth reporting.`;

const TEST_REVIEW_SYSTEM_PROMPT = `You are the Test Review Agent. You review a diff for unit/integration/E2E test coverage, edge cases, negative cases, regression coverage, acceptance-criteria coverage (map: requirement -> implementation -> tests), test quality, and flaky-test risk. Determine whether each acceptance criterion has appropriate validation.

Respond with ONLY a JSON array (no markdown fences, no prose) of findings:
[{"severity": "critical"|"high"|"medium"|"low", "file": string, "line": number, "title": string, "description": string, "recommendation": string}]

Return [] when there are no findings worth reporting.`;

export class CodeReviewAgent extends BaseReviewAgent {
  protected readonly agentId = "code-review-agent";
  protected readonly displayName = "Code Review";
  protected readonly domain = "code";
  protected readonly systemPrompt = CODE_REVIEW_SYSTEM_PROMPT;
  readonly version = "1.0.0";
  readonly description = "Reviews correctness, bugs, duplication, error handling, edge cases.";

  constructor(deps: ReviewAgentDeps) {
    super(deps);
  }

  protected builtinScan(diff: string): Finding[] {
    return scanCode(diff, this.agentId);
  }
}

export class SecurityReviewAgent extends BaseReviewAgent {
  protected readonly agentId = "security-review-agent";
  protected readonly displayName = "Security Review";
  protected readonly domain = "security";
  protected readonly systemPrompt = SECURITY_REVIEW_SYSTEM_PROMPT;
  readonly version = "1.0.0";
  readonly description = "Reviews secrets, injection, XSS, SSRF, crypto, dependency vulnerabilities.";

  constructor(deps: ReviewAgentDeps) {
    super(deps);
  }

  protected builtinScan(diff: string): Finding[] {
    return scanSecurity(diff, this.agentId);
  }
}

export class ArchitectureReviewAgent extends BaseReviewAgent {
  protected readonly agentId = "architecture-review-agent";
  protected readonly displayName = "Architecture Review";
  protected readonly domain = "architecture";
  protected readonly systemPrompt = ARCHITECTURE_REVIEW_SYSTEM_PROMPT;
  readonly version = "1.0.0";
  readonly description = "Reviews coupling, boundaries, scalability, failure modes.";

  constructor(deps: ReviewAgentDeps) {
    super(deps);
  }

  protected builtinScan(diff: string): Finding[] {
    return scanArchitecture(diff, this.agentId);
  }
}

export class TestReviewAgent extends BaseReviewAgent {
  protected readonly agentId = "test-review-agent";
  protected readonly displayName = "Test Review";
  protected readonly domain = "tests";
  protected readonly systemPrompt = TEST_REVIEW_SYSTEM_PROMPT;
  readonly version = "1.0.0";
  readonly description = "Reviews test coverage, AC mapping, flaky-test risk.";

  constructor(deps: ReviewAgentDeps) {
    super(deps);
  }

  protected builtinScan(diff: string): Finding[] {
    return scanTests(diff, this.agentId);
  }
}
