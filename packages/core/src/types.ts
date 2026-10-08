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

/** How PayPal accepts an evidence type in provide-evidence (see reason-map.ts). */
export type SubmissionRoute = "tracking_info" | "refund_ids" | "notes_or_documents";

export interface ChecklistItem {
  evidenceType: string;
  satisfiedBy: string[]; // EvidenceRecord ids
  gap?: string; // plain-language description if unsatisfied
  /** Routes PayPal accepts for this type under the dispute's reason. Absent = unmapped type. */
  routes?: SubmissionRoute[];
}

/**
 * PayPal tracking_info. `carrier` is a PayPal carrier_name enum value; for a
 * carrier PayPal doesn't list, carrier = "OTHER" and carrierOther holds the
 * name (spec: carrier_name_other is mandatory when carrier_name is OTHER).
 */
export interface TrackingInfo {
  carrier: string;
  number: string;
  carrierOther?: string;
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
  amount: { value: string; currency: string; missing?: string }; // value "—" + missing reason when PayPal omits it (CLAUDE §1.3)
  dueAt?: string;
  requested: RequestedEvidence[];
  timeline: string[]; // EvidenceRecord ids in time order
  checklist: ChecklistItem[];
  strategy: { stance: Stance; reasons: DraftClaim[] };
  draft: {
    claims: DraftClaim[];
    notes: string; // assembled from verified claims; max PROVIDE_EVIDENCE_NOTES_MAX
    evidenceInfo?: { trackingInfo?: TrackingInfo[]; refundIds?: string[] };
    documents: string[]; // EvidenceRecord ids with documentUrl
  };
  evidence: Record<string, EvidenceRecord>;
  removedByVerifier: { text: string; reason: string }[];
  /** PayPal's update_time for the dispute when this case was built (the poller compares against it). */
  paypalUpdateTime?: string;
  /** Who wrote the draft and strategy, for the audit trail and the UI ("drafted by …"). */
  authoredBy?: {
    drafter: "llm" | "template";
    /** Configured model. */
    model?: string;
    /** Models that actually answered (a server-side refusal fallback can substitute another). */
    answeredBy?: string[];
    /** Hash of exactly what the LLM was shown; an unchanged input reuses this draft on rebuild. */
    inputHash?: string;
    /** This build reused the stored LLM draft (input unchanged), making no LLM calls. */
    reused?: boolean;
    llmCalls: number;
    /** Why the template was used instead of the LLM (budget, refusal, API error, LLM not configured). */
    fallbackReason?: string;
    /** The drafter's first attempt had claims the checker rejected, and it revised them. */
    repaired?: boolean;
    /** The model suggested a stronger stance than the evidence supports; it was lowered. */
    stanceCapped?: boolean;
  };
  approval?: { approvedAt: string; draftHash: string }; // approvalHash(): binds approval to the draft and the exact payload
  submission?: { submittedAt: string; paypalStatusAfter: string; requestId?: string };
  createdAt: string;
}
