import Anthropic from "@anthropic-ai/sdk";

/** Token usage from an LLM completion (cost controls, Phase 8). */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export type LlmClientResponse = {
  text: string;
  usage: LlmUsage;
};

/**
 * LLM reasoning surface for agents. Deterministic checks never depend on this;
 * agents use it where reasoning is useful (requirements analysis, review
 * triage). Implementations: AnthropicLlmClient (official SDK); tests inject
 * fakes.
 */
export interface LlmClient {
  complete(opts: { system: string; user: string; maxTokens?: number }): Promise<LlmClientResponse>;
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
  }): Promise<LlmClientResponse> {
    const response = await this.client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: opts.maxTokens ?? 16000,
      thinking: { type: "adaptive" },
      system: opts.system,
      messages: [{ role: "user", content: opts.user }]
    });
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const usage: LlmUsage = {
      promptTokens: response.usage.input_tokens ?? 0,
      completionTokens: response.usage.output_tokens ?? 0
    };
    return { text, usage };
  }
}
