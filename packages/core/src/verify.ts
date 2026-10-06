import { buildRecordFacts, isValidTimeZone, type RecordFacts } from "./record-facts.js";
import { carrierCode, currenciesCompatible, extractFacts, normaliseIdentifier, normaliseQuote, type ExtractedFact } from "./extract.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import { PROVIDE_EVIDENCE_NOTES_MAX } from "./paypal-enums.js";
import type { CaseFile, ChecklistItem, DraftClaim, EvidenceRecord, SubmissionRoute, TrackingInfo } from "./types.js";

// Draft verifier (SPEC §5.5, CLAUDE §1.2). Pure and deterministic.
//
//   1. Every cited evidence id exists, and every claim cites at least one.
//   2. Every amount, date, identifier, carrier, number and quote in a claim
//      matches a value in that claim's *own* cited records. One miss drops the
//      whole claim: unsupported claims are removed, not softened.
//   3. Every requested evidence type is either addressed — through a route
//      PayPal accepts for it under this reason — or listed as a gap.
//   4. Notes = surviving claims joined, within PayPal's notes limit. When over,
//      the lowest-priority claims (last in the list) are dropped whole.
//   6. The draft hash binds a merchant approval to this exact content.
// (Step 5, the optional LLM check, lives in @alibi/agent.)
//
// Worked example:
//   evidence: ev_tx  { kind: transaction, ref: "8XY…", value: "84.00 USD", occurredAt: 2026-10-02 }
//             ev_ship{ kind: fulfilment,  ref: "1Z999AA10123456784", value: "UPS 1Z999AA10123456784" }
//   claim A: "The buyer paid $84.00 on Oct 2, 2026."            cites [ev_tx]   → kept
//   claim B: "Shipped via UPS, tracking 1Z999AA10123456785."    cites [ev_ship] → dropped:
//            Identifier "1Z999AA10123456785" not found in the cited evidence
//   claim C: "The buyer paid $48.00."                            cites [ev_tx]   → dropped:
//            Amount "$48.00" does not match the cited evidence

export interface DraftInput {
  claims: DraftClaim[]; // priority order: first = most important
  evidenceInfo?: { trackingInfo?: TrackingInfo[]; refundIds?: string[] };
  documents: string[];
}

export interface VerifyOptions {
  notesMax?: number;
  /**
   * Merchant's IANA time zone: a record's occurredAt also matches its local
   * date and time. Without it, claimed times must match UTC. An invalid zone is
   * ignored with a warning, never thrown.
   */
  timeZone?: string;
}

export type Coverage =
  | { evidenceType: string; status: "addressed"; citedBy: number[]; gap?: string }
  | { evidenceType: string; status: "gap"; gap: string };

export interface VerifiedDraft {
  claims: DraftClaim[];
  notes: string;
  evidenceInfo?: { trackingInfo?: TrackingInfo[]; refundIds?: string[] };
  documents: string[];
  removed: { text: string; reason: string }[];
  coverage: Coverage[];
  /** Problems with the verification itself (e.g. bad config), shown to the merchant. */
  warnings: string[];
  draftHash: string;
}

export const NOTES_SEPARATOR = "\n\n";

