/**
 * Secret resolution for integrations. Secrets NEVER live in prompts, agent
 * context, database records, or logs — they are resolved at use time from a
 * provider. EnvSecretProvider is the Phase 1–3 mechanism; Vault/Cloud
 * providers implement the same interface later.
 */
export interface SecretProvider {
  getSecret(name: string): string | undefined;
}

export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  getSecret(name: string): string | undefined {
    const value = this.env[name];
    return value && value.length > 0 ? value : undefined;
  }
}
