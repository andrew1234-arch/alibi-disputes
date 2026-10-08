import type { z } from "zod";

// The LLM port. The agent's strategist and drafter talk to this interface only:
// tests pass a canned implementation, production passes the Anthropic adapter
// (./anthropic.ts). The LLM never sees PayPal credentials and has no path to
// the write adapter: it returns JSON, and that JSON is validated (zod) and then
// verified against the evidence before anyone sees it.

export type LlmPurpose = "strategist" | "drafter" | "drafter_repair" | "generic_reply";

export interface LlmRequest<T> {
  purpose: LlmPurpose;
  system: string;
  user: string;
  /** The response must parse against this; anything else is an error, not a partial result. */
  schema: z.ZodType<T>;
}

export interface LlmResult<T> {
  output: T;
  /** The model that actually answered (a server-side fallback can differ from the configured one). */
  model: string;
}

export interface Llm {
  /** Configured model id. */
  readonly model: string;
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

export type LlmFailure = "budget" | "refusal" | "truncated" | "invalid_output" | "api";

/** Every way an LLM step can fail. The agent catches these and falls back to the template drafter. */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmFailure,
    message: string,
    /** The step that failed (for the activity feed). */
    readonly purpose?: LlmPurpose,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/**
 * Caps LLM calls per case build (ALIBI_MAX_LLM_CALLS_PER_CASE). A call that
 * would go over throws before any request is made. Rebuilds whose input didn't
 * change reuse the stored draft and make no calls at all (agent/index.ts).
 *
 * Example with max 3: strategist (1), drafter (2), repair (3), a second repair → LlmError("budget").
 */
export class CallBudget {
  private used = 0;
  readonly calls: LlmPurpose[] = [];

  constructor(readonly max: number) {}

  take(purpose: LlmPurpose): void {
    if (this.used >= this.max) throw new LlmError("budget", `LLM call budget of ${this.max} per build used up`, purpose);
    this.used++;
    this.calls.push(purpose);
  }

  get remaining(): number {
    return this.max - this.used;
  }
}

/** Wraps an Llm so every call is charged to the budget first. */
export function budgeted(llm: Llm, budget: CallBudget): Llm {
  return {
    model: llm.model,
    complete: (req) => {
      budget.take(req.purpose);
      return llm.complete(req);
    },
  };
}
