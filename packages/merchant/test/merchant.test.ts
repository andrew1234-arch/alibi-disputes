import { describe, expect, it } from "vitest";
import { buildChecklist, baselineStance } from "@alibi/core";
import { buildScenarioRecords, DemoStore, SCENARIOS, scenario } from "../src/index";

const tx = { transactionId: "8XY12345AB678901C", paidAt: "2026-10-06T12:00:00.000Z" };
const later = new Date("2026-10-20T00:00:00Z");
const INR = "MERCHANDISE_OR_SERVICE_NOT_RECEIVED";
const pof = [{ evidenceType: "PROOF_OF_FULFILLMENT", source: "REQUESTED_FROM_SELLER" }];

describe("demo scenarios", () => {
  it("every record is merchant_demo, never PayPal", () => {
    for (const s of SCENARIOS) expect(buildScenarioRecords(s, tx, later).every((r) => r.source === "merchant_demo")).toBe(true);
  });

  it("times are offsets from the real payment; future events are omitted", () => {
    const s = scenario("inr-delivered")!;
    const all = buildScenarioRecords(s, tx, later);
    expect(all.find((r) => r.kind === "order")?.occurredAt).toBe("2026-10-06T12:00:00.000Z");
    expect(all.find((r) => /Delivered/.test(String(r.value)))?.occurredAt).toBe("2026-10-09T19:00:00.000Z");
    const early = buildScenarioRecords(s, tx, new Date("2026-10-08T00:00:00Z"));
    expect(early.some((r) => /Delivered/.test(String(r.value)))).toBe(false);
  });

  it("scenarios produce the intended stances", () => {
    const stance = (id: string) => baselineStance(buildChecklist(INR, pof, buildScenarioRecords(scenario(id)!, tx, later)));
    expect(stance("inr-delivered")).toBe("fight");
    expect(stance("inr-in-transit")).toBe("fight_with_gaps");
    expect(stance("inr-no-tracking")).toBe("consider_conceding");
  });

  it("order records carry money with currency (verifier convention)", () => {
    const order = buildScenarioRecords(scenario("inr-delivered")!, tx, later).find((r) => r.kind === "order");
    expect(order?.value).toContain("84.00 USD");
  });
});

describe("DemoStore", () => {
  const store = new DemoStore([{ scenario: "inr-delivered", transactionId: tx.transactionId }]);

  it("returns records only for linked transactions", async () => {
    expect((await store.recordsForTransaction(tx, later)).length).toBeGreaterThan(0);
    expect(await store.recordsForTransaction({ ...tx, transactionId: "OTHER" }, later)).toEqual([]);
  });

  it("serves proof-of-delivery PDFs with the demo banner", async () => {
    const recs = await store.recordsForTransaction(tx, later);
    const url = recs.find((r) => r.documentUrl)?.documentUrl;
    expect(url).toBe("/api/demo-documents/inr-delivered/proof-of-delivery-1042.pdf");
    const doc = await store.document(url!);
    const text = new TextDecoder().decode(doc!.bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("DEMO MERCHANT DATA");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(await store.document("/api/demo-documents/inr-delivered/../../etc/passwd")).toBeUndefined();
  });

  it("PDF xref offsets point at their objects", async () => {
    const doc = await store.document("/api/demo-documents/inr-delivered/proof-of-delivery-1042.pdf");
    const text = new TextDecoder().decode(doc!.bytes);
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });
});
