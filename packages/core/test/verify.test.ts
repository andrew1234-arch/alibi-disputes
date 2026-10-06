import { describe, expect, it } from "vitest";
import { buildChecklist } from "../src/checklist.js";
import type { CaseFile } from "../src/types.js";
import { applyMerchantEdit, draftHash, isApprovalValid, verifyDraft, type DraftInput } from "../src/verify.js";
import { buyerMsg, delivered, evidenceMap, order, refund, shipment, tx } from "./fixtures.js";

const INR = "MERCHANDISE_OR_SERVICE_NOT_RECEIVED";
const requested = [{ evidenceType: "PROOF_OF_FULFILLMENT", source: "REQUESTED_FROM_SELLER" }];
const checklist = buildChecklist(INR, requested, Object.values(evidenceMap));

const draft = (claims: [string, string[]][], extra: Partial<DraftInput> = {}): DraftInput => ({
  claims: claims.map(([text, evidenceIds]) => ({ text, evidenceIds })),
  documents: [],
  ...extra,
});

describe("verifyDraft — claims", () => {
  it("keeps claims whose every fact is in the cited records", () => {
    const v = verifyDraft(
      draft([
        ["The buyer paid $84.00 on Oct 2, 2026 for order #1042.", [tx.id, order.id]],
        ["We shipped it via UPS with tracking 1Z999AA10123456784 on Oct 3.", [shipment.id]],
        ["UPS recorded it as delivered on Oct 6, 2026.", [delivered.id]],
        ['On Oct 7 the buyer wrote "the set arrived safely".', [buyerMsg.id]],
      ]),
      evidenceMap,
      checklist,
    );
    expect(v.removed).toEqual([]);
    expect(v.claims).toHaveLength(4);
  });

  it("drops a claim with an invented tracking number", () => {
    const v = verifyDraft(draft([["Shipped via UPS, tracking 1Z999AA10123456785.", [shipment.id]]]), evidenceMap, checklist);
    expect(v.claims).toEqual([]);
    expect(v.removed[0]?.reason).toBe('Identifier "1Z999AA10123456785" not found in the cited evidence');
  });

  it("drops a claim with a wrong amount", () => {
    const v = verifyDraft(draft([["The buyer paid $48.00.", [tx.id]]]), evidenceMap, checklist);
    expect(v.removed[0]?.reason).toBe('Amount "$48.00" does not match the cited evidence');
  });

  it("drops a claim whose currency contradicts the record", () => {
    const v = verifyDraft(draft([["The buyer paid €84.00.", [tx.id]]]), evidenceMap, checklist);
    expect(v.removed).toHaveLength(1);
    expect(verifyDraft(draft([["The buyer paid 84.00 USD.", [tx.id]]]), evidenceMap, checklist).removed).toEqual([]);
  });

  it("checks facts only against the claim's own citations", () => {
    // The tracking number is real, but this claim cites only the transaction.
    const v = verifyDraft(draft([["Paid $84.00 and shipped as 1Z999AA10123456784.", [tx.id]]]), evidenceMap, checklist);
    expect(v.removed[0]?.reason).toMatch(/Identifier "1Z999AA10123456784"/);
  });

  it("drops wrong dates, wrong carriers and invented quotes, listing every miss", () => {
    const v = verifyDraft(
      draft([
        ["Delivered on Oct 5, 2026.", [delivered.id]],
        ["Delivered by FedEx.", [delivered.id]],
        ['The buyer wrote "I never got it".', [buyerMsg.id]],
        ["Delivered by FedEx on Oct 5.", [delivered.id]],
      ]),
      evidenceMap,
      checklist,
    );
    expect(v.claims).toEqual([]);
    expect(v.removed.map((r) => r.reason)).toEqual([
      'Date "Oct 5, 2026" does not match any date in the cited evidence',
      'Carrier "FedEx" not named in the cited evidence',
      'Quote "I never got it" does not appear in the cited evidence',
      'Carrier "FedEx" not named in the cited evidence; Date "Oct 5" does not match any date in the cited evidence',
    ]);
  });

  it("drops claims citing nothing or unknown ids", () => {
    const v = verifyDraft(draft([["We always ship fast.", []], ["Paid.", ["ev_nope"]]]), evidenceMap, checklist);
    expect(v.removed.map((r) => r.reason)).toEqual(["Cites no evidence", "Cites unknown evidence id ev_nope"]);
  });

  it("drops ambiguous numeric dates rather than guessing", () => {
    const v = verifyDraft(draft([["Delivered 06/10/2026.", [delivered.id]]]), evidenceMap, checklist);
    expect(v.removed[0]?.reason).toMatch(/ambiguous/);
  });

  it("matches the merchant's local date when a time zone is given", () => {
    // Buyer message at 2026-10-07T01:15Z is still Oct 6 in Chicago (UTC−5).
    const claim = draft([["The buyer confirmed receipt on Oct 6.", [buyerMsg.id]]]);
    expect(verifyDraft(claim, evidenceMap, checklist).removed).toHaveLength(1);
    expect(verifyDraft(claim, evidenceMap, checklist, { timeZone: "America/Chicago" }).removed).toEqual([]);
  });

  it("drops derived numbers the records don't state (no arithmetic)", () => {
    const v = verifyDraft(draft([["It arrived 3 days after shipping.", [shipment.id, delivered.id]]]), evidenceMap, checklist);
    expect(v.removed[0]?.reason).toBe('Number "3" not found in the cited evidence');
  });
});

