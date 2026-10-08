import { describe, expect, it, vi } from "vitest";
import type { PaypalEnv } from "@alibi/core";
import { createPaypalReader } from "../src/read";
import { PaypalError, PaypalNetworkError, PaypalNotSentError, PaypalResponseShapeError } from "../src/errors";

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

  it("retries a GET that got no response, then gives up with a network error", async () => {
    const fetch = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(token())
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json(200, { items: [] }));
    await createPaypalReader(env, { fetch, sleep: async () => {} }).listDisputes();
    expect(fetch).toHaveBeenCalledTimes(3);

    const down = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(token())
      .mockRejectedValue(new TypeError("fetch failed"));
    await expect(createPaypalReader(env, { fetch: down, sleep: async () => {} }).listDisputes()).rejects.toBeInstanceOf(PaypalNetworkError);
    expect(down).toHaveBeenCalledTimes(4); // token + 3 attempts
  });

  it("retries a GET whose token request got no response", async () => {
    const fetch = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json(200, { items: [] }));
    const r = createPaypalReader(env, { fetch, sleep: async () => {} });
    await r.listDisputes();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("doesn't retry a permanent token error; keeps PayPal's status and debug id", async () => {
    const fetch = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(json(401, { error: "invalid_client" }, { "paypal-debug-id": "dbg-401" }));
    const r = createPaypalReader(env, { fetch, sleep: async () => {} });
    const err = await r.listDisputes().catch((e: unknown) => e);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(PaypalNotSentError);
    expect((err as PaypalNotSentError).paypalError).toMatchObject({ status: 401, debugId: "dbg-401" });
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
