import { describe, expect, it } from "vitest";
import { disputeDetailSchema } from "../src/schemas";
import { disputeToEvidence, requestedEvidence } from "../src/to-evidence";

const detail = disputeDetailSchema.parse({
  dispute_id: "PP-D-1",
  create_time: "2026-10-07T10:00:00Z",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_amount: { currency_code: "USD", value: "84.00" },
  seller_response_due_date: "2026-10-17T10:00:00Z",
  disputed_transactions: [
    { seller_transaction_id: "8XY12345AB678901C", create_time: "2026-10-02T14:03:00Z", gross_amount: { currency_code: "USD", value: "84.00" } },
  ],
  messages: [
    { posted_by: "BUYER", time_posted: "2026-10-07T10:05:00Z", content: "Never arrived." },
    { posted_by: "ARBITER", content: "Please provide tracking." },
    { posted_by: "SOMEONE_NEW", content: "ignored" },
  ],
  evidences: [
    { evidence_type: "PROOF_OF_FULFILLMENT", source: "REQUESTED_FROM_SELLER" },
    { evidence_type: "OTHER", source: "SUBMITTED_BY_BUYER" },
  ],
});

describe("disputeToEvidence", () => {
  const recs = disputeToEvidence(detail, "2026-10-07T11:00:00Z");

  it("labels everything as PayPal-sourced, money with currency", () => {
    expect(recs.every((r) => r.source === "paypal")).toBe(true);
    expect(recs.find((r) => r.kind === "transaction")).toMatchObject({
      ref: "8XY12345AB678901C",
      value: "84.00 USD",
      occurredAt: "2026-10-02T14:03:00Z",
    });
    expect(recs.find((r) => r.label === "Disputed amount")?.value).toBe("84.00 USD");
  });

  it("maps messages by poster and skips unknown posters", () => {
    expect(recs.filter((r) => r.kind === "buyer_message").map((r) => r.value)).toEqual(["Never arrived."]);
    expect(recs.some((r) => r.label === "PayPal arbiter message")).toBe(true);
    expect(recs.some((r) => r.value === "ignored")).toBe(false);
  });

  it("ids are stable across fetches", () => {
    expect(disputeToEvidence(detail, "2026-10-08T00:00:00Z").map((r) => r.id)).toEqual(recs.map((r) => r.id));
  });
});

describe("requestedEvidence", () => {
  it("keeps requests only, with the right party's deadline", () => {
    expect(requestedEvidence(detail)).toEqual([
      { evidenceType: "PROOF_OF_FULFILLMENT", source: "REQUESTED_FROM_SELLER", dueAt: "2026-10-17T10:00:00Z" },
    ]);
  });

  it("a transaction without gross_amount gets value \"—\", never the transaction id", () => {
    const d = { ...detail, disputed_transactions: [{ seller_transaction_id: "8XY12345AB678901C", create_time: "2026-10-02T14:03:00Z" }] };
    const tx = disputeToEvidence(d, "2026-10-08T00:00:00Z").find((r) => r.kind === "transaction");
    expect(tx?.value).toBe("—");
    expect(tx?.label).toMatch(/amount not provided by PayPal/);
  });
});
