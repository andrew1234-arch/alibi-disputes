import { SELLER_SOURCE, type EvidenceRecord, type RequestedEvidence } from "@alibi/core";
import { makeEvidenceRecord } from "@alibi/core/server";
import type { DisputeDetail } from "./schemas";

// PayPal reads → EvidenceRecords (SPEC §6.1: nothing raw leaves the package).
// Every record here has source "paypal". Money is always "value CURRENCY".
//
// Example: disputed_transactions[0] = { seller_transaction_id: "8XY…", create_time: "2026-10-02T14:03:00Z",
//          gross_amount: { value: "84.00", currency_code: "USD" } }
//   → { kind: "transaction", ref: "8XY…", label: "PayPal transaction", value: "84.00 USD", occurredAt: … }

const money = (m: { value: string; currency_code: string } | undefined) => (m ? `${m.value} ${m.currency_code}` : undefined);

export function disputeToEvidence(d: DisputeDetail, fetchedAt: string): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  const at = d.create_time ? { occurredAt: d.create_time } : {};
  out.push(makeEvidenceRecord({ source: "paypal", kind: "dispute_field", ref: d.dispute_id, label: "Dispute reason", value: d.reason, ...at, fetchedAt }));
  const amount = money(d.dispute_amount);
  if (amount) {
    out.push(makeEvidenceRecord({ source: "paypal", kind: "dispute_field", ref: d.dispute_id, label: "Disputed amount", value: amount, ...at, fetchedAt }));
  }
  for (const t of d.disputed_transactions ?? []) {
    if (!t.seller_transaction_id) continue;
    out.push(
      makeEvidenceRecord({
        source: "paypal",
        kind: "transaction",
        ref: t.seller_transaction_id,
        label: `${t.invoice_number ? `PayPal transaction (invoice ${t.invoice_number})` : "PayPal transaction"}${t.gross_amount ? "" : ", amount not provided by PayPal"}`,
        // "—" when PayPal omits the amount: never put the id where an amount belongs.
        value: money(t.gross_amount) ?? "—",
        ...(t.create_time ? { occurredAt: t.create_time } : {}),
        fetchedAt,
      }),
    );
  }
  // posted_by (spec message.posted_by): BUYER | SELLER | ARBITER.
  const KIND = { BUYER: "buyer_message", SELLER: "seller_message", ARBITER: "dispute_field" } as const;
  const LABEL = { BUYER: "Buyer message in PayPal", SELLER: "Seller message in PayPal", ARBITER: "PayPal arbiter message" } as const;
  for (const [i, m] of (d.messages ?? []).entries()) {
    const who = m.posted_by as keyof typeof KIND | undefined;
    if (!m.content || !who || !Object.hasOwn(KIND, who)) continue; // hasOwn: "constructor" etc. must not match
    out.push(
      makeEvidenceRecord({
        source: "paypal",
        kind: KIND[who],
        ref: `${d.dispute_id}/message/${i}`,
        label: LABEL[who],
        value: m.content,
        ...(m.time_posted ? { occurredAt: m.time_posted } : {}),
        fetchedAt,
      }),
    );
  }
  return out;
}

/** Evidence PayPal requested (either party), with the seller deadline attached to seller requests. */
export function requestedEvidence(d: DisputeDetail): RequestedEvidence[] {
  return (d.evidences ?? [])
    .filter((e) => e.evidence_type && e.source?.startsWith("REQUESTED_FROM_"))
    .map((e) => ({
      evidenceType: e.evidence_type!,
      source: e.source!,
      ...(e.source === SELLER_SOURCE && d.seller_response_due_date ? { dueAt: d.seller_response_due_date } : {}),
      ...(e.source === "REQUESTED_FROM_BUYER" && d.buyer_response_due_date ? { dueAt: d.buyer_response_due_date } : {}),
    }));
}
