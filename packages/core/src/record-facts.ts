import { CARRIERS, canonicalDecimal, extractFacts, normaliseIdentifier, normaliseQuote } from "./extract";
import type { EvidenceRecord } from "./types";

// The facts an evidence record can vouch for, in the same normalised forms the
// extractor produces for claims, so the verifier compares like with like.
//
// Example: { kind: "transaction", ref: "8XY12345AB678901C", label: "PayPal capture",
//            value: "84.00 USD", occurredAt: "2026-10-02T14:03:00Z" }
//   → amounts {84 USD}, identifiers {8XY12345AB678901C}, dates {2026-10-02}, times {14:03}
// occurredAt contributes its UTC date and time, plus the merchant-local ones
// when a time zone is given.

export interface RecordFacts {
  texts: string[]; // normalised label and value, for quote matching
  dates: { year?: number; month: number; day?: number }[];
  times: { hour: number; minute?: number }[];
  amounts: { value: string; currency: string | undefined }[];
  identifiers: Set<string>;
  numbers: Set<string>;
  carriers: Set<string>;
}

/**
 * True if `tz` is an IANA zone this runtime knows. Callers validate merchant
 * config with this; buildRecordFacts also guards itself so a typo can never
 * crash verification.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `timeZone` must be valid (see isValidTimeZone); an invalid one is ignored, never thrown. */
export function buildRecordFacts(r: EvidenceRecord, timeZone?: string): RecordFacts {
  const value = String(r.value);
  const out: RecordFacts = {
    texts: [normaliseQuote(r.label), normaliseQuote(value)],
    dates: [],
    times: [],
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
        case "time":
          out.times.push({ hour: f.hour, ...(f.minute !== undefined ? { minute: f.minute } : {}) });
          if (f.anyMeridiem) out.times.push({ hour: f.hour + 12, ...(f.minute !== undefined ? { minute: f.minute } : {}) });
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
      for (const zone of timeZone && timeZone !== "UTC" && isValidTimeZone(timeZone) ? ["UTC", timeZone] : ["UTC"]) {
        const local = localParts(t, zone);
        out.dates.push({ year: local.year, month: local.month, day: local.day });
        out.times.push({ hour: local.hour, minute: local.minute });
      }
    }
  }
  return out;
}

function localParts(t: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(t);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}
