import { describe, expect, it } from "vitest";
import { hasAction, normaliseAction } from "../src/actions.js";

describe("normaliseAction", () => {
  it("treats hyphens, underscores and case as equivalent", () => {
    expect(normaliseAction("provide-evidence")).toBe("provide-evidence");
    expect(normaliseAction("provide_evidence")).toBe("provide-evidence");
    expect(normaliseAction(" Provide_Evidence ")).toBe("provide-evidence");
  });
});

describe("hasAction", () => {
  it("finds an action regardless of spelling", () => {
    const links = [{ rel: "self" }, { rel: "provide_evidence" }];
    expect(hasAction(links, "provide-evidence")).toBe(true);
    expect(hasAction(links, "accept-claim")).toBe(false);
    expect(hasAction(undefined, "provide-evidence")).toBe(false);
  });
});
