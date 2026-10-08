import { describe, expect, it } from "vitest";
import { buildChecklist } from "../src/checklist";
import { buildEvidencePayload } from "../src/payload";
import { delivered, evidenceMap, refund, tx } from "./fixtures";

const records = Object.values(evidenceMap);
const fromSeller = (evidenceType: string) => ({ evidenceType, source: "REQUESTED_FROM_SELLER" });

describe("buildEvidencePayload", () => {
  it("worked example: INR fulfilment with tracking and notes", () => {
    const checklist = buildChecklist("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", [fromSeller("PROOF_OF_FULFILLMENT")], records);
    const p = buildEvidencePayload(
      { claims: [], notes: "The buyer paid $84.00 on Oct 2, 2026.", evidenceInfo: { trackingInfo: [{ carrier: "UPS", number: "1Z999AA10123456784" }] }, documents: [delivered.id] },
      checklist,
      evidenceMap,
    );
    expect(p).toEqual({
      evidences: [
        {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z999AA10123456784" }] },
          notes: "The buyer paid $84.00 on Oct 2, 2026.",
        },
      ],
      documentIds: [delivered.id],
      unanswered: [],
    });
  });

  it("UNAUTHORISED fulfilment without tracking is unanswered, never sent as notes", () => {
    const checklist = buildChecklist("UNAUTHORISED", [fromSeller("PROOF_OF_FULFILLMENT")], records);
    const p = buildEvidencePayload({ claims: [{ evidenceIds: [tx.id] }], notes: "We shipped it.", documents: [] }, checklist, evidenceMap);
    expect(p.evidences).toEqual([]);
    expect(p.unanswered).toEqual(["PROOF_OF_FULFILLMENT"]);
    expect(p.documentIds).toEqual([]);
  });

  it("refund ids go in evidence_info.refund_ids as strings; notes go on the first evidence only", () => {
    const checklist = buildChecklist(
      "CREDIT_NOT_PROCESSED",
      [fromSeller("PROOF_OF_REFUND"), fromSeller("OTHER")],
      [refund, tx],
    );
    const p = buildEvidencePayload({ claims: [{ evidenceIds: [refund.id] }], notes: "Refunded.", evidenceInfo: { refundIds: [refund.ref] }, documents: [] }, checklist, evidenceMap);
    expect(p.evidences).toEqual([
      { evidence_type: "PROOF_OF_REFUND", evidence_info: { refund_ids: [refund.ref] }, notes: "Refunded." },
      { evidence_type: "OTHER" },
    ]);
  });

  it("carriers PayPal doesn't list are sent as OTHER + carrier_name_other", () => {
    const checklist = buildChecklist("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", [fromSeller("PROOF_OF_FULFILLMENT")], records);
    const p = buildEvidencePayload(
      { claims: [], notes: "", evidenceInfo: { trackingInfo: [{ carrier: "OTHER", carrierOther: "Evri", number: "1Z999AA10123456784" }] }, documents: [] },
      checklist,
      evidenceMap,
    );
    expect(p.evidences[0]?.evidence_info?.tracking_info).toEqual([
      { carrier_name: "OTHER", carrier_name_other: "Evri", tracking_number: "1Z999AA10123456784" },
    ]);
    expect(p.evidences[0]).not.toHaveProperty("notes");
  });

  it("ignores tracking numbers that don't belong to a satisfying record", () => {
    const checklist = buildChecklist("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", [fromSeller("PROOF_OF_FULFILLMENT")], records);
    const p = buildEvidencePayload({ claims: [], notes: "", evidenceInfo: { trackingInfo: [{ carrier: "UPS", number: "1ZNOTOURS000000000" }] }, documents: [] }, checklist, evidenceMap);
    expect(p.unanswered).toEqual(["PROOF_OF_FULFILLMENT"]);
  });

  it("notes answer a type only when a claim cites one of its own records (matches the verifier)", () => {
    // PayPal asks for fulfilment and refund; there's no refund record. Notes
    // citing the shipment must not send PROOF_OF_REFUND.
    const checklist = buildChecklist(
      "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      [fromSeller("PROOF_OF_FULFILLMENT"), fromSeller("PROOF_OF_REFUND")],
      [delivered, tx],
    );
    const p = buildEvidencePayload({ claims: [{ evidenceIds: [delivered.id] }], notes: "Delivered Oct 5.", documents: [] }, checklist, evidenceMap);
    expect(p.evidences.map((e) => e.evidence_type)).toEqual(["PROOF_OF_FULFILLMENT"]);
    expect(p.unanswered).toEqual(["PROOF_OF_REFUND"]);
  });

  it("unrelated notes don't answer a type nobody cited", () => {
    const checklist = buildChecklist("CREDIT_NOT_PROCESSED", [fromSeller("OTHER")], [tx]);
    const p = buildEvidencePayload({ claims: [], notes: "Some statement.", documents: [] }, checklist, evidenceMap);
    expect(p.evidences).toEqual([]);
    expect(p.unanswered).toEqual(["OTHER"]);
  });
});
