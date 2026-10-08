import { describe, expect, it } from "vitest";
import { formatDate } from "../src/index";

// Scenario-level tests (casefile + demo merchant data) live in
// packages/agent/test/scenarios.test.ts: casefile may import only core.
describe("casefile", () => {
  it("formatDate uses the verifier's unambiguous form", () => {
    expect(formatDate("2026-10-02T23:59:00Z")).toBe("Oct 2, 2026");
  });
});