export function verifyDraft(
  draft: DraftInput,
  evidence: Readonly<Record<string, EvidenceRecord>>,
  checklist: readonly ChecklistItem[],
  opts: VerifyOptions = {},
): VerifiedDraft {
  const notesMax = opts.notesMax ?? PROVIDE_EVIDENCE_NOTES_MAX;
  const removed: { text: string; reason: string }[] = [];
  const warnings: string[] = [];
  const timeZone = opts.timeZone && isValidTimeZone(opts.timeZone) ? opts.timeZone : undefined;
  if (opts.timeZone && !timeZone) {
    warnings.push(`Unknown time zone "${opts.timeZone}"; dates and times were checked in UTC only.`);
  }
  const factsCache = new Map<string, RecordFacts>();
  const factsOf = (r: EvidenceRecord) => {
    let f = factsCache.get(r.id);
    if (!f) factsCache.set(r.id, (f = buildRecordFacts(r, timeZone)));
    return f;
  };

  // Steps 1–2: per-claim checks.
  let claims: DraftClaim[] = [];
  for (const claim of draft.claims) {
    const text = claim.text.trim();
    if (!text) continue;
    const reason = checkClaim(text, claim.evidenceIds, evidence, factsOf);
    if (reason) removed.push({ text, reason });
    else claims.push({ text, evidenceIds: [...new Set(claim.evidenceIds)] });
  }

  // Step 4: notes length — drop whole claims from the end, never truncate.
  while (claims.length && joinNotes(claims).length > notesMax) {
    const dropped = claims.pop()!;
    removed.push({
      text: dropped.text,
      reason: `Notes over PayPal's ${notesMax}-character limit; dropped lowest-priority claim`,
    });
  }
  const notes = joinNotes(claims);

  // Structured evidence_info and documents must also trace to records.
  const evidenceInfo = verifyEvidenceInfo(draft.evidenceInfo, evidence, factsOf, removed);
  const documents: string[] = [];
  for (const id of draft.documents) {
    const r = evidence[id];
    if (!r) removed.push({ text: `Document ${id}`, reason: `Unknown evidence id ${id}` });
    else if (!r.documentUrl) removed.push({ text: `Document: ${r.label}`, reason: "Evidence record has no attachable document" });
    else if (!documents.includes(id)) documents.push(id);
  }

  // Step 3: coverage.
  const coverage = checklist.map((item) => coverageFor(item, claims, evidenceInfo, documents, evidence));

  const verified = { claims, notes, ...(evidenceInfo ? { evidenceInfo } : {}), documents };
  return { ...verified, removed, coverage, warnings, draftHash: draftHash(verified) };
}

function joinNotes(claims: readonly DraftClaim[]): string {
  return claims.map((c) => c.text).join(NOTES_SEPARATOR);
}

function checkClaim(
  text: string,
  evidenceIds: readonly string[],
  evidence: Readonly<Record<string, EvidenceRecord>>,
  factsOf: (r: EvidenceRecord) => RecordFacts,
): string | undefined {
  if (evidenceIds.length === 0) return "Cites no evidence";
  const unknown = evidenceIds.filter((id) => !evidence[id]);
  if (unknown.length) return `Cites unknown evidence id${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`;
  const cited = evidenceIds.map((id) => factsOf(evidence[id]!));
  const failures = extractFacts(text)
    .map((f) => (supported(f, cited) ? undefined : failureMessage(f)))
    .filter((m): m is string => m !== undefined);
  return failures.length ? failures.join("; ") : undefined;
}

function supported(f: ExtractedFact, cited: readonly RecordFacts[]): boolean {
  switch (f.type) {
    case "quote": {
      const q = normaliseQuote(f.text);
      return cited.some((c) => c.texts.some((t) => t.includes(q)));
    }
    case "date":
      return cited.some((c) =>
        c.dates.some(
          (d) =>
            d.month === f.month &&
            (f.day === undefined || d.day === f.day) &&
            (f.year === undefined || d.year === undefined || d.year === f.year),
        ),
      );
    case "ambiguous_date":
      return false;
    case "time":
      return cited.some((c) =>
        c.times.some(
          (t) =>
            (t.hour === f.hour || (f.anyMeridiem === true && t.hour === f.hour + 12)) &&
            (f.minute === undefined || t.minute === f.minute),
        ),
      );
    case "amount":
      // A claim that names a currency needs a record that names a compatible
      // one: "€84" is not supported by a bare 84. A currency-less claim
      // ("84.00") may match a bare number.
      return cited.some(
        (c) =>
          c.amounts.some((a) => a.value === f.value && currenciesCompatible(f.currency, a.currency)) ||
          (f.currency === undefined && c.numbers.has(f.value)),
      );
    case "identifier":
      return cited.some((c) => c.identifiers.has(f.id));
    case "carrier":
      return cited.some((c) => c.carriers.has(f.carrier));
    case "number":
      return cited.some(
        (c) =>
          c.numbers.has(f.value) ||
          c.identifiers.has(f.value) ||
          c.amounts.some((a) => a.value === f.value) ||
          c.dates.some((d) => d.year !== undefined && String(d.year) === f.value), // "in 2026"
      );
  }
}

