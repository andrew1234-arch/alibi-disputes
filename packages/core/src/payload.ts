import { normaliseIdentifier } from "./extract";
import type { ChecklistItem, EvidenceRecord, SubmissionRoute, TrackingInfo } from "./types";

// provide-evidence payload builder (pure). Turns a verified draft into the
// evidences PayPal receives. The merchant's confirmation dialog renders exactly
// this, and the submit route sends exactly this: one function for both, so
// what's shown and what's sent cannot drift apart.
//
// Shape follows PayPal's `evidence` schema (customer_disputes_v1.json):
//   evidence_type, evidence_info { tracking_info[] (max 10), refund_ids[] (strings, max 100) }, notes (max 2000)
// VERIFY: the request wraps these as {"evidences": [...]} in a multipart part
// named "input" (see docs/OPEN_QUESTIONS.md G4). Confirmed only by a real call.
//
// Worked example (INR, PayPal requests PROOF_OF_FULFILLMENT):
//   draft.evidenceInfo.trackingInfo = [{ carrier: "UPS", number: "1Z999AA10123456784" }]
//   draft.notes = "The buyer paid $84.00 on Oct 2, 2026. …"
//   → [{ evidence_type: "PROOF_OF_FULFILLMENT",
//        evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z999AA10123456784" }] },
//        notes: "The buyer paid $84.00 on Oct 2, 2026. …" }]

export interface PaypalTrackingInfo {
  carrier_name: string;
  tracking_number: string;
  carrier_name_other?: string;
}

export interface PaypalEvidence {
  evidence_type: string;
  evidence_info?: { tracking_info?: PaypalTrackingInfo[]; refund_ids?: string[] };
  notes?: string;
}

export interface EvidencePayload {
  evidences: PaypalEvidence[];
  /** EvidenceRecord ids whose documents are attached as files. */
  documentIds: string[];
  /** Requested types this payload does not answer (they stay gaps). */
  unanswered: string[];
}

export interface PayloadDraft {
  claims: readonly { evidenceIds: readonly string[] }[];
  notes: string;
  evidenceInfo?: { trackingInfo?: TrackingInfo[]; refundIds?: string[] };
  documents: string[];
}

const MAX_TRACKING = 10;
const MAX_REFUND_IDS = 100;

// Unmapped types have no routes; like the verifier's coverageFor, any route counts.
const ALL_ROUTES: readonly SubmissionRoute[] = ["tracking_info", "refund_ids", "notes_or_documents"];

export function buildEvidencePayload(
  draft: PayloadDraft,
  checklist: readonly ChecklistItem[],
  evidence: Readonly<Record<string, EvidenceRecord>>,
): EvidencePayload {
  const evidences: PaypalEvidence[] = [];
  const unanswered: string[] = [];
  const notes = draft.notes.trim();

  for (const item of checklist) {
    const routes = item.routes ?? ALL_ROUTES;
    const satisfying = new Set(item.satisfiedBy);
    const refs = new Set(item.satisfiedBy.map((id) => normaliseIdentifier(evidence[id]?.ref ?? "")));

    const tracking = routes.includes("tracking_info")
      ? (draft.evidenceInfo?.trackingInfo ?? []).filter((t) => refs.has(normaliseIdentifier(t.number))).slice(0, MAX_TRACKING)
      : [];
    const refunds = routes.includes("refund_ids")
      ? (draft.evidenceInfo?.refundIds ?? []).filter((r) => refs.has(normaliseIdentifier(r))).slice(0, MAX_REFUND_IDS)
      : [];
    // Same rule as the verifier's coverage: notes answer a type only when a
    // kept claim cites, or an attachment is, one of that type's own records.
    // Notes about fulfilment never answer PROOF_OF_REFUND.
    const viaNotes =
      routes.includes("notes_or_documents") &&
      (draft.claims.some((c) => c.evidenceIds.some((id) => satisfying.has(id))) || draft.documents.some((id) => satisfying.has(id)));

    if (!tracking.length && !refunds.length && !viaNotes) {
      unanswered.push(item.evidenceType);
      continue;
    }
    const e: PaypalEvidence = { evidence_type: item.evidenceType };
    if (tracking.length || refunds.length) {
      e.evidence_info = {
        ...(tracking.length
          ? {
              tracking_info: tracking.map((t) => ({
                carrier_name: t.carrier,
                tracking_number: t.number,
                ...(t.carrierOther ? { carrier_name_other: t.carrierOther } : {}),
              })),
            }
          : {}),
        ...(refunds.length ? { refund_ids: refunds } : {}),
      };
    }
    evidences.push(e);
  }

  // The merchant's statement goes once, on the first evidence, rather than
  // being repeated per type. VERIFY: whether PayPal shows per-evidence notes
  // to the reviewer for every type, or prefers them on a specific one.
  const first = evidences[0];
  if (first && notes) first.notes = notes;

  return { evidences, documentIds: evidences.length ? [...draft.documents] : [], unanswered };
}
