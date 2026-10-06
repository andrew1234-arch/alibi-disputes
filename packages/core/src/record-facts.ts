import { CARRIERS, canonicalDecimal, extractFacts, normaliseIdentifier, normaliseQuote } from "./extract.js";
import type { EvidenceRecord } from "./types.js";

// The facts an evidence record can vouch for, in the same normalised forms the
// extractor produces for claims, so the verifier compares like with like.
//
// Example: { kind: "transaction", ref: "8XY12345AB678901C", label: "PayPal capture",
//            value: "84.00 USD", occurredAt: "2026-10-02T14:03:00Z" }
//   → amounts {84 USD}, identifiers {8XY12345AB678901C}, dates {2026-10-02}

export interface RecordFacts {
  texts: string[]; // normalised label and value, for quote matching
  dates: { year?: number; month: number; day?: number }[];
  amounts: { value: string; currency: string | undefined }[];
  identifiers: Set<string>;
  numbers: Set<string>;
  carriers: Set<string>;
}

export function buildRecordFacts(r: EvidenceRecord, timeZone?: string): RecordFacts {
  const value = String(r.value);
  const out: RecordFacts = {
    texts: [normaliseQuote(r.label), normaliseQuote(value)],
    dates: [],
    amounts: [],
    identifiers: new Set(),
    numbers: new Set(),
    carriers: new Set(),
  };

  // The ref is an identifier by definition, whatever its length.
  if (r.ref.trim()) out.identifiers.add(normaliseIdentifier(r.ref));
  if (typeof r.value === "number" && Number.isFinite(r.value)) {
    const v = canonicalDecimal(String(r.value));
    if (v) out.numbers.add(v);
  }

  // Carrier enums like "ROYAL_MAIL" are matched as "Royal Mail".
  for (const text of [r.label, value, r.ref]) {
    for (const f of extractFacts(text)) {
      switch (f.type) {
        case "date":
          out.dates.push({ month: f.month, ...(f.year !== undefined ? { year: f.year } : {}), ...(f.day !== undefined ? { day: f.day } : {}) });
          break;
        case "amount":
          out.amounts.push({ value: f.value, currency: f.currency });
          break;
        case "identifier":
          out.identifiers.add(f.id);
          break;
        case "number":
          out.numbers.add(f.value);
          break;
        case "carrier":
          out.carriers.add(f.carrier);
          break;
        case "quote":
        case "ambiguous_date":
          break;
      }
    }
    const spaced = text.replace(/_/g, " ");
    for (const c of CARRIERS) if (new RegExp(c.re.source, c.re.flags.replace("g", "")).test(spaced)) out.carriers.add(c.carrier);
  }

  if (r.occurredAt) {
    const t = Date.parse(r.occurredAt);
    if (!Number.isNaN(t)) {
      out.dates.push(calendarDate(t, "UTC"));
      if (timeZone) out.dates.push(calendarDate(t, timeZone));
    }
  }
  return out;
}

function calendarDate(t: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(t);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}
