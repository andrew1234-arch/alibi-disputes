import { describe, expect, it } from "vitest";
import { baselineStance, buildChecklist, isDeliveredEvent } from "../src/checklist.js";
import { evidenceRule } from "../src/reason-map.js";
import { delivered, inTransit, order, refund, shipment, tx } from "./fixtures.js";

const INR = "MERCHANDISE_OR_SERVICE_NOT_RECEIVED";
const fromSeller = (evidenceType: string) => ({ evidenceType, source: "REQUESTED_FROM_SELLER" });

describe("reason map", () => {
  it("follows PayPal's reasons-evidence page", () => {
    expect(evidenceRule(INR, "PROOF_OF_FULFILLMENT")?.routes).toEqual(["tracking_info", "notes_or_documents"]);
    expect(evidenceRule("UNAUTHORISED", "PROOF_OF_FULFILLMENT")?.routes).toEqual(["tracking_info"]);
    expect(evidenceRule("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", "OTHER")?.routes).toEqual(["notes_or_documents"]);
    expect(evidenceRule("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", "PROOF_OF_FULFILLMENT")).toBeUndefined();
    expect(evidenceRule("NOT_A_REASON", "OTHER")).toBeUndefined();
  });
});

describe("buildChecklist (SPEC §5.3 worked example)", () => {
  it("delivered → satisfied, no gap, stance fight", () => {
    const list = buildChecklist(INR, [fromSeller("PROOF_OF_FULFILLMENT")], [tx, order, shipment, inTransit, delivered]);
    expect(list).toEqual([{ evidenceType: "PROOF_OF_FULFILLMENT", satisfiedBy: [shipment.id, inTransit.id, delivered.id] }]);
    expect(baselineStance(list)).toBe("fight");
  });

  it("in transit only → satisfied with a specific gap, stance fight_with_gaps", () => {
    const list = buildChecklist(INR, [fromSeller("PROOF_OF_FULFILLMENT")], [tx, order, shipment, inTransit]);
    expect(list[0]?.satisfiedBy).toEqual([shipment.id, inTransit.id]);
    expect(list[0]?.gap).toBe('Tracking shows "In transit, Dallas TX"; no delivery confirmation.');
    expect(baselineStance(list)).toBe("fight_with_gaps");
  });

  it("shipment record but no carrier events → generic in-transit gap", () => {
    const list = buildChecklist(INR, [fromSeller("PROOF_OF_FULFILLMENT")], [shipment]);
    expect(list[0]?.gap).toBe("Tracking shows in transit; no delivery confirmation.");
  });

  it("nothing on file → gap, stance consider_conceding", () => {
    const list = buildChecklist(INR, [fromSeller("PROOF_OF_FULFILLMENT")], [tx, order]);
    expect(list[0]).toEqual({
      evidenceType: "PROOF_OF_FULFILLMENT",
      satisfiedBy: [],
      gap: "No tracking number or shipment record on file.",
    });
    expect(baselineStance(list)).toBe("consider_conceding");
  });

  it("ignores evidence requested from the buyer and duplicate requests", () => {
    const list = buildChecklist(
      INR,
      [fromSeller("PROOF_OF_REFUND"), fromSeller("PROOF_OF_REFUND"), { evidenceType: "OTHER", source: "REQUESTED_FROM_BUYER" }],
      [refund],
    );
    expect(list).toEqual([{ evidenceType: "PROOF_OF_REFUND", satisfiedBy: [refund.id] }]);
  });

  it("PayPal's request wins: unmapped types become a manual-review gap, never dropped", () => {
    const list = buildChecklist(INR, [fromSeller("PROOF_OF_DELIVERY_SIGNATURE")], [delivered]);
    expect(list[0]?.satisfiedBy).toEqual([]);
    expect(list[0]?.gap).toMatch(/no mapping for PROOF_OF_DELIVERY_SIGNATURE/);
  });

  it("nothing requested → consider_conceding (nothing to fight with)", () => {
    expect(baselineStance([])).toBe("consider_conceding");
  });
});

describe("isDeliveredEvent", () => {
  const ev = (value: string) => ({ ...delivered, value });
  it.each([
    ["Delivered, front door", true],
    ["DELIVERED", true],
    ["Not yet delivered", false],
    ["Package was not delivered; receiver absent", false],
    ["Undelivered, returned to sender", false],
    ["Out for delivery", false],
    ["Delivery attempted", false],
  ])("%s → %s", (value, expected) => expect(isDeliveredEvent(ev(value))).toBe(expected));
});
