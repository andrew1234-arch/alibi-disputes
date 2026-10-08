import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { LlmError, type Llm, type LlmRequest, type LlmResult } from "./llm";

// Anthropic adapter for the LLM port (the only network code in @alibi/agent
// besides the read-only PayPal client it's handed).
//
//   - Structured output: the zod schema is sent as the output format. We read
//     the reply ourselves, in order: refusal → truncation → JSON → zod. (The
//     SDK's parse() helper would throw a generic error on a truncated reply
//     before we could see stop_reason.)
//   - Thinking: adaptive (the default on current models); `effort` controls
//     depth. Current models reject sampling parameters, so there is no
//     temperature: repeatability comes from reusing the stored draft when the
//     case input is unchanged (agent/index.ts), and correctness from the checker.
//   - Refusals: on models that support it, the server-side fallback
//     (`fallbacks: "default"`) re-runs a declined request on Anthropic's
//     recommended substitute; the model that answered is returned and recorded.
//   - Errors: the SDK retries 429/5xx/connection errors once; API errors become
//     LlmError("api") and the agent falls back to the template drafter.
//     Anything else is a bug and propagates.

/** Models that accept `fallbacks: "default"` on the Claude API. */
const DEFAULT_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicLlmOptions {
  apiKey: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Tests inject a fake client. */
  client?: Anthropic;
}

export function createAnthropicLlm(opts: AnthropicLlmOptions): Llm {
  // Streamed (below), so a long thinking pass doesn't hit an HTTP idle timeout;
  // the 5-minute ceiling bounds a stuck request. The rebuild queue runs several
  // cases at once, so one slow case doesn't hold up the others.
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 1, timeout: 300_000 });
  const fallback = DEFAULT_FALLBACK_MODELS.has(opts.model);

  return {
    model: opts.model,
    async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      let res;
      try {
        res = await client.beta.messages
          .stream({
          model: opts.model,
          max_tokens: opts.maxTokens ?? 16_000,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          thinking: { type: "adaptive" },
          output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(req.schema) },
          ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
          })
          .finalMessage();
      } catch (e) {
        if (e instanceof Anthropic.APIError) throw new LlmError("api", `Anthropic API ${e.status ?? "error"}: ${e.message}`, req.purpose);
        throw e;
      }
      if (res.stop_reason === "refusal") {
        throw new LlmError("refusal", `the model declined (category ${res.stop_details?.category ?? "unspecified"})`, req.purpose);
      }
      if (res.stop_reason === "max_tokens") throw new LlmError("truncated", "output hit max_tokens", req.purpose);

      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmError("invalid_output", "reply is not JSON", req.purpose);
      }
      const checked = req.schema.safeParse(json);
      if (!checked.success) {
        throw new LlmError("invalid_output", checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), req.purpose);
      }
      return { output: checked.data, model: res.model };
    },
  };
}
