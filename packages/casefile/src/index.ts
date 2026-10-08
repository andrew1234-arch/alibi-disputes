import {
  baselineStance,
  buildChecklist,
  carrierCode,
  extractFacts,
  REASON_EVIDENCE_MAP,
  type CaseFile,
  type ChecklistItem,
  type DraftClaim,
  type EvidenceRecord,
  type ReasonEvidenceMap,
  type RequestedEvidence,
  type TrackingInfo,
} from "@alibi/core";
import { indexEvidence, timeline, verifyDraft, type DraftInput, type VerifyOptions } from "@alibi/core/server";

// Case-file engine (SPEC §6.2): the minimal in-repo implementation. Poirot's
// engine may replace the CaseEngine part after Poirot is submitted; the
// assemble/draft functions stay.

export interface CaseEngine {
  ingest(records: EvidenceRecord[]): void;
  timeline(): EvidenceRecord[];
  satisfy(requested: RequestedEvidence[], map: ReasonEvidenceMap): ChecklistItem[];
}

export function createCaseEngine(reason: string): CaseEngine {
  const records = new Map<string, EvidenceRecord>();
  return {
    ingest: (rs) => rs.forEach((r) => records.set(r.id, r)),
    timeline: () => timeline([...records.values()]),
    satisfy: (requested, map) => buildChecklist(reason, requested, [...records.values()], map),
  };
}

export interface DisputeFacts {
  disputeId: string;
  reason: string;
  status: string;
  stage: string;
  amount: { value: string; currency: string; missing?: string };
  dueAt?: string;
  requested: RequestedEvidence[];
}

/**
 * Builds a full CaseFile: evidence, timeline, checklist, baseline stance, and a
 * verified draft. `draft` defaults to the template drafter; M3's LLM drafter
 * passes its own, and either way it goes through the verifier.
 */
export function assembleCaseFile(
  facts: DisputeFacts,
  records: readonly EvidenceRecord[],
  opts: { now: Date; draft?: (parts: CaseParts) => DraftInput; verify?: VerifyOptions },
): CaseFile {
  const engine = createCaseEngine(facts.reason);
  engine.ingest([...records]);
  const ordered = engine.timeline();
  const evidence = indexEvidence(ordered);
  const checklist = engine.satisfy(facts.requested, REASON_EVIDENCE_MAP);
  const parts: CaseParts = { facts, records: ordered, evidence, checklist };
  const v = verifyDraft((opts.draft ?? templateDraft)(parts), evidence, checklist, opts.verify);
  return {
    ...facts,
    timeline: ordered.map((r) => r.id),
    checklist,
    strategy: { stance: baselineStance(checklist), reasons: [] },
    draft: { claims: v.claims, notes: v.notes, ...(v.evidenceInfo ? { evidenceInfo: v.evidenceInfo } : {}), documents: v.documents },
    evidence,
    removedByVerifier: v.removed,
    createdAt: opts.now.toISOString(),
  };
}

export interface CaseParts {
  facts: DisputeFacts;
  records: EvidenceRecord[];
  evidence: Record<string, EvidenceRecord>;
  checklist: ChecklistItem[];
}

// ---------------------------------------------------------------------------
// Template drafter: deterministic, no LLM. Used as the fallback when the LLM is
// unavailable and for the M2 sandbox submission. Every claim is assembled from
// a record's own values, so it passes the verifier by construction. It states
// facts in time order and argues nothing. The LLM drafter (M3) does the arguing.
//
// Example output (inr-delivered):
//   "The buyer paid 84.00 USD on Oct 2, 2026."
//   "The order shipped on Oct 3, 2026 via UPS, tracking number 1Z999AA10123456784."
//   "UPS reported "Delivered, front door, Austin TX" on Oct 5, 2026."
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 2, 2026" in UTC: the verifier's unambiguous date form. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function carrierName(r: EvidenceRecord): string | undefined {
  for (const text of [String(r.value), r.label]) {
    const f = extractFacts(text).find((x) => x.type === "carrier");
    if (f) return f.raw;
  }
  return undefined;
}

export function templateDraft({ records, checklist }: CaseParts): DraftInput {
  const claims: DraftClaim[] = [];
  const add = (text: string, r: EvidenceRecord) => claims.push({ text, evidenceIds: [r.id] });
  const types = new Set(checklist.map((c) => c.evidenceType));
  const relevant = new Set(checklist.flatMap((c) => c.satisfiedBy));

  // Only a record that actually carries an amount can back "the buyer paid X".
  const payment = records.find((r) => r.kind === "transaction" && r.source === "paypal" && r.occurredAt && r.value !== "—");
  if (payment) add(`The buyer paid ${String(payment.value)} on ${formatDate(payment.occurredAt!)}.`, payment);

  const order = records.find((r) => r.kind === "order");
  if (order) add(`${order.label}.`, order);

  const trackingInfo: TrackingInfo[] = [];
  for (const ship of records.filter((r) => r.kind === "fulfilment" && r.occurredAt)) {
    const name = carrierName(ship);
    add(`The order shipped on ${formatDate(ship.occurredAt!)}${name ? ` via ${name}` : ""}, tracking number ${ship.ref}.`, ship);
    const code = name ? carrierCode(name) : undefined;
    if (name) trackingInfo.push(code ? { carrier: code, number: ship.ref } : { carrier: "OTHER", carrierOther: name, number: ship.ref });
  }

  const events = records.filter((r) => r.kind === "carrier_event" && r.occurredAt);
  const last = events.at(-1);
  if (last) add(`${carrierName(last) ?? "The carrier"} reported "${String(last.value)}" on ${formatDate(last.occurredAt!)}.`, last);

  if (types.has("OTHER")) {
    for (const p of records.filter((r) => r.kind === "policy" && relevant.has(r.id))) {
      const first = String(p.value).split(/(?<=\.)\s/)[0]!;
      add(`${p.label}: "${first}"`, p);
    }
  }

  const documents = records.filter((r) => r.documentUrl && relevant.has(r.id)).map((r) => r.id);
  return { claims, ...(trackingInfo.length ? { evidenceInfo: { trackingInfo } } : {}), documents };
}
