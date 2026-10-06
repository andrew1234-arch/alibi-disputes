import type { EvidenceKind, SubmissionRoute } from "./types.js";

// Reason → evidence map (SPEC §5.2).
//
// SOURCE for which evidence types each reason accepts, and how each is submitted:
//   PayPal, "Dispute reasons and evidence", https://developer.paypal.com/disputes/reasons-evidence
//   (retrieved 2026-10-06; tables quoted per row below).
// The `kinds` column (which merchant/PayPal fact kinds can satisfy a type) is
// Alibi's own mapping, derived from the examples PayPal gives in that table.
//
// PayPal's actual REQUESTED_FROM_SELLER list on the dispute always wins: this
// table is only for ranking and gap detection, never for overriding PayPal.

export interface EvidenceRule {
  routes: SubmissionRoute[];
  kinds: EvidenceKind[];
}

export type ReasonEvidenceMap = Record<string, Record<string, EvidenceRule>>;

const REFUND: EvidenceRule = { routes: ["refund_ids"], kinds: ["refund"] };

export const REASON_EVIDENCE_MAP: ReasonEvidenceMap = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: {
    // "Provide one of the following: Carrier name and tracking number through
    //  evidence_info.tracking_info … Or Notes or documents … e.g. a proof of delivery
    //  signature or a proof of receipt copy."
    PROOF_OF_FULFILLMENT: { routes: ["tracking_info", "notes_or_documents"], kinds: ["fulfilment", "carrier_event"] },
    // "Pass the refund ID in the evidences.evidence_info.refund_ids parameter."
    PROOF_OF_REFUND: REFUND,
  },
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: {
    // "Pass the notes or documents … e.g. a product description, item URL, return
    //  policy, or a copy of a contract or an affidavit."
    OTHER: { routes: ["notes_or_documents"], kinds: ["order", "policy", "buyer_message", "seller_message"] },
    PROOF_OF_REFUND: REFUND,
  },
  UNAUTHORISED: {
    // "Provide the carrier name and tracking number through … tracking_info" (tracking only).
    PROOF_OF_FULFILLMENT: { routes: ["tracking_info"], kinds: ["fulfilment", "carrier_event"] },
    PROOF_OF_REFUND: REFUND,
    // "… e.g. a proof of delivery signature or a proof of receipt copy."
    OTHER: { routes: ["notes_or_documents"], kinds: ["carrier_event", "fulfilment", "order", "transaction"] },
  },
  CREDIT_NOT_PROCESSED: {
    PROOF_OF_REFUND: REFUND,
    // "… e.g. a credit due reason."
    OTHER: { routes: ["notes_or_documents"], kinds: ["refund", "policy", "order", "buyer_message", "seller_message"] },
  },
  DUPLICATE_TRANSACTION: {
    PROOF_OF_REFUND: REFUND,
    OTHER: { routes: ["notes_or_documents"], kinds: ["transaction", "order"] },
  },
  INCORRECT_AMOUNT: {
    // "Pass the refund ID … for the difference in amount."
    PROOF_OF_REFUND: REFUND,
    // "… e.g. a price difference reason."
    OTHER: { routes: ["notes_or_documents"], kinds: ["order", "transaction", "policy"] },
  },
  PAYMENT_BY_OTHER_MEANS: {
    PROOF_OF_REFUND: REFUND,
    OTHER: { routes: ["notes_or_documents"], kinds: ["transaction", "order"] },
  },
  CANCELED_RECURRING_BILLING: {
    PROOF_OF_REFUND: REFUND,
    // "… e.g. a subscription agreement."
    OTHER: { routes: ["notes_or_documents"], kinds: ["policy", "order", "transaction", "buyer_message", "seller_message"] },
  },
  OTHER: {
    PROOF_OF_REFUND: REFUND,
    OTHER: {
      routes: ["notes_or_documents"],
      kinds: ["transaction", "order", "fulfilment", "carrier_event", "buyer_message", "seller_message", "refund", "policy"],
    },
  },
};

/** The rule for (reason, evidenceType), or undefined if PayPal's page doesn't list the pair. */
export function evidenceRule(reason: string, evidenceType: string, map: ReasonEvidenceMap = REASON_EVIDENCE_MAP) {
  return map[reason]?.[evidenceType];
}
