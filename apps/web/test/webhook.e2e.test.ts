import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STUB_VALID_SIGNATURE } from "@alibi/test-stub";
import { makeDemoDocumentRoute, makeWebhookRoute } from "@/lib/server/routes";
import { operatorHeaders, params, resetHarness, startHarness, type Harness } from "./harness";

// SPEC §8.2 webhook cases, through the real route and real verifier (against the stub).

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());
beforeEach(() => resetHarness(h));

const event = (id: string, type = "CUSTOMER.DISPUTE.CREATED", disputeId = "PP-D-1") =>
  JSON.stringify({ id, event_type: type, resource_type: "dispute", resource: { dispute_id: disputeId } });

const deliver = (body: string, sig = STUB_VALID_SIGNATURE, ctx = h.ctx) =>
  makeWebhookRoute(async () => ctx)(
    new Request("http://x/api/webhooks/paypal", {
      method: "POST",
      body,
      headers: {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT",
        "paypal-transmission-id": "tx-1",
        "paypal-transmission-sig": sig,
        "paypal-transmission-time": "2026-10-07T10:00:00Z",
      },
    }),
  );

describe("PayPal webhook route", () => {
  it("valid → accepted and the dispute is queued", async () => {
    const res = await deliver(event("WH-1"));
    expect(res.status).toBe(200);
    expect(h.ctx.enqueued).toEqual(["PP-D-1"]);
  });

  it("tampered signature → 401, not recorded, not queued", async () => {
    const res = await deliver(event("WH-2"), "forged");
    expect(res.status).toBe(401);
    expect(h.ctx.enqueued).toEqual([]);
    // The genuine delivery of the same event id still goes through afterwards.
    expect((await deliver(event("WH-2"))).status).toBe(200);
    expect(h.ctx.enqueued).toEqual(["PP-D-1"]);
  });

  it("duplicate event id (PayPal retry) → 200, processed once", async () => {
    await deliver(event("WH-3"));
    const again = await deliver(event("WH-3"));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true });
    expect(h.ctx.enqueued).toEqual(["PP-D-1"]);
  });

  it("event id and rebuild are recorded together; if that fails, PayPal's retry is processed", async () => {
    const broken = { ...h.ctx, repo: { ...h.repo, recordWebhookEvent: async () => Promise.reject(new Error("db blip")) } };
    expect((await deliver(event("WH-5"), STUB_VALID_SIGNATURE, broken)).status).toBe(500);
    const retry = await deliver(event("WH-5"));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ received: true });
    expect(h.ctx.enqueued).toEqual(["PP-D-1"]);
    const queued = await h.sql.query<{ dispute_id: string }>(`select dispute_id from pending_rebuilds`);
    expect(queued.rows).toEqual([{ dispute_id: "PP-D-1" }]);
  });

  it("a failing activity log after the commit doesn't fail the webhook (the queue row is durable)", async () => {
    const flaky = { ...h.ctx, repo: { ...h.repo, logActivity: async () => Promise.reject(new Error("db blip")) } };
    expect((await deliver(event("WH-6"), STUB_VALID_SIGNATURE, flaky)).status).toBe(200);
    expect((await h.sql.query(`select 1 from pending_rebuilds`)).rows).toHaveLength(1);
  });

  it("oversized bodies are refused (413) without being processed", async () => {
    const huge = JSON.stringify({ id: "WH-BIG", event_type: "CUSTOMER.DISPUTE.CREATED", pad: "x".repeat(600 * 1024) });
    expect((await deliver(huge)).status).toBe(413);
    expect(h.ctx.enqueued).toEqual([]);
  });

  it("non-dispute events are recorded but not queued; junk bodies are 400", async () => {
    expect((await deliver(event("WH-4", "PAYMENT.CAPTURE.COMPLETED"))).status).toBe(200);
    expect(h.ctx.enqueued).toEqual([]);
    expect((await deliver("not json")).status).toBe(400);
  });
});

describe("demo documents route", () => {
  it("serves the generated proof-of-delivery PDF and 404s anything else", async () => {
    const route = makeDemoDocumentRoute(async () => h.ctx);
    const ok = await route(new Request("http://x", { headers: operatorHeaders }), params({ scenario: "inr-delivered", file: "proof-of-delivery-1042.pdf" }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect((await ok.text()).startsWith("%PDF-1.4")).toBe(true);
    expect((await route(new Request("http://x", { headers: operatorHeaders }), params({ scenario: "nope", file: "x.pdf" }))).status).toBe(404);
  });
});
