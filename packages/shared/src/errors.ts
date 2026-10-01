export class OrchestraError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "OrchestraError";
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends OrchestraError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends OrchestraError {
  constructor(resource: string, id: string) {
    super("NOT_FOUND", `${resource} ${id} not found`, { resource, id });
    this.name = "NotFoundError";
  }
}

export class PolicyViolationError extends OrchestraError {
  constructor(message: string, details?: unknown) {
    super("POLICY_VIOLATION", message, details);
    this.name = "PolicyViolationError";
  }
}