function failureMessage(f: ExtractedFact): string {
  switch (f.type) {
    case "quote":
      return `Quote "${f.text}" does not appear in the cited evidence`;
    case "date":
      return `Date "${f.raw}" does not match any date in the cited evidence`;
    case "time":
      return `Time "${f.raw}" does not match the cited evidence`;
    case "ambiguous_date":
      return `Date "${f.raw}" is ambiguous (day/month order); write it as e.g. "Oct 2, 2026"`;
    case "amount":
      return `Amount "${f.raw}" does not match the cited evidence`;
    case "identifier":
      return `Identifier "${f.raw}" not found in the cited evidence`;
    case "carrier":
      return `Carrier "${f.raw}" not named in the cited evidence`;
    case "number":
      return `Number "${f.raw}" not found in the cited evidence`;
  }
}

function verifyEvidenceInfo(
  info: DraftInput["evidenceInfo"],
  evidence: Readonly<Record<string, EvidenceRecord>>,
  factsOf: (r: EvidenceRecord) => RecordFacts,
  removed: { text: string; reason: string }[],
): VerifiedDraft["evidenceInfo"] {
  if (!info) return undefined;
  const records = Object.values(evidence);
  const out: NonNullable<VerifiedDraft["evidenceInfo"]> = {};

  if (info.trackingInfo) {
    const kept: TrackingInfo[] = [];
    for (const t of info.trackingInfo) {
      const label = `Tracking ${t.carrier} ${t.number}`;
      const num = normaliseIdentifier(t.number);
      const shipments = records.filter(
        (r) => (r.kind === "fulfilment" || r.kind === "carrier_event") && factsOf(r).identifiers.has(num),
      );
      if (!shipments.length) {
        removed.push({ text: label, reason: `Tracking number "${t.number}" not found in any shipment record` });
        continue;
      }
      // The drafter may send a PayPal enum ("UPS"), a name ("FedEx"), or
      // OTHER + carrierOther ("Evri"). Carriers PayPal doesn't list go out as
      // OTHER + carrier_name_other, never as a free-text carrier_name.
      const name = t.carrier.toUpperCase() === "OTHER" ? (t.carrierOther ?? "") : t.carrier;
      const code = carrierCode(name);
      const carrierOk =
        name.trim() !== "" &&
        shipments.some((r) => (code ? factsOf(r).carriers.has(code) : factsOf(r).texts.some((x) => x.includes(normaliseQuote(name)))));
      if (!carrierOk) {
        removed.push({ text: label, reason: `Carrier "${name || t.carrier}" not named in the shipment record for ${t.number}` });
        continue;
      }
      kept.push(code ? { carrier: code, number: t.number } : { carrier: "OTHER", carrierOther: name.trim(), number: t.number });
    }
    if (kept.length) out.trackingInfo = kept;
  }

  if (info.refundIds) {
    const kept: string[] = [];
    for (const id of info.refundIds) {
      const ok = records.some((r) => r.kind === "refund" && normaliseIdentifier(r.ref) === normaliseIdentifier(id));
      if (ok) kept.push(id);
      else removed.push({ text: `Refund ${id}`, reason: `Refund id "${id}" not found in any refund record` });
    }
    if (kept.length) out.refundIds = kept;
  }

  return out.trackingInfo || out.refundIds ? out : undefined;
}

