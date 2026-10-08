import { disputeDetailSchema } from "@alibi/paypal/read";

// Test-only: a parsed dispute detail shaped like PayPal's (customer_disputes_v1 spec).
export const disputeDetailSchemaForTests = disputeDetailSchema.parse({
  dispute_id: "PP-D-1",
  create_time: "2026-10-20T00:00:00Z",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_life_cycle_stage: "CHARGEBACK",
  dispute_amount: { currency_code: "USD", value: "84.00" },
  seller_response_due_date: "2026-10-30T00:00:00Z",
  disputed_transactions: [
    { seller_transaction_id: "8XY12345AB678901C", create_time: "2026-10-02T14:03:00Z", gross_amount: { currency_code: "USD", value: "84.00" } },
  ],
  evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", source: "REQUESTED_FROM_SELLER" }],
  links: [{ rel: "provide-evidence", href: "x", method: "POST" }],
});
