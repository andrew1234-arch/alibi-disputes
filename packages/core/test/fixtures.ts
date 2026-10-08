import { makeEvidenceRecord } from "../src/evidence";

// SPEC §5.3 worked example: item not received, $84.00, order #1042, UPS, delivered Oct 6.
const fetchedAt = "2026-10-07T09:00:00Z";

export const tx = makeEvidenceRecord({
  source: "paypal",
  kind: "transaction",
  ref: "8XY12345AB678901C",
  label: "PayPal capture",
  value: "84.00 USD",
  occurredAt: "2026-10-02T14:03:00Z",
  fetchedAt,
});
export const order = makeEvidenceRecord({
  source: "merchant_demo",
  kind: "order",
  ref: "1042",
  label: "Order #1042: Ceramic pour-over set",
  value: "1 × Ceramic pour-over set, 84.00 USD, ship to Austin TX",
  occurredAt: "2026-10-02T14:01:00Z",
  fetchedAt,
});
export const shipment = makeEvidenceRecord({
  source: "merchant_demo",
  kind: "fulfilment",
  ref: "1Z999AA10123456784",
  label: "Shipped via UPS",
  value: "UPS 1Z999AA10123456784",
  occurredAt: "2026-10-03T16:20:00Z",
  fetchedAt,
});
export const inTransit = makeEvidenceRecord({
  source: "merchant_demo",
  kind: "carrier_event",
  ref: "1Z999AA10123456784",
  label: "UPS scan",
  value: "In transit, Dallas TX",
  occurredAt: "2026-10-04T08:00:00Z",
  fetchedAt,
});
export const delivered = makeEvidenceRecord({
  source: "merchant_demo",
  kind: "carrier_event",
  ref: "1Z999AA10123456784",
  label: "UPS scan",
  value: "Delivered, front door",
  occurredAt: "2026-10-06T19:42:00Z",
  documentUrl: "/evidence/demo/pod-1042.pdf",
  fetchedAt,
});
export const buyerMsg = makeEvidenceRecord({
  source: "merchant_demo",
  kind: "buyer_message",
  ref: "msg-1",
  label: "Buyer message",
  value: "Thanks, the set arrived  safely and looks great!",
  occurredAt: "2026-10-07T01:15:00Z",
  fetchedAt,
});
export const refund = makeEvidenceRecord({
  source: "paypal",
  kind: "refund",
  ref: "5RF00000AB1234567",
  label: "Partial refund",
  value: "10.00 USD",
  occurredAt: "2026-10-08T10:00:00Z",
  fetchedAt,
});

export const all = [tx, order, shipment, inTransit, delivered, buyerMsg];
export const evidenceMap = Object.fromEntries([...all, refund].map((r) => [r.id, r]));