function coverageFor(
  item: ChecklistItem,
  claims: readonly DraftClaim[],
  info: VerifiedDraft["evidenceInfo"],
  documents: readonly string[],
  evidence: Readonly<Record<string, EvidenceRecord>>,
): Coverage {
  // Unmapped types have no routes: anything that uses their records counts.
  const routes: readonly SubmissionRoute[] = item.routes ?? ["tracking_info", "refund_ids", "notes_or_documents"];
  const satisfying = new Set(item.satisfiedBy);
  const refOf = (id: string) => normaliseIdentifier(evidence[id]?.ref ?? "");
  const citedBy = claims.flatMap((c, i) => (c.evidenceIds.some((id) => satisfying.has(id)) ? [i] : []));

  const viaNotes = routes.includes("notes_or_documents") && (citedBy.length > 0 || documents.some((id) => satisfying.has(id)));
  const viaTracking =
    routes.includes("tracking_info") &&
    (info?.trackingInfo ?? []).some((t) => item.satisfiedBy.some((id) => refOf(id) === normaliseIdentifier(t.number)));
  const viaRefund =
    routes.includes("refund_ids") &&
    (info?.refundIds ?? []).some((rid) => item.satisfiedBy.some((id) => refOf(id) === normaliseIdentifier(rid)));

  if (viaNotes || viaTracking || viaRefund) {
    return item.gap
      ? { evidenceType: item.evidenceType, status: "addressed", citedBy, gap: item.gap }
      : { evidenceType: item.evidenceType, status: "addressed", citedBy };
  }

  // Records are used, but not in a form PayPal accepts for this type.
  if (citedBy.length || documents.some((id) => satisfying.has(id))) {
    return { evidenceType: item.evidenceType, status: "gap", gap: wrongRouteGap(item.evidenceType, routes) };
  }
  return {
    evidenceType: item.evidenceType,
    status: "gap",
    gap:
      item.gap ??
      (item.satisfiedBy.length
        ? `Records on file support ${item.evidenceType}, but no verified claim or attachment uses them.`
        : `No records on file that support ${item.evidenceType}.`),
  };
}

const ROUTE_LABEL: Record<SubmissionRoute, string> = {
  tracking_info: "carrier and tracking number (tracking info)",
  refund_ids: "refund ID",
  notes_or_documents: "notes or documents",
};

function wrongRouteGap(evidenceType: string, routes: readonly SubmissionRoute[]): string {
  return `PayPal accepts ${evidenceType} for this dispute reason only as ${routes.map((r) => ROUTE_LABEL[r]).join(" or ")}; mentioning it in the notes doesn't count.`;
}

// ---------- approval binding (step 6) ----------

/** Hash of exactly what would be sent to PayPal. Any edit changes it. */
export function draftHash(draft: Pick<CaseFile["draft"], "claims" | "notes" | "evidenceInfo" | "documents">): string {
  return sha256Hex(
    canonicalJson({
      claims: draft.claims.map((c) => ({ text: c.text, evidenceIds: c.evidenceIds })),
      notes: draft.notes,
      evidenceInfo: draft.evidenceInfo ?? null,
      documents: draft.documents,
    }),
  );
}

/** An approval only counts if it was given for the current draft content. */
export function isApprovalValid(cf: Pick<CaseFile, "approval" | "draft">): boolean {
  return cf.approval !== undefined && cf.approval.draftHash === draftHash(cf.draft);
}

/**
 * Applies a merchant edit: re-runs verification on the edited draft and drops
 * any prior approval. The merchant must approve the new content again.
 */
export function applyMerchantEdit(
  cf: CaseFile,
  edited: DraftInput,
  opts: VerifyOptions = {},
): { caseFile: CaseFile; verified: VerifiedDraft } {
  const verified = verifyDraft(edited, cf.evidence, cf.checklist, opts);
  const { approval: _dropped, ...rest } = cf;
  const caseFile: CaseFile = {
    ...rest,
    draft: {
      claims: verified.claims,
      notes: verified.notes,
      ...(verified.evidenceInfo ? { evidenceInfo: verified.evidenceInfo } : {}),
      documents: verified.documents,
    },
    removedByVerifier: verified.removed,
  };
  return { caseFile, verified };
}
