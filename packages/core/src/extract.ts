// Fact extractors for the evidence guard (SPEC §5.5 step 2).
//
// extractFacts() pulls every checkable fact out of a piece of text: quoted
// strings, dates, money amounts, identifiers (order ids, tracking numbers,
// transaction ids), carrier names and bare numbers. Each pass blanks out what
// it consumed so later passes never double-count. For example, the "84.00" in
// "$84.00" is an amount, not also a number.
//
// Worked example:
//   'Order #1042 for $84.00 shipped via UPS (1Z999AA10123456784) on Oct 2, 2026; buyer wrote "thanks, got it".'
//   → quote     "thanks, got it"
//     date      2026-10-02
//     amount    84 ($)
//     identifier 1042, 1Z999AA10123456784
//     carrier   UPS
//
// Known limits, which the optional LLM check (SPEC §5.5 step 5) covers:
// numbers written as words ("two days"), item names, and tracking numbers
// written with internal spaces are not extracted. The drafter prompt asks for
// compact identifiers and "Oct 2, 2026"-style dates.

export type ExtractedFact = { raw: string; start: number; end: number } & (
  | { type: "quote"; text: string }
  | { type: "date"; year?: number; month: number; day?: number }
  /** e.g. 02/10/2026: could be Feb 10 or Oct 2. Never verifiable → claim dropped. */
  | { type: "ambiguous_date" }
  /** value is canonical decimal ("84", "1234.5"); currency is ISO code, "$" (any dollar), or undefined. */
  | { type: "amount"; value: string; currency: string | undefined }
  /** id is normalised: uppercase, no "#" or "-". */
  | { type: "identifier"; id: string }
  | { type: "carrier"; carrier: string }
  | { type: "number"; value: string }
);

export type FactType = ExtractedFact["type"];

// ---------- months ----------

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
// Title Case or UPPER CASE only, no "i" flag: "you may 2…" in prose must not become May 2.
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
  "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sept", "Sep", "Oct", "Nov", "Dec",
];
const MONTH_RE = `(${[...MONTH_NAMES, ...MONTH_NAMES.map((m) => m.toUpperCase())].join("|")})\\.?`;

// ---------- currencies ----------

const CURRENCY_CODES = [
  "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "JPY", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF",
  "MXN", "BRL", "HKD", "SGD", "TWD", "THB", "PHP", "ILS", "INR", "CNY", "NGN", "ZAR", "KES", "GHS",
] as const;
const CODE_RE = `(${CURRENCY_CODES.join("|")})`;
const SYMBOLS: Record<string, string> = {
  "US$": "USD", "CA$": "CAD", C$: "CAD", "AU$": "AUD", A$: "AUD", "NZ$": "NZD",
  $: "$", "€": "EUR", "£": "GBP", "¥": "JPY", "₦": "NGN", "₹": "INR",
};
const SYMBOL_RE = "(US\\$|CA\\$|C\\$|AU\\$|A\\$|NZ\\$|\\$|€|£|¥|₦|₹)";
// 1,234.56 · 1.234,56 · 1234.56 · 84 · 84,00
const NUM_RE = "(\\d{1,3}(?:[,.\\u00a0]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";

/** Is a claimed currency compatible with a recorded one? "$" means some dollar. */
export function currenciesCompatible(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  if (a === b) return true;
  const dollars = new Set(["$", "USD", "CAD", "AUD", "NZD", "HKD", "SGD", "TWD", "MXN"]);
  return (a === "$" && dollars.has(b)) || (b === "$" && dollars.has(a));
}

// ---------- carriers (names → PayPal tracking_info.carrier_name enum) ----------

export const CARRIERS: readonly { carrier: string; re: RegExp }[] = [
  { carrier: "USPS", re: /\bUSPS\b/g },
  { carrier: "UPS", re: /\bUPS\b/g }, // case-sensitive: "ups" in prose is not a carrier
  { carrier: "FEDEX", re: /\bFed\s?Ex\b/gi },
  { carrier: "DHL", re: /\bDHL\b/g },
  { carrier: "ROYAL_MAIL", re: /\bRoyal Mail\b/gi },
  { carrier: "CANADA_POST", re: /\bCanada Post\b/gi },
  { carrier: "AUSTRALIA_POST", re: /\bAustralia Post\b/gi },
  { carrier: "DPD", re: /\bDPD\b/g },
  { carrier: "GLS", re: /\bGLS\b/g },
  { carrier: "ONTRAC", re: /\bOnTrac\b/gi },
  { carrier: "NIPOST_NG", re: /\bNIPOST\b/gi },
];

