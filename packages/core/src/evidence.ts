import { canonicalJson, sha256Hex } from "./hash.js";
import type { EvidenceRecord } from "./types.js";

// Evidence records (SPEC §4). The id is a stable hash of (source, kind, ref,
// value), so re-fetching the same fact yields the same id and citations in
// cached drafts stay valid.
//
// Conventions adapters must follow, so the checklist and verifier can use them:
//   fulfilment     ref = tracking number, label/value name the carrier
//                  e.g. { ref: "1Z999AA10123456784", label: "Shipped via UPS", value: "UPS 1Z999AA10123456784" }
//   carrier_event  ref = tracking number, value = carrier's event text
//                  e.g. { ref: "1Z999AA10123456784", label: "UPS scan", value: "Delivered, front door" }
//   refund         ref = PayPal refund id
//   transaction    ref = PayPal transaction / capture id, value = amount text, e.g. "84.00 USD"

export type NewEvidenceRecord = Omit<EvidenceRecord, "id">;

export function evidenceId(r: Pick<EvidenceRecord, "source" | "kind" | "ref" | "value">): string {
  return `ev_${sha256Hex(canonicalJson([r.source, r.kind, r.ref, r.value])).slice(0, 16)}`;
}

export function makeEvidenceRecord(r: NewEvidenceRecord): EvidenceRecord {
  return { id: evidenceId(r), ...r };
}

/** Indexes records by id. Throws on a duplicate id with different content (a hashing bug, never expected). */
export function indexEvidence(records: readonly EvidenceRecord[]): Record<string, EvidenceRecord> {
  const out: Record<string, EvidenceRecord> = {};
  for (const r of records) {
    const prev = out[r.id];
    if (prev && canonicalJson({ ...prev, fetchedAt: "" }) !== canonicalJson({ ...r, fetchedAt: "" })) {
      throw new Error(`Evidence id collision: ${r.id}`);
    }
    out[r.id] = r;
  }
  return out;
}

/** Records in time order; records without `occurredAt` go last, in input order. */
export function timeline(records: readonly EvidenceRecord[]): EvidenceRecord[] {
  return records
    .map((r, i) => ({ r, i, t: r.occurredAt ? Date.parse(r.occurredAt) : Number.NaN }))
    .sort((a, b) => {
      const an = Number.isNaN(a.t);
      const bn = Number.isNaN(b.t);
      if (an !== bn) return an ? 1 : -1;
      if (!an && a.t !== b.t) return a.t - b.t;
      return a.i - b.i;
    })
    .map((x) => x.r);
}
