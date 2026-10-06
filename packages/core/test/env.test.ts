import { describe, expect, it } from "vitest";
import { appEnvSchema, paypalEnvSchema, parseEnv } from "../src/env.js";

const paypal = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };
const app = {
  ...paypal,
  PAYPAL_WEBHOOK_ID: "wh",
  ANTHROPIC_API_KEY: "k",
  ALIBI_MODEL: "m",
  DATABASE_URL: "postgres://x",
};

describe("parseEnv", () => {
  it("applies sandbox base and defaults", () => {
    const env = parseEnv(paypalEnvSchema, paypal);
    expect(env.PAYPAL_API_BASE).toBe("https://api-m.sandbox.paypal.com");
    expect(env.PAYPAL_TEST_MODE).toBe(false);
  });

  it("names missing variables without echoing secret values", () => {
    expect(() => parseEnv(paypalEnvSchema, { PAYPAL_CLIENT_SECRET: "s3cr3t" })).toThrow(/PAYPAL_CLIENT_ID/);
    try {
      parseEnv(paypalEnvSchema, { PAYPAL_CLIENT_SECRET: "s3cr3t" });
    } catch (e) {
      expect(String(e)).not.toContain("s3cr3t");
    }
  });

  it("defaults DEMO_READONLY to true unless explicitly false", () => {
    expect(parseEnv(appEnvSchema, app).DEMO_READONLY).toBe(true);
    expect(parseEnv(appEnvSchema, { ...app, DEMO_READONLY: "true" }).DEMO_READONLY).toBe(true);
    expect(parseEnv(appEnvSchema, { ...app, DEMO_READONLY: "false" }).DEMO_READONLY).toBe(false);
  });

  it("parses numeric limits with defaults", () => {
    const env = parseEnv(appEnvSchema, app);
    expect(env.ALIBI_MAX_LLM_CALLS_PER_CASE).toBe(8);
    expect(env.ALIBI_DEADLINE_WARN_HOURS).toBe(72);
    expect(() => parseEnv(appEnvSchema, { ...app, ALIBI_DEADLINE_WARN_HOURS: "-1" })).toThrow(/ALIBI_DEADLINE_WARN_HOURS/);
  });
});
