import { describe, expect, it } from "vitest";
import type { CaseFile } from "@alibi/core";
import { approvalHash } from "@alibi/core/server";
import { DemoStore } from "@alibi/merchant";
import { disputeDetailSchemaForTests } from "./fixture";
import { buildCase, carryOver, isNewEvidenceRound } from "../src/index";

const now = new Date("2026-10-20T00:00:00Z");
const reader = { getDispute: async () => ({ data: disputeDetailSchemaForTests, raw: { status: 200, debugId: undefined, body: {} } }) };
const merchant = new DemoStore([{ scenario: "inr-delivered", transactionId: "8XY12345AB678901C" }]);

describe("buildCase", () => {
  it("runs fetch → gather → case file → draft → verify, logging each step", async () => {
    const steps: string[] = [];
    const cf = await buildCase("PP-D-1", { reader, merchant, now: () => now, log: (s) => void steps.push(s) });
    expect(steps).toEqual(["fetch", "requested", "gather_paypal", "gather_merchant", "case_file", "verify"]);
    expect(cf.strategy.stance).toBe("fight");
    expect(cf.removedByVerifier).toEqual([]);
    const sources = new Set(Object.values(cf.evidence).map((r) => r.source));
    expect(sources).toEqual(new Set(["paypal", "merchant_demo"]));
  });

  it("unlinked transactions get no merchant records (no invented data)", async () => {
    const cf = await buildCase("PP-D-1", { reader, merchant: new DemoStore([]), now: () => now });
    expect(Object.values(cf.evidence).every((r) => r.source === "paypal")).toBe(true);
    expect(cf.strategy.stance).toBe("consider_conceding");
  });
});

describe("carryOver", () => {
  it("keeps approval only for an identical payload; keeps submission history within a round", async () => {
    // Under review after our submission: same round.
    const next = { ...(await buildCase("PP-D-1", { reader, merchant, now: () => now })), status: "UNDER_REVIEW" };
    const prev: CaseFile = {
      ...next,
      approval: { approvedAt: "2026-10-19T00:00:00Z", draftHash: approvalHash(next) },
      submission: { submittedAt: "2026-10-19T01:00:00Z", paypalStatusAfter: "UNDER_REVIEW" },
    };
    expect(carryOver(prev, next).approval).toEqual(prev.approval);
    const changed = { ...next, draft: { ...next.draft, notes: next.draft.notes + " x" } };
    expect(carryOver(prev, changed).approval).toBeUndefined();
    expect(carryOver(prev, changed).submission).toEqual(prev.submission);
    expect(carryOver(undefined, next)).toBe(next);
    // Same draft text, but PayPal now requests one more type: what would be sent changes.
    const moreRequested = { ...next, checklist: [...next.checklist, { evidenceType: "PROOF_OF_REFUND", satisfiedBy: [], routes: ["refund_ids" as const] }] };
    expect(carryOver(prev, moreRequested).approval).toBeUndefined();
  });

  it("a new evidence round (waiting again after we saw it leave) drops the old submission and approval", async () => {
    const next = await buildCase("PP-D-1", { reader, merchant, now: () => now });
    expect(next.status).toBe("WAITING_FOR_SELLER_RESPONSE");
    const submitted = (after: string): CaseFile => ({
      ...next,
      approval: { approvedAt: "2026-10-19T00:00:00Z", draftHash: approvalHash(next) },
      submission: { submittedAt: "2026-10-19T01:00:00Z", paypalStatusAfter: after },
    });
    expect(isNewEvidenceRound(submitted("UNDER_REVIEW"), next)).toBe(true);
    const merged = carryOver(submitted("UNDER_REVIEW"), next);
    expect(merged.submission).toBeUndefined();
    expect(merged.approval).toBeUndefined();
    // Status not yet seen to change, or unknown: can't tell rounds apart, keep blocking.
    expect(isNewEvidenceRound(submitted("WAITING_FOR_SELLER_RESPONSE"), next)).toBe(false);
    expect(isNewEvidenceRound(submitted("UNKNOWN"), next)).toBe(false);
    expect(carryOver(submitted("UNKNOWN"), next).submission).toBeDefined();
    // ...but once a later rebuild stored a status off WAITING, coming back is a new round.
    expect(isNewEvidenceRound({ ...submitted("UNKNOWN"), status: "UNDER_REVIEW" }, next)).toBe(true);
    expect(isNewEvidenceRound({ ...submitted("WAITING_FOR_SELLER_RESPONSE"), status: "UNDER_REVIEW" }, next)).toBe(true);
  });
});