/** Maps a free-text carrier name or PayPal enum value to the enum value, if known. */
export function carrierCode(name: string): string | undefined {
  const upper = name.trim().toUpperCase().replace(/\s+/g, "_");
  if (CARRIERS.some((c) => c.carrier === upper)) return upper;
  for (const c of CARRIERS) {
    c.re.lastIndex = 0;
    if (new RegExp(c.re.source, c.re.flags.replace("g", "")).test(name)) return c.carrier;
  }
  return undefined;
}

// ---------- normalisers ----------

/**
 * Parses a number written with thousands and decimal separators into a
 * canonical decimal string.
 *   "1,234.56" → "1234.56"   "1.234,56" → "1234.56"   "84,00" → "84"
 *   "1,234"    → "1234"      "0.125"    → "0.125"     "84.50" → "84.5"
 */
export function canonicalDecimal(s: string): string | undefined {
  let t = s.replace(/[\u00a0 ]/g, "");
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  let decimalSep: "," | "." | undefined;
  if (lastComma >= 0 && lastDot >= 0) decimalSep = lastComma > lastDot ? "," : ".";
  else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const parts = t.split(sep);
    const after = parts.at(-1) ?? "";
    // Several separators, or exactly three digits after a non-zero integer part: thousands.
    const thousands = parts.length > 2 || (after.length === 3 && parts[0] !== "0");
    decimalSep = thousands ? undefined : sep;
  }
  const thousandsSep = decimalSep === "," ? "." : decimalSep === "." ? "," : undefined;
  if (thousandsSep) t = t.split(thousandsSep).join("");
  else t = t.replace(/[.,]/g, "");
  if (decimalSep === ",") t = t.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  let [int = "0", frac = ""] = t.split(".");
  int = int.replace(/^0+(?=\d)/, "");
  frac = frac.replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

