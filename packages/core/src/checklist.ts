import { evidenceRule, REASON_EVIDENCE_MAP, type ReasonEvidenceMap } from "./reason-map.js";
import type { ChecklistItem, EvidenceRecord, RequestedEvidence, Stance } from "./types.js";

// Evidence checklist (SPEC §5.3 step 3) and a deterministic baseline stance.
//
// Worked example (SPEC §5.3):
//   reason = MERCHANDISE_OR_SERVICE_NOT_RECEIVED, PayPal requests PROOF_OF_FULFILLMENT.
//   Records: capture $84.00 on Oct 2 (PAYPAL), order #1042 (DEMO),
//            fulfilment 1Z… via UPS (DEMO), carrier event "Delivered, front door" Oct 6 (DEMO).
//   → PROOF_OF_FULFILLMENT satisfiedBy [fulfilment, carrier event], no gap → stance "fight".
//   Without the delivered event:
//   → satisfiedBy [fulfilment], gap "Tracking shows in transit; no delivery confirmation"
//     → stance "fight_with_gaps".

export const SELLER_SOURCE = "REQUESTED_FROM_SELLER";

// "Delivered, front door" counts; "Not yet delivered", "Undelivered",
// "Delivery attempted" and "Out for delivery" do not.
const DELIVERED = /\bdelivered\b/i;
const NEGATED = /\b(not|never)\b[^.;]{0,20}\bdelivered\b/i;

export function isDeliveredEvent(r: EvidenceRecord): boolean {
  if (r.kind !== "carrier_event") return false;
  const text = String(r.value);
  return DELIVERED.test(text) && !NEGATED.test(text);
}

export function buildChecklist(
  reason: string,
  requested: readonly RequestedEvidence[],
  records: readonly EvidenceRecord[],
  map: ReasonEvidenceMap = REASON_EVIDENCE_MAP,
): ChecklistItem[] {
  const ours = dedupeTypes(requested.filter((r) => r.source === SELLER_SOURCE));
  return ours.map((evidenceType) => {
    const rule = evidenceRule(reason, evidenceType, map);
    if (!rule) {
      return {
        evidenceType,
        satisfiedBy: [],
        gap: `Alibi has no mapping for ${evidenceType} under ${reason}. PayPal requested it, so review it manually.`,
      };
    }
    const matching = records.filter((r) => rule.kinds.includes(r.kind));
    const satisfiedBy = matching.map((r) => r.id);
    const gap = gapFor(evidenceType, matching);
    return gap ? { evidenceType, satisfiedBy, gap } : { evidenceType, satisfiedBy };
  });
}

function gapFor(evidenceType: string, matching: readonly EvidenceRecord[]): string | undefined {
  if (evidenceType === "PROOF_OF_FULFILLMENT") {
    const shipped = matching.some((r) => r.kind === "fulfilment" || r.kind === "carrier_event");
    if (!shipped) return "No tracking number or shipment record on file.";
    if (!matching.some(isDeliveredEvent)) {
      const last = [...matching]
        .filter((r) => r.kind === "carrier_event" && r.occurredAt)
        .sort((a, b) => Date.parse(a.occurredAt!) - Date.parse(b.occurredAt!))
        .at(-1);
      return last
        ? `Tracking shows "${String(last.value)}"; no delivery confirmation.`
        : "Tracking shows in transit; no delivery confirmation.";
    }
    return undefined;
  }
  if (evidenceType === "PROOF_OF_REFUND") {
    return matching.length ? undefined : "No refund on record for this transaction.";
  }
  return matching.length ? undefined : `No records on file that support ${evidenceType}.`;
}

function dedupeTypes(requested: readonly RequestedEvidence[]): string[] {
  return [...new Set(requested.map((r) => r.evidenceType))];
}

/**
 * Deterministic starting point for the strategist. Advice only: Alibi never
 * concedes or refunds on its own (SPEC §12).
 *   every item satisfied, no gaps  → fight
 *   something satisfied            → fight_with_gaps
 *   nothing satisfied (or nothing requested) → consider_conceding
 */
export function baselineStance(checklist: readonly ChecklistItem[]): Stance {
  if (checklist.length === 0) return "consider_conceding";
  const anySatisfied = checklist.some((c) => c.satisfiedBy.length > 0);
  const allClean = checklist.every((c) => c.satisfiedBy.length > 0 && !c.gap);
  if (allClean) return "fight";
  return anySatisfied ? "fight_with_gaps" : "consider_conceding";
}
