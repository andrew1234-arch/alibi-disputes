import { describe, expect, it } from "vitest";
import { appEnvSchema, paypalEnvSchema, parseEnv, webEnvSchema } from "../src/env";

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
    expect(parseEnv(appEnvSchema, { ...app, DEMO_READONLY: "false", ALIBI_OPERATOR_TOKEN: "x".repeat(32) }).DEMO_READONLY).toBe(false);
  });

  it("parses numeric limits with defaults", () => {
    const env = parseEnv(appEnvSchema, app);
    expect(env.ALIBI_MAX_LLM_CALLS_PER_CASE).toBe(8);
    expect(env.ALIBI_DEADLINE_WARN_HOURS).toBe(72);
    expect(() => parseEnv(appEnvSchema, { ...app, ALIBI_DEADLINE_WARN_HOURS: "-1" })).toThrow(/ALIBI_DEADLINE_WARN_HOURS/);
  });

  it("validates the merchant time zone", () => {
    expect(parseEnv(appEnvSchema, app).ALIBI_MERCHANT_TIME_ZONE).toBeUndefined();
    expect(parseEnv(appEnvSchema, { ...app, ALIBI_MERCHANT_TIME_ZONE: "America/Chicago" }).ALIBI_MERCHANT_TIME_ZONE).toBe("America/Chicago");
    expect(() => parseEnv(appEnvSchema, { ...app, ALIBI_MERCHANT_TIME_ZONE: "America/Chicgo" })).toThrow(/ALIBI_MERCHANT_TIME_ZONE/);
  });

  it("web env needs only PayPal + database; webhook id optional, read-only by default", () => {
    const env = parseEnv(webEnvSchema, { ...paypal, DATABASE_URL: "pglite://memory" });
    expect(env.PAYPAL_WEBHOOK_ID).toBeUndefined();
    expect(env.DEMO_READONLY).toBe(true);
    expect(() => parseEnv(webEnvSchema, paypal)).toThrow(/DATABASE_URL/);
  });

  it("requires a strong operator token once submissions are on", () => {
    const web = { ...paypal, DATABASE_URL: "pglite://memory", DEMO_READONLY: "false" };
    expect(() => parseEnv(webEnvSchema, web)).toThrow(/ALIBI_OPERATOR_TOKEN: is required when DEMO_READONLY=false/);
    expect(() => parseEnv(webEnvSchema, { ...web, ALIBI_OPERATOR_TOKEN: "short" })).toThrow(/at least 32/);
    expect(parseEnv(webEnvSchema, { ...web, ALIBI_OPERATOR_TOKEN: "x".repeat(32) }).ALIBI_OPERATOR_TOKEN).toBe("x".repeat(32));
    expect(() => parseEnv(appEnvSchema, { ...app, DEMO_READONLY: "false" })).toThrow(/ALIBI_OPERATOR_TOKEN/);
  });
});
