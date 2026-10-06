import { createHash } from "node:crypto";

// Deterministic hashing helpers. Server-side only (node:crypto); the browser
// never needs to compute evidence ids or draft hashes.

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * JSON with object keys sorted at every level, so logically equal values hash
 * equally regardless of key insertion order. `undefined` fields are omitted,
 * as in JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
