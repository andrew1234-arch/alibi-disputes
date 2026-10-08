import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDispute, startStub, STUB_TOKEN, type Stub } from "../src/index";

let stub: Stub;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(() => stub.close());

const auth = { authorization: `Bearer ${STUB_TOKEN}` };

describe("test stub", () => {
  it("requires a token", async () => {
    expect((await fetch(`${stub.url}/v1/customer/disputes`)).status).toBe(401);
  });

  it("offers provide-evidence only while waiting for the seller, then moves to review", async () => {
    stub.setDispute(makeDispute({ dispute_id: "D1" }));
    const d = (await (await fetch(`${stub.url}/v1/customer/disputes/D1`, { headers: auth })).json()) as { links: { rel: string }[] };
    expect(d.links.map((l) => l.rel)).toContain("provide-evidence");

    const form = new FormData();
    form.append("input", new Blob([JSON.stringify({ evidences: [{ evidence_type: "OTHER", notes: "hi" }] })], { type: "application/json" }));
    form.append("evidence-file", new Blob(["%PDF"], { type: "application/pdf" }), "a.pdf");
    const r = await fetch(`${stub.url}/v1/customer/disputes/D1/provide-evidence`, { method: "POST", headers: auth, body: form });
    expect(r.status).toBe(200);
    expect(stub.calls.at(-1)).toMatchObject({
      input: { evidences: [{ evidence_type: "OTHER" }] },
      files: [{ part: "evidence-file", filename: "a.pdf", type: "application/pdf", size: 4 }],
    });
    expect(stub.getDispute("D1")?.status).toBe("UNDER_REVIEW");

    const again = await fetch(`${stub.url}/v1/customer/disputes/D1/provide-evidence`, { method: "POST", headers: auth, body: form });
    expect(again.status).toBe(422);
  });

  it("can emit underscore rels", async () => {
    const s = await startStub({ underscoreRels: true });
    s.setDispute(makeDispute({ dispute_id: "D2" }));
    expect(s.getDispute("D2")?.links).toEqual(expect.arrayContaining([expect.objectContaining({ rel: "provide_evidence" })]));
    await s.close();
  });
});