describe("verifyDraft — structured evidence", () => {
  it("keeps real tracking info, drops invented tracking and refund ids", () => {
    const v = verifyDraft(
      draft([], {
        evidenceInfo: {
          trackingInfo: [
            { carrier: "UPS", number: "1Z999AA10123456784" },
            { carrier: "UPS", number: "1Z000000000000000" },
            { carrier: "FedEx", number: "1Z999AA10123456784" },
          ],
          refundIds: [refund.ref, "FAKE-REFUND-1"],
        },
      }),
      evidenceMap,
      checklist,
    );
    expect(v.evidenceInfo).toEqual({
      trackingInfo: [{ carrier: "UPS", number: "1Z999AA10123456784" }],
      refundIds: [refund.ref],
    });
    expect(v.removed.map((r) => r.reason)).toEqual([
      'Tracking number "1Z000000000000000" not found in any shipment record',
      'Carrier "FedEx" not named in the shipment record for 1Z999AA10123456784',
      'Refund id "FAKE-REFUND-1" not found in any refund record',
    ]);
  });

  it("only attaches records that have a document", () => {
    const v = verifyDraft(draft([], { documents: [delivered.id, tx.id, "ev_nope"] }), evidenceMap, checklist);
    expect(v.documents).toEqual([delivered.id]);
    expect(v.removed).toHaveLength(2);
  });
});

describe("verifyDraft — coverage (every requested type addressed or a gap)", () => {
  it("addressed by a claim citing a satisfying record", () => {
    const v = verifyDraft(draft([["UPS recorded delivery on Oct 6, 2026.", [delivered.id]]]), evidenceMap, checklist);
    expect(v.coverage).toEqual([{ evidenceType: "PROOF_OF_FULFILLMENT", status: "addressed", citedBy: [0] }]);
  });

  it("addressed by tracking info alone", () => {
    const v = verifyDraft(
      draft([], { evidenceInfo: { trackingInfo: [{ carrier: "UPS", number: "1Z999AA10123456784" }] } }),
      evidenceMap,
      checklist,
    );
    expect(v.coverage[0]?.status).toBe("addressed");
  });

  it("becomes a gap when the only addressing claim was dropped", () => {
    const v = verifyDraft(draft([["Delivered on Oct 9, 2026.", [delivered.id]]]), evidenceMap, checklist);
    expect(v.coverage).toEqual([
      {
        evidenceType: "PROOF_OF_FULFILLMENT",
        status: "gap",
        gap: "Records on file support PROOF_OF_FULFILLMENT, but no verified claim or attachment uses them.",
      },
    ]);
  });

  it("carries the checklist gap through", () => {
    const noDelivery = buildChecklist(INR, requested, [tx, order]);
    const v = verifyDraft(draft([]), evidenceMap, noDelivery);
    expect(v.coverage).toEqual([
      { evidenceType: "PROOF_OF_FULFILLMENT", status: "gap", gap: "No tracking number or shipment record on file." },
    ]);
  });
});

