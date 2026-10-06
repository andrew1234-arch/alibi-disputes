import { describe, expect, it } from "vitest";
import { resolveBaseUrl, SANDBOX_BASE } from "../src/host.js";

describe("resolveBaseUrl", () => {
  it("accepts the sandbox, with or without trailing slash", () => {
    expect(resolveBaseUrl("https://api-m.sandbox.paypal.com", false)).toBe(SANDBOX_BASE);
    expect(resolveBaseUrl("https://api-m.sandbox.paypal.com/", false)).toBe(SANDBOX_BASE);
  });

  it("rejects live PayPal and anything else", () => {
    expect(() => resolveBaseUrl("https://api-m.paypal.com", false)).toThrow(/Refusing/);
    expect(() => resolveBaseUrl("https://api-m.paypal.com", true)).toThrow(/Refusing/);
    expect(() => resolveBaseUrl("http://api-m.sandbox.paypal.com", false)).toThrow(/Refusing/);
    expect(() => resolveBaseUrl("https://api-m.sandbox.paypal.com.evil.test", false)).toThrow(/Refusing/);
    expect(() => resolveBaseUrl("https://api-m.sandbox.paypal.com/v1", false)).toThrow(/Refusing/);
    expect(() => resolveBaseUrl("not a url", false)).toThrow(/valid URL/);
  });

  it("allows loopback only in test mode", () => {
    expect(resolveBaseUrl("http://127.0.0.1:4010", true)).toBe("http://127.0.0.1:4010");
    expect(resolveBaseUrl("http://localhost:4010", true)).toBe("http://localhost:4010");
    expect(() => resolveBaseUrl("http://localhost:4010", false)).toThrow(/Refusing/);
  });
});
