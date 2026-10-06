import { z } from "zod";

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

export const appEnvSchema = paypalEnvSchema.extend({
  PAYPAL_WEBHOOK_ID: required,
  ANTHROPIC_API_KEY: required,
  ALIBI_MODEL: required,
  AG_STUDIO_LICENSE_KEY: z.string().optional(),
  DATABASE_URL: required,
  // Default to read-only: forgetting the flag must never open up submissions.
  DEMO_READONLY: z
    .enum(["true", "false", ""])
    .optional()
    .transform((v) => v !== "false"),
  ALIBI_MAX_LLM_CALLS_PER_CASE: positiveInt(8),
  ALIBI_DEADLINE_WARN_HOURS: positiveInt(72),
});
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
