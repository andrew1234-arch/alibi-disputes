import { z } from "zod";
import { isValidTimeZone } from "./record-facts";

// Env validation (CLAUDE §7). Pure: callers pass process.env in.
// Schemas are split by consumer so a script that only talks to PayPal does not
// demand an Anthropic key.

const bool = z
  .enum(["true", "false", ""])
  .optional()
  .transform((v) => v === "true");

const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        ctx.addIssue({ code: "custom", message: "must be a positive integer" });
        return z.NEVER;
      }
      return n;
    });

const required = z.string().min(1, "is required");

export const paypalEnvSchema = z.object({
  PAYPAL_CLIENT_ID: required,
  PAYPAL_CLIENT_SECRET: required,
  PAYPAL_API_BASE: z.string().url().default("https://api-m.sandbox.paypal.com"),
  PAYPAL_TEST_MODE: bool,
});
export type PaypalEnv = z.infer<typeof paypalEnvSchema>;

const readonlyFlag = z
  .enum(["true", "false", ""])
  .optional()
  .transform((v) => v !== "false");

const timeZone = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || isValidTimeZone(v), "must be an IANA time zone, e.g. America/Chicago");

const operatorToken = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || v.length >= 32, "must be at least 32 characters (e.g. `openssl rand -hex 32`)");

/** With submissions on, approve/submit/build are open to anyone holding the URL unless an operator token guards them. */
const requireOperatorWhenWritable = (env: { DEMO_READONLY: boolean; ALIBI_OPERATOR_TOKEN?: string | undefined }, ctx: z.RefinementCtx) => {
  if (!env.DEMO_READONLY && !env.ALIBI_OPERATOR_TOKEN) {
    ctx.addIssue({ code: "custom", path: ["ALIBI_OPERATOR_TOKEN"], message: "is required when DEMO_READONLY=false" });
  }
};

/**
 * What the web server needs today (M2). PAYPAL_WEBHOOK_ID is optional because
 * it only exists after the deployed URL is registered with PayPal; without it
 * every webhook is refused, never accepted unverified.
 */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

/** The LLM is optional on the web server (template drafter without it), but key and model come as a pair. */
const llmPair = (env: { ANTHROPIC_API_KEY?: string | undefined; ALIBI_MODEL?: string | undefined }, ctx: z.RefinementCtx) => {
  if (Boolean(env.ANTHROPIC_API_KEY) !== Boolean(env.ALIBI_MODEL)) {
    ctx.addIssue({ code: "custom", path: [env.ANTHROPIC_API_KEY ? "ALIBI_MODEL" : "ANTHROPIC_API_KEY"], message: "set ANTHROPIC_API_KEY and ALIBI_MODEL together (or neither, for the template drafter)" });
  }
};

export const webEnvSchema = paypalEnvSchema.extend({
  DATABASE_URL: required,
  PAYPAL_WEBHOOK_ID: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  // Default to read-only: forgetting the flag must never open up submissions.
  DEMO_READONLY: readonlyFlag,
  // Bearer token for the merchant/operator actions (approve, submit, rebuild).
  ALIBI_OPERATOR_TOKEN: operatorToken,
  ALIBI_MERCHANT_TIME_ZONE: timeZone,
  // M3: strategist + drafter. Without them every case uses the template drafter.
  ANTHROPIC_API_KEY: optionalString,
  ALIBI_MODEL: optionalString,
  ALIBI_MAX_LLM_CALLS_PER_CASE: positiveInt(8),
}).superRefine((env, ctx) => {
  requireOperatorWhenWritable(env, ctx);
  llmPair(env, ctx);
});
export type WebEnv = z.infer<typeof webEnvSchema>;

export const appEnvSchema = paypalEnvSchema.extend({
  PAYPAL_WEBHOOK_ID: required,
  ANTHROPIC_API_KEY: required,
  ALIBI_MODEL: required,
  AG_STUDIO_LICENSE_KEY: z.string().optional(),
  DATABASE_URL: required,
  DEMO_READONLY: readonlyFlag,
  ALIBI_OPERATOR_TOKEN: operatorToken,
  ALIBI_MAX_LLM_CALLS_PER_CASE: positiveInt(8),
  ALIBI_DEADLINE_WARN_HOURS: positiveInt(72),
  // Merchant's IANA zone, used by the verifier to match local dates and times.
  ALIBI_MERCHANT_TIME_ZONE: timeZone,
}).superRefine(requireOperatorWhenWritable);
export type AppEnv = z.infer<typeof appEnvSchema>;

/** Parses env or throws an error listing every bad variable by name (never by value). */
export function parseEnv<S extends z.ZodType>(schema: S, raw: Record<string, string | undefined>): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return result.data;
}
