/**
 * Secret resolution for integrations. Secrets NEVER live in prompts, agent
 * context, database records, or logs — they are resolved at use time from a
 * provider. EnvSecretProvider is the Phase 1–3 mechanism; VaultProvider
 * (Phase 8) fetches from a Vault KV v2 HTTP API.
 */
export interface SecretProvider {
  getSecret(name: string): Promise<string | undefined>;
}

export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  getSecret(name: string): Promise<string | undefined> {
    const value = this.env[name];
    return Promise.resolve(value && value.length > 0 ? value : undefined);
  }
}

/**
 * Vault KV v2 provider (Phase 8). Fetches secrets over the Vault HTTP API at
 * use time; nothing is cached. Requires VAULT_ADDR and VAULT_TOKEN to be set.
 */
export class VaultProvider implements SecretProvider {
  constructor(
    private readonly addr: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getSecret(name: string): Promise<string | undefined> {
    const url = `${this.addr.replace(/\/$/, "")}/v1/secret/data/${name}`;
    const res = await this.fetchImpl(url, {
      headers: { "X-Vault-Token": this.token }
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      data?: { data?: Record<string, string> };
    };
    return body.data?.data?.value;
  }
}

/**
 * Select the secret provider from configuration: "env" (default) or "vault".
 */
export function createSecretProvider(config: {
  backend?: string;
  vaultAddr?: string;
  vaultToken?: string;
}): SecretProvider {
  if (config.backend === "vault") {
    if (!config.vaultAddr || !config.vaultToken) {
      throw new Error("vault backend requires ORCHESTRA_VAULT_ADDR and ORCHESTRA_VAULT_TOKEN");
    }
    return new VaultProvider(config.vaultAddr, config.vaultToken);
  }
  return new EnvSecretProvider();
}
