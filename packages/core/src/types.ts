// Data model from SPEC §4. Enum-like fields stay `string` on purpose: PayPal's
// requested list always wins, and a value we have not seen yet must not crash
// ingest. Known values live in ./paypal-enums.ts (sourced from PayPal's spec).

export type FactSource = "paypal" | "merchant_demo";

export type EvidenceKind =
  | "transaction"
  | "order"
  | "fulfilment"
  | "carrier_event"
  | "buyer_message"
  | "seller_message"
  | "refund"
  | "policy"
  | "dispute_field";

export interface EvidenceRecord {
  id: string; // stable hash of (source, kind, ref, value)
  source: FactSource;
  kind: EvidenceKind;
  ref: string; // e.g. transaction id, order id, tracking number
  label: string; // human-readable
  value: string | number; // the fact itself
  occurredAt?: string; // ISO
  documentUrl?: string; // internal URL of an attachable document, if any
  fetchedAt: string;
}

export interface RequestedEvidence {
  evidenceType: string; // see EVIDENCE_TYPES
  source: string; // REQUESTED_FROM_SELLER is ours to answer
  dueAt?: string;
}

export interface ChecklistItem {
  evidenceType: string;
  satisfiedBy: string[]; // EvidenceRecord ids
  gap?: string; // plain-language description if unsatisfied
}

export interface DraftClaim {
  text: string;
  evidenceIds: string[]; // MUST be non-empty after verification
}

export type Stance = "fight" | "fight_with_gaps" | "consider_conceding";

export interface CaseFile {
  disputeId: string;
  reason: string;
  status: string;
  stage: string;
  amount: { value: string; currency: string };
  dueAt?: string;
  requested: RequestedEvidence[];
  timeline: string[]; // EvidenceRecord ids in time order
  checklist: ChecklistItem[];
  strategy: { stance: Stance; reasons: DraftClaim[] };
  draft: {
    claims: DraftClaim[];
    notes: string; // assembled from verified claims; max PROVIDE_EVIDENCE_NOTES_MAX
    evidenceInfo?: { trackingInfo?: { carrier: string; number: string }[]; refundIds?: string[] };
    documents: string[]; // EvidenceRecord ids with documentUrl
  };
  evidence: Record<string, EvidenceRecord>;
  removedByVerifier: { text: string; reason: string }[];
  approval?: { approvedAt: string; draftHash: string }; // hash binds approval to exact content
  submission?: { submittedAt: string; paypalStatusAfter: string; requestId?: string };
  createdAt: string;
}
