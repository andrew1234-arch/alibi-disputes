import { describe, expect, it, vi } from "vitest";
import type { PaypalEnv } from "@alibi/core";
import { createPaypalReader } from "../src/read.js";
import { PaypalError, PaypalResponseShapeError } from "../src/errors.js";

const env: PaypalEnv = {
  PAYPAL_CLIENT_ID: "id",
  PAYPAL_CLIENT_SECRET: "secret",
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  PAYPAL_TEST_MODE: false,
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const token = () => json(200, { access_token: "tok", token_type: "Bearer", expires_in: 3600, scope: "s" });

describe("paypal reader", () => {
  it("fetches a token once and lists disputes", async () => {
    const fetch = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json(200, { items: [{ dispute_id: "PP-D-1", status: "OPEN" }] }))
      .mockResolvedValueOnce(json(200, { items: [] }));
    const r = createPaypalReader(env, { fetch });
    expect((await r.listDisputes({ page_size: 5 })).data.items[0]?.dispute_id).toBe("PP-D-1");
    await r.listDisputes();
    expect(fetch).toHaveBeenCalledTimes(3); // token cached
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=5");
    expect((fetch.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("retries GET on 503 then succeeds", async () => {
    const fetch = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, { items: [] }));
    const r = createPaypalReader(env, { fetch, sleep: async () => {} });
    await r.listDisputes();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("surfaces PayPal errors with debug id", async () => {
    const fetch = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json(404, { name: "RESOURCE_NOT_FOUND", message: "nope" }, { "paypal-debug-id": "dbg1" }));
    const r = createPaypalReader(env, { fetch });
    const err = await r.getDispute("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaypalError);
    expect((err as PaypalError).debugId).toBe("dbg1");
    expect((err as PaypalError).status).toBe(404);
  });

  it("treats a malformed response as an error, not a partial render", async () => {
    const fetch = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json(200, { dispute_id: "x" }));
    const r = createPaypalReader(env, { fetch });
    await expect(r.getDispute("x")).rejects.toBeInstanceOf(PaypalResponseShapeError);
  });

  it("never sends credentials anywhere but the sandbox", () => {
    expect(() => createPaypalReader({ ...env, PAYPAL_API_BASE: "https://api-m.paypal.com" })).toThrow(/Refusing/);
  });
});
