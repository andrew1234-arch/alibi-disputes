import { describe, expect, it } from "vitest";
import { deadlineState, hoursLeft } from "../src/deadlines.js";

describe("deadlines", () => {
  it("worked example: offset due date vs UTC now", () => {
    const h = hoursLeft("2026-10-20T23:59:59-07:00", new Date("2026-10-20T08:00:00Z"))!;
    expect(h).toBeCloseTo(22 + 59 / 60 + 59 / 3600, 6);
    expect(deadlineState("2026-10-20T23:59:59-07:00", new Date("2026-10-20T08:00:00Z"), 72).kind).toBe("urgent");
  });

  it("the same instant written in different zones gives the same answer", () => {
    const now = new Date("2026-10-15T00:00:00Z");
    expect(hoursLeft("2026-10-20T00:00:00Z", now)).toBe(hoursLeft("2026-10-20T01:00:00+01:00", now));
    expect(hoursLeft("2026-10-20T00:00:00Z", now)).toBe(120);
  });

  it("classifies ok / urgent / overdue around the warning window", () => {
    const now = new Date("2026-10-10T00:00:00Z");
    expect(deadlineState("2026-10-13T00:00:01Z", now, 72).kind).toBe("ok");
    expect(deadlineState("2026-10-12T23:59:59Z", now, 72).kind).toBe("urgent");
    expect(deadlineState("2026-10-10T00:00:00Z", now, 72).kind).toBe("overdue");
    expect(deadlineState("2026-10-09T00:00:00Z", now, 72)).toEqual({ kind: "overdue", hoursLeft: -24 });
  });

  it("refuses zone-less or missing due dates instead of guessing", () => {
    const now = new Date("2026-10-10T00:00:00Z");
    expect(deadlineState(undefined, now, 72).kind).toBe("unknown");
    expect(deadlineState("2026-10-20T23:59:59", now, 72).kind).toBe("unknown");
    expect(deadlineState("next tuesday", now, 72).kind).toBe("unknown");
    expect(deadlineState("2026-10-20T23:59:59.000Z", now, 72).kind).toBe("ok");
  });
});
