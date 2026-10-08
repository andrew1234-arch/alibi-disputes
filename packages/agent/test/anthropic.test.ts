import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createAnthropicLlm } from "../src/anthropic";
import { LlmError } from "../src/llm";

// The adapter against an injected client: request shape, refusal and
// truncation handling, and re-validation of the parsed output.

const schema = z.object({ stance: z.enum(["fight", "consider_conceding"]) });

/** reply.text becomes the text block; other fields are copied onto the message. */
function fakeClient(reply: { text?: string } & Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const { text, ...rest } = reply;
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          calls.push(params);
          return { finalMessage: async () => ({ model: params.model, content: text === undefined ? [] : [{ type: "text", text }], ...rest }) };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const req = { purpose: "strategist" as const, system: "sys", user: "case", schema };

describe("createAnthropicLlm", () => {
  it("sends adaptive thinking, effort and the zod output format; opts into default fallbacks on supported models", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", text: '{"stance":"fight"}' });
    const llm = createAnthropicLlm({ apiKey: "k", model: "claude-opus-5-5", client });
    expect(await llm.complete(req)).toEqual({ output: { stance: "fight" }, model: "claude-opus-5-5" });
    expect(calls[0]).toMatchObject({
      model: "claude-opus-5-5",
      system: "sys",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    expect((calls[0]!.output_config as { format: unknown }).format).toBeDefined();
  });

  it("doesn't send fallbacks to models that don't accept the default form", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", text: '{"stance":"fight"}' });
    await createAnthropicLlm({ apiKey: "k", model: "claude-haiku-5-5", client }).complete(req);
    expect(calls[0]).not.toHaveProperty("fallbacks");
    expect(calls[0]).not.toHaveProperty("betas");
  });

  it("refusal, truncation and off-schema output are LlmErrors, never partial results", async () => {
    const cases: [{ text?: string } & Record<string, unknown>, string][] = [
      [{ stop_reason: "refusal", stop_details: { category: "cyber" }, text: '{"stance":' }, "refusal"],
      [{ stop_reason: "max_tokens", text: '{"stance":"fi' }, "truncated"], // half-written JSON: still "truncated"
      [{ stop_reason: "end_turn", text: '{"stance":"win"}' }, "invalid_output"],
      [{ stop_reason: "end_turn", text: "not json" }, "invalid_output"],
    ];
    for (const [reply, kind] of cases) {
      const { client } = fakeClient(reply);
      const err = await createAnthropicLlm({ apiKey: "k", model: "claude-opus-5-5", client })
        .complete(req)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).kind).toBe(kind);
    }
  });

  it("reports the model that answered, and lets non-API errors (bugs) propagate", async () => {
    const { client } = fakeClient({ stop_reason: "end_turn", text: '{"stance":"fight"}', model: "claude-opus-4-8" });
    const r = await createAnthropicLlm({ apiKey: "k", model: "claude-opus-5-5", client }).complete(req);
    expect(r.model).toBe("claude-opus-4-8");
    const broken = { beta: { messages: { stream: () => ({ finalMessage: async () => Promise.reject(new TypeError("bug")) }) } } } as unknown as Anthropic;
    await expect(createAnthropicLlm({ apiKey: "k", model: "claude-opus-5-5", client: broken }).complete(req)).rejects.toBeInstanceOf(TypeError);
  });
});
