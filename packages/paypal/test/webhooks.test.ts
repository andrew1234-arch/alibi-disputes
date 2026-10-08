import { describe, expect, it } from "vitest";
import { createWebhookVerifier, isPaypalCertUrl } from "../src/webhooks";
import { env, json, mockFetch, token } from "./helpers";

const headers = (over: Record<string, string | null> = {}) => {
  const h: Record<string, string | null> = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-10-06T20:01:35Z",
    ...over,
  };
  return { get: (n: string) => h[n] ?? null };
};

// Deliberately unusual formatting: must reach PayPal byte-for-byte.
const raw = '{"id":"WH-1",  "event_type":"CUSTOMER.DISPUTE.CREATED","resource":{"dispute_id":"PP-D-1","amount":1.10}}';

describe("webhook verification", () => {
  const verifier = (fetch: ReturnType<typeof mockFetch>) => createWebhookVerifier({ ...env, PAYPAL_WEBHOOK_ID: "WH123" }, { fetch });

  it("posts the headers, webhook id and the raw event body unchanged", async () => {
    const fetch = mockFetch().mockResolvedValueOnce(token()).mockResolvedValueOnce(json(200, { verification_status: "SUCCESS" }));
    expect(await verifier(fetch).verify(headers(), raw)).toEqual({ verified: true });
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
    const body = init?.body as string;
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(body)).toMatchObject({
      auth_algo: "SHA256withRSA",
      transmission_sig: "sig",
      webhook_id: "WH123",
      webhook_event: { id: "WH-1" },
    });
  });

  it("FAILURE is not verified", async () => {
    const fetch = mockFetch().mockResolvedValueOnce(token()).mockResolvedValueOnce(json(200, { verification_status: "FAILURE" }));
    expect(await verifier(fetch).verify(headers(), raw)).toEqual({ verified: false, reason: "PayPal returned FAILURE" });
  });

  it("missing headers or a non-JSON body fail without calling PayPal", async () => {
    const fetch = mockFetch();
    expect((await verifier(fetch).verify(headers({ "paypal-transmission-sig": null }), raw)).verified).toBe(false);
    expect((await verifier(fetch).verify(headers(), "not json")).verified).toBe(false);
    expect((await verifier(fetch).verify(headers(), "[1]")).verified).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cert URL must be https on a paypal.com host", () => {
    expect(isPaypalCertUrl("https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1")).toBe(true);
    expect(isPaypalCertUrl("https://api.paypal.com/v1/notifications/certs/CERT-1")).toBe(true);
    expect(isPaypalCertUrl("http://api.paypal.com/v1/notifications/certs/CERT-1")).toBe(false);
    expect(isPaypalCertUrl("https://paypal.com.evil.example/cert")).toBe(false);
    expect(isPaypalCertUrl("https://evilpaypal.com/cert")).toBe(false);
    expect(isPaypalCertUrl("not a url")).toBe(false);
  });
});
