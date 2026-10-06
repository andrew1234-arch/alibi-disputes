import { describe, expect, it } from "vitest";
import { evidenceId, indexEvidence, makeEvidenceRecord, timeline } from "../src/evidence.js";
import { canonicalJson } from "../src/hash.js";
import { buyerMsg, delivered, order, shipment, tx } from "./fixtures.js";

describe("evidence records", () => {
  it("ids are stable and ignore label and fetchedAt", () => {
    const base = { source: "paypal", kind: "transaction", ref: "TX1", value: "84.00 USD" } as const;
    const a = makeEvidenceRecord({ ...base, label: "a", fetchedAt: "2026-10-01T00:00:00Z" });
    const b = makeEvidenceRecord({ ...base, label: "b", fetchedAt: "2026-10-09T00:00:00Z" });
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^ev_[0-9a-f]{16}$/);
    expect(evidenceId({ ...base, source: "merchant_demo" })).not.toBe(a.id);
    expect(evidenceId({ ...base, value: 84 })).not.toBe(evidenceId({ ...base, value: "84" }));
  });

  it("repeated identical carrier scans at different times are distinct facts", () => {
    const scan = { source: "merchant_demo", kind: "carrier_event", ref: "1Z999AA10123456784", label: "UPS scan", value: "In transit", fetchedAt: "x" } as const;
    const oct3 = makeEvidenceRecord({ ...scan, occurredAt: "2026-10-03T08:00:00Z" });
    const oct4 = makeEvidenceRecord({ ...scan, occurredAt: "2026-10-04T08:00:00Z" });
    expect(oct3.id).not.toBe(oct4.id);
    expect(Object.keys(indexEvidence([oct3, oct4]))).toHaveLength(2);
  });

  it("timeline orders by occurredAt, undated last", () => {
    const undated = makeEvidenceRecord({ source: "merchant_demo", kind: "policy", ref: "returns", label: "Return policy", value: "30 days", fetchedAt: "x" });
    expect(timeline([delivered, undated, tx, buyerMsg, order, shipment]).map((r) => r.id)).toEqual(
      [order, tx, shipment, delivered, buyerMsg, undated].map((r) => r.id),
    );
  });

  it("indexEvidence keys by id", () => {
    expect(Object.keys(indexEvidence([tx, order]))).toEqual([tx.id, order.id]);
  });

  it("canonicalJson ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":2,"y":1}]},"b":1}');
  });
});
