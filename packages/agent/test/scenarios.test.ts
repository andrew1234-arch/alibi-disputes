import { describe, expect, it } from "vitest";
import { buildEvidencePayload } from "@alibi/core";
import { makeEvidenceRecord } from "@alibi/core/server";
import { buildScenarioRecords, scenario } from "@alibi/merchant";
import { assembleCaseFile, type DisputeFacts } from "@alibi/casefile";

const now = new Date("2026-10-20T00:00:00Z");
const paidAt = "2026-10-02T14:03:00.000Z";
const payment = makeEvidenceRecord({
  source: "paypal",
  kind: "transaction",
  ref: "8XY12345AB678901C",
  label: "PayPal transaction",
  value: "84.00 USD",
  occurredAt: paidAt,
  fetchedAt: now.toISOString(),
});
const facts = (over: Partial<DisputeFacts> = {}): DisputeFacts => ({
  disputeId: "PP-D-1",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  stage: "CHARGEBACK",
  amount: { value: "84.00", currency: "USD" },
  requested: [{ evidenceType: "PROOF_OF_FULFILLMENT", source: "REQUESTED_FROM_SELLER" }],
  ...over,
});
const records = (id: string) => [payment, ...buildScenarioRecords(scenario(id)!, { transactionId: payment.ref, paidAt }, now)];

// Integration: casefile assembly over the demo merchant scenarios. Lives in
// @alibi/agent because casefile may import only core (CLAUDE §4.1).
describe("assembleCaseFile + template drafter over demo scenarios", () => {
  it("inr-delivered: verified draft, nothing removed, tracking + POD attached, stance fight", () => {
    const cf = assembleCaseFile(facts(), records("inr-delivered"), { now });
    expect(cf.removedByVerifier).toEqual([]);
    expect(cf.strategy.stance).toBe("fight");
    expect(cf.draft.claims.map((c) => c.text)).toEqual([
      "The buyer paid 84.00 USD on Oct 2, 2026.",
      "Order #1042: Ceramic pour-over set.",
      "The order shipped on Oct 3, 2026 via UPS, tracking number 1Z999AA10123456784.",
      'UPS reported "Delivered, front door, Austin TX" on Oct 5, 2026.',
    ]);
    expect(cf.draft.evidenceInfo).toEqual({ trackingInfo: [{ carrier: "UPS", number: "1Z999AA10123456784" }] });
    expect(cf.draft.documents).toHaveLength(1);
    const p = buildEvidencePayload(cf.draft, cf.checklist, cf.evidence);
    expect(p.unanswered).toEqual([]);
    expect(p.evidences[0]?.evidence_type).toBe("PROOF_OF_FULFILLMENT");
  });

  it("every scenario's template draft passes the verifier untouched", () => {
    for (const id of ["inr-delivered", "inr-in-transit", "snad-color", "inr-no-tracking"]) {
      const reason = id.startsWith("snad") ? "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" : "MERCHANDISE_OR_SERVICE_NOT_RECEIVED";
      const type = id.startsWith("snad") ? "OTHER" : "PROOF_OF_FULFILLMENT";
      const cf = assembleCaseFile(facts({ reason, requested: [{ evidenceType: type, source: "REQUESTED_FROM_SELLER" }] }), records(id), { now });
      expect(cf.removedByVerifier, id).toEqual([]);
    }
  });

  it("snad quotes the listing, and timeline is in time order", () => {
    const cf = assembleCaseFile(
      facts({ reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", requested: [{ evidenceType: "OTHER", source: "REQUESTED_FROM_SELLER" }] }),
      records("snad-color"),
      { now },
    );
    expect(cf.draft.claims.some((c) => c.text.startsWith('Listing description: "Speckled blue glaze."'))).toBe(true);
    const times = cf.timeline.map((id) => cf.evidence[id]!.occurredAt).filter(Boolean) as string[];
    expect([...times].sort()).toEqual(times);
  });

});
