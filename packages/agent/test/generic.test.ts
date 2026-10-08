import { describe, expect, it } from "vitest";
import { DemoStore } from "@alibi/merchant";
import { assessGenericReply, buildCase, compareWithGenericReply, genericPrompt, type Llm } from "../src/index";
import { sentences } from "../src/generic";
import { disputeDetailSchemaForTests } from "./fixture";

const now = new Date("2026-10-20T00:00:00Z");
const reader = { getDispute: async () => ({ data: disputeDetailSchemaForTests, raw: { status: 200, debugId: undefined, body: {} } }) };
const merchant = new DemoStore([{ scenario: "inr-delivered", transactionId: "8XY12345AB678901C" }]);
const caseFile = () => buildCase("PP-D-1", { reader, merchant, now: () => now });

describe("generic AI reply comparison (SPEC §5.6)", () => {
  it("classifies each sentence against the case's evidence", async () => {
    const cf = await caseFile();
    const r = assessGenericReply(
      "The buyer paid 84.00 USD on Oct 2, 2026. We shipped it with FedEx, tracking number 7712345678901234. We value every customer and always ship promptly!",
      cf,
    );
    expect(r.sentences.map((s) => s.verdict)).toEqual(["supported", "invented", "vague"]);
    expect(r.sentences[1]!.reason).toMatch(/FedEx|7712345678901234/);
    expect(r.unanswered).toEqual(["PROOF_OF_FULFILLMENT"]);
  });

  it("the generic prompt has the reason and amount only, no records", async () => {
    const cf = await caseFile();
    const prompt = genericPrompt(cf);
    expect(prompt).toContain("MERCHANDISE_OR_SERVICE_NOT_RECEIVED");
    expect(prompt).toContain("84.00 USD");
    expect(prompt).not.toMatch(/1Z999AA10123456784|8XY12345AB678901C|#1042/);
  });

  it("compareWithGenericReply: one call, the answering model recorded", async () => {
    const cf = await caseFile();
    const calls: string[] = [];
    const llm: Llm = {
      model: "m",
      complete: async (req) => {
        calls.push(req.purpose);
        return { output: req.schema.parse({ reply: "We shipped it. Please close the case." }), model: "m-answer" };
      },
    };
    const c = await compareWithGenericReply(cf, llm, now);
    expect(calls).toEqual(["generic_reply"]);
    expect(c).toMatchObject({ model: "m-answer", reply: "We shipped it. Please close the case.", createdAt: now.toISOString() });
    expect(c.sentences.every((s) => s.verdict === "vague")).toBe(true);
  });

  it("splits sentences on terminal punctuation and line breaks", () => {
    expect(sentences("One. Two!\nThree? Four")).toEqual(["One.", "Two!", "Three?", "Four"]);
  });
});