describe("verifyDraft — notes length", () => {
  const a = "The buyer paid $84.00 on Oct 2, 2026.";
  const b = "UPS recorded it as delivered on Oct 6, 2026.";
  const c = 'The buyer wrote "the set arrived safely".';

  it("joins verified claims in priority order", () => {
    const v = verifyDraft(draft([[a, [tx.id]], [b, [delivered.id]]]), evidenceMap, checklist);
    expect(v.notes).toBe(`${a}\n\n${b}`);
  });

  it("drops whole lowest-priority claims to fit, never truncating mid-claim", () => {
    const max = a.length + 2 + b.length; // fits a + b exactly, not c
    const v = verifyDraft(draft([[a, [tx.id]], [b, [delivered.id]], [c, [buyerMsg.id]]]), evidenceMap, checklist, { notesMax: max });
    expect(v.notes).toBe(`${a}\n\n${b}`);
    expect(v.removed).toEqual([{ text: c, reason: `Notes over PayPal's ${max}-character limit; dropped lowest-priority claim` }]);
  });

  it("defaults to PayPal's 2000-character limit", () => {
    const long = Array.from({ length: 60 }, () => [a, [tx.id]] as [string, string[]]);
    const v = verifyDraft(draft(long), evidenceMap, checklist);
    expect(v.notes.length).toBeLessThanOrEqual(2000);
    expect(v.claims.length).toBe(Math.floor((2000 + 2) / (a.length + 2)));
  });
});

describe("approval binding", () => {
  const verified = verifyDraft(draft([["The buyer paid $84.00.", [tx.id]]]), evidenceMap, checklist);
  const cf: CaseFile = {
    disputeId: "PP-D-1",
    reason: INR,
    status: "WAITING_FOR_SELLER_RESPONSE",
    stage: "CHARGEBACK",
    amount: { value: "84.00", currency: "USD" },
    requested,
    timeline: [],
    checklist,
    strategy: { stance: "fight", reasons: [] },
    draft: { claims: verified.claims, notes: verified.notes, documents: verified.documents },
    evidence: evidenceMap,
    removedByVerifier: [],
    approval: { approvedAt: "2026-10-08T00:00:00Z", draftHash: verified.draftHash },
    createdAt: "2026-10-08T00:00:00Z",
  };

  it("approval is valid for the exact draft it was given for", () => {
    expect(draftHash(cf.draft)).toBe(verified.draftHash);
    expect(isApprovalValid(cf)).toBe(true);
  });

  it("any content change invalidates it", () => {
    expect(isApprovalValid({ ...cf, draft: { ...cf.draft, notes: cf.draft.notes + " " } })).toBe(false);
    expect(isApprovalValid({ ...cf, draft: { ...cf.draft, documents: [delivered.id] } })).toBe(false);
    expect(isApprovalValid({ ...cf, approval: undefined })).toBe(false);
  });

  it("a merchant edit re-verifies and drops the approval", () => {
    const { caseFile, verified: v2 } = applyMerchantEdit(
      cf,
      draft([
        ["The buyer paid $84.00.", [tx.id]],
        ["Delivered by FedEx.", [delivered.id]], // invented by the edit
      ]),
    );
    expect(caseFile.approval).toBeUndefined();
    expect(isApprovalValid(caseFile)).toBe(false);
    expect(caseFile.draft.claims).toHaveLength(1);
    expect(caseFile.removedByVerifier).toEqual(v2.removed);
    expect(v2.removed[0]?.reason).toMatch(/FedEx/);
  });
});
