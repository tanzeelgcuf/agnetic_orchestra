import Anthropic from "@anthropic-ai/sdk";

/**
 * LLM reasoning surface for agents. Deterministic checks never depend on this;
 * agents use it where reasoning is useful (requirements analysis, review
 * triage). Implementations: AnthropicLlmClient (official SDK); tests inject
 * fakes.
 */
export interface LlmClient {
  complete(opts: { system: string; user: string; maxTokens?: number }): Promise<string>;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  async complete(opts: {
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<string> {
    const response = await this.client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: opts.maxTokens ?? 16000,
      thinking: { type: "adaptive" },
      system: opts.system,
      messages: [{ role: "user", content: opts.user }]
    });
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
}
