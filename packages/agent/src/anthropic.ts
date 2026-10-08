import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { LlmError, type Llm, type LlmRequest } from "./llm";

// Anthropic adapter for the LLM port (the only network code in @alibi/agent
// besides the read-only PayPal client it's handed).
//
//   - Structured output: the zod schema is sent as the output format, and the
//     SDK parses the reply; we re-validate with the same schema anyway (CLAUDE §1.6).
//   - Thinking: adaptive (the default on current models); `effort` controls depth.
//     Strategy and drafting are judgment work, so "medium" by default.
//   - Refusals: checked before reading content. On models that support it, the
//     server-side fallback (`fallbacks: "default"`) re-runs a declined request on
//     Anthropic's recommended substitute model.
//   - Errors: the SDK retries 429/5xx/connection errors itself (maxRetries);
//     whatever still fails becomes an LlmError and the agent falls back to the
//     template drafter.

/** Models that accept `fallbacks: "default"` on the Claude API. */
const DEFAULT_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicLlmOptions {
  apiKey: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Tests inject a client pointed at a stub. */
  client?: Anthropic;
}

export function createAnthropicLlm(opts: AnthropicLlmOptions): Llm {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 120_000 });
  const fallback = DEFAULT_FALLBACK_MODELS.has(opts.model);

  return {
    model: opts.model,
    async complete<T>(req: LlmRequest<T>): Promise<T> {
      let res;
      try {
        res = await client.beta.messages.parse({
          model: opts.model,
          max_tokens: opts.maxTokens ?? 16_000,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          thinking: { type: "adaptive" },
          output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(req.schema) },
          ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
        });
      } catch (e) {
        if (e instanceof LlmError) throw e;
        // The SDK throws on a reply that doesn't parse against the schema.
        if (e instanceof Anthropic.APIError) throw new LlmError("api", `${req.purpose}: Anthropic API ${e.status ?? "error"}: ${e.message}`);
        throw new LlmError("invalid_output", `${req.purpose}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.stop_reason === "refusal") {
        const category = res.stop_details?.category ?? "unspecified";
        throw new LlmError("refusal", `${req.purpose}: the model declined (category ${category})`);
      }
      if (res.stop_reason === "max_tokens") throw new LlmError("truncated", `${req.purpose}: output hit max_tokens`);
      const checked = req.schema.safeParse(res.parsed_output);
      if (!checked.success) {
        throw new LlmError("invalid_output", `${req.purpose}: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }
      return checked.data;
    },
  };
}