export function normaliseIdentifier(s: string): string {
  return s.trim().replace(/^#/, "").replace(/[-\s]/g, "").toUpperCase();
}

/** Whitespace-collapsed, typographic quotes/apostrophes/dashes unified, lower-cased. */
export function normaliseQuote(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ---------- extraction ----------

interface Work {
  text: string; // with consumed spans blanked
  facts: ExtractedFact[];
}

function consume(w: Work, start: number, end: number) {
  w.text = w.text.slice(0, start) + " ".repeat(end - start) + w.text.slice(end);
}

function pass(w: Work, source: string, flags: string, make: (m: RegExpExecArray) => ExtractedFact | undefined | null) {
  const re = new RegExp(source, flags.includes("g") ? flags : flags + "g");
  const snapshot = w.text;
  const hits: ExtractedFact[] = [];
  for (let m = re.exec(snapshot); m; m = re.exec(snapshot)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const fact = make(m);
    if (fact) hits.push(fact);
  }
  for (const f of hits) {
    consume(w, f.start, f.end);
    w.facts.push(f);
  }
}

function validDay(month: number, day: number) {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

export function extractFacts(input: string): ExtractedFact[] {
  const w: Work = { text: input, facts: [] };
  const raw = (m: RegExpExecArray) => ({ raw: input.slice(m.index, m.index + m[0].length), start: m.index, end: m.index + m[0].length });

  // 1. Quotes — checked as a whole; nothing inside is extracted separately.
  pass(w, '"([^"\\n]{3,}?)"|\u201C([^\u201D\\n]{3,}?)\u201D', "g", (m) => ({
    type: "quote",
    text: (m[1] ?? m[2] ?? "").trim(),
    ...raw(m),
  }));

  // 2. Dates.
  pass(w, "\\b(\\d{4})-(\\d{2})-(\\d{2})(?:T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?\\b", "g", (m) => {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDay(mo, d) ? { type: "date", year: y, month: mo, day: d, ...raw(m) } : null;
  });
  // "Oct 2, 2026", "October 2nd", "Oct. 2 2026"
  pass(w, `\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4})\\b)?`, "g", (m) => {
    const month = MONTHS[(m[1] ?? "").toLowerCase()]!;
    const day = Number(m[2]);
    if (!validDay(month, day)) return null;
    return { type: "date", month, day, ...(m[3] ? { year: Number(m[3]) } : {}), ...raw(m) };
  });
  // "2 October 2026", "2nd of Oct"
  pass(w, `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4})\\b)?`, "g", (m) => {
    const month = MONTHS[(m[2] ?? "").toLowerCase()]!;
    const day = Number(m[1]);
    if (!validDay(month, day)) return null;
    return { type: "date", month, day, ...(m[3] ? { year: Number(m[3]) } : {}), ...raw(m) };
  });
  // "October 2026"
  pass(w, `\\b${MONTH_RE}\\s+(\\d{4})\\b`, "g", (m) => ({
    type: "date",
    month: MONTHS[(m[1] ?? "").toLowerCase()]!,
    year: Number(m[2]),
    ...raw(m),
  }));
  // 10/02/2026, 2.10.26 — unambiguous only if one side is > 12 (or both equal).
  pass(w, "\\b(\\d{1,2})[/.](\\d{1,2})[/.](\\d{4}|\\d{2})\\b", "g", (m) => {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const yy = Number(m[3]);
    const year = (m[3] ?? "").length === 2 ? 2000 + yy : yy;
    if (a > 12 && validDay(b, a)) return { type: "date", year, month: b, day: a, ...raw(m) };
    if (b > 12 && validDay(a, b)) return { type: "date", year, month: a, day: b, ...raw(m) };
    if (a === b && validDay(a, b)) return { type: "date", year, month: a, day: b, ...raw(m) };
    if (validDay(a, b) && validDay(b, a)) return { type: "ambiguous_date", ...raw(m) };
    return null;
  });

  // 3. Amounts: symbol prefix, code prefix, code/symbol suffix.
  const amount = (m: RegExpExecArray, num: string | undefined, currency: string | undefined): ExtractedFact | null => {
    const value = num === undefined ? undefined : canonicalDecimal(num);
    return value === undefined ? null : { type: "amount", value, currency, ...raw(m) };
  };
  pass(w, `${SYMBOL_RE}\\s?${NUM_RE}(?!\\d)`, "g", (m) => amount(m, m[2], SYMBOLS[m[1] ?? ""]));
  pass(w, `\\b${CODE_RE}\\s?${NUM_RE}(?!\\d)`, "g", (m) => amount(m, m[2], m[1]));
  pass(w, `(?<![\\d.,])${NUM_RE}\\s?${CODE_RE}\\b`, "g", (m) => amount(m, m[1], m[2]));
  pass(w, `(?<![\\d.,])${NUM_RE}\\s?(€|£)`, "g", (m) => amount(m, m[1], SYMBOLS[m[2] ?? ""]));

  // 4. Identifiers: "#1042", "PP-D-12345", "1Z999AA10123456784", "9400111899223817421234".
  pass(w, "(?<![A-Za-z0-9#-])#?[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*", "g", (m) => {
    const token = m[0];
    const core = token.replace(/^#/, "").replace(/-/g, "");
    const hasDigit = /\d/.test(core);
    const hasLetter = /[A-Za-z]/.test(core);
    const isId =
      hasDigit &&
      ((token.startsWith("#") && core.length > 0) ||
        (hasLetter && core.length >= 5) ||
        (!hasLetter && core.length >= 6) ||
        (token.includes("-") && core.length >= 5));
    return isId ? { type: "identifier", id: normaliseIdentifier(token), ...raw(m) } : null;
  });

  // 5. Carriers.
  for (const c of CARRIERS) pass(w, c.re.source, c.re.flags, (m) => ({ type: "carrier", carrier: c.carrier, ...raw(m) }));

  // 6. Remaining bare numbers ("3 items", "1,250").
  pass(w, "(?<![\\w.,])(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)(?![\\w]|[.,]\\d)", "g", (m) => {
    const value = canonicalDecimal(m[1] ?? "");
    return value === undefined ? null : { type: "number", value, ...raw(m) };
  });

  return w.facts.sort((a, b) => a.start - b.start);
}
