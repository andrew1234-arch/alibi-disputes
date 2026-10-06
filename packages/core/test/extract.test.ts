import { describe, expect, it } from "vitest";
import { canonicalDecimal, carrierCode, extractFacts } from "../src/extract.js";

const types = (s: string) => extractFacts(s).map((f) => f.type);
const one = (s: string) => {
  const f = extractFacts(s);
  expect(f).toHaveLength(1);
  return f[0]!;
};

describe("canonicalDecimal", () => {
  it.each([
    ["84.00", "84"],
    ["84,00", "84"],
    ["84.50", "84.5"],
    ["1,234.56", "1234.56"],
    ["1.234,56", "1234.56"],
    ["1,234", "1234"],
    ["1.234.567", "1234567"],
    ["0.125", "0.125"],
    ["007", "7"],
  ])("%s → %s", (input, out) => expect(canonicalDecimal(input)).toBe(out));
});

describe("amounts", () => {
  it.each([
    ["$84.00", "84", "$"],
    ["US$84", "84", "USD"],
    ["USD 84.00", "84", "USD"],
    ["84.00 USD", "84", "USD"],
    ["€1.234,56", "1234.56", "EUR"],
    ["1.234,56 €", "1234.56", "EUR"],
    ["£12", "12", "GBP"],
    ["₦25,000", "25000", "NGN"],
    ["CA$1,250.50", "1250.5", "CAD"],
  ])("%s", (text, value, currency) => {
    expect(one(`paid ${text} today`)).toMatchObject({ type: "amount", value, currency });
  });

  it("does not also report the amount's digits as a number", () => {
    expect(types("The buyer paid $84.00.")).toEqual(["amount"]);
  });
});

describe("dates", () => {
  it.each([
    ["Oct 2, 2026", { year: 2026, month: 10, day: 2 }],
    ["October 2nd 2026", { year: 2026, month: 10, day: 2 }],
    ["Oct. 2", { month: 10, day: 2 }],
    ["2 October 2026", { year: 2026, month: 10, day: 2 }],
    ["2nd of Oct", { month: 10, day: 2 }],
    ["2026-10-02", { year: 2026, month: 10, day: 2 }],
    ["2026-10-02T14:03:00Z", { year: 2026, month: 10, day: 2 }],
    ["OCT 06", { month: 10, day: 6 }],
    ["October 2026", { year: 2026, month: 10 }],
    ["10/25/2026", { year: 2026, month: 10, day: 25 }],
    ["25/10/2026", { year: 2026, month: 10, day: 25 }],
  ])("%s", (text, expected) => {
    const f = one(`on ${text} it happened`);
    expect(f.type).toBe("date");
    expect(f).toMatchObject(expected);
  });

  it("flags day/month-ambiguous numeric dates", () => {
    expect(one("on 02/10/2026").type).toBe("ambiguous_date");
  });

  it("does not read words that start with a month name as dates", () => {
    expect(types("Shipped to 3 Market Street with 2 Decorative pillows")).toEqual(["number", "number"]);
    expect(types("Mayfield 12, Junction 4, Octagon 7, Augusta 9")).toEqual(["number", "number", "number", "number"]);
    expect(types("Sold 2 Marches")).toEqual(["number"]);
  });

  it("does not read lower-case 'may' as a month", () => {
    expect(types("the buyer may 2 times have asked")).toEqual(["number"]);
  });
});

describe("times", () => {
  it.each([
    ["2:15pm", { hour: 14, minute: 15 }],
    ["2:15 p.m.", { hour: 14, minute: 15 }],
    ["12:05am", { hour: 0, minute: 5 }],
    ["12pm", { hour: 12 }],
    ["9 a.m.", { hour: 9 }],
    ["14:15", { hour: 14, minute: 15 }],
    ["2:15", { hour: 2, minute: 15, anyMeridiem: true }],
  ])("%s", (text, expected) => {
    const f = one(`delivered at ${text} that day`);
    expect(f.type).toBe("time");
    expect(f).toEqual(expect.objectContaining(expected));
    if (!("anyMeridiem" in expected)) expect(f).not.toHaveProperty("anyMeridiem");
  });

  it("is not fooled by amounts or words", () => {
    expect(types("2 amounts and 3 pmts")).toEqual(["number", "number"]);
  });
});

describe("identifiers", () => {
  it.each([
    ["order #1042", "1042"],
    ["tracking 1Z999AA10123456784", "1Z999AA10123456784"],
    ["dispute PP-D-12345", "PPD12345"],
    ["USPS 9400111899223817421234", "9400111899223817421234"],
    ["capture 8XY12345AB678901C", "8XY12345AB678901C"],
  ])("%s", (text, id) => {
    const f = extractFacts(text).find((x) => x.type === "identifier");
    expect(f).toMatchObject({ type: "identifier", id });
  });

  it("leaves short plain numbers and ordinals alone", () => {
    expect(types("3 items, 2nd attempt")).toEqual(["number"]);
  });
});

describe("carriers", () => {
  it("finds carriers case-appropriately", () => {
    expect(extractFacts("Shipped via FedEx and UPS").filter((f) => f.type === "carrier").map((f) => f.type === "carrier" && f.carrier)).toEqual([
      "FEDEX",
      "UPS",
    ]);
    expect(types("we set things ups")).toEqual([]);
  });

  it("maps names and enums to PayPal carrier codes", () => {
    expect(carrierCode("UPS")).toBe("UPS");
    expect(carrierCode("FedEx")).toBe("FEDEX");
    expect(carrierCode("ROYAL_MAIL")).toBe("ROYAL_MAIL");
    expect(carrierCode("Royal Mail")).toBe("ROYAL_MAIL");
    expect(carrierCode("Pony Express")).toBeUndefined();
  });
});

describe("quotes", () => {
  it("extracts quoted text whole, with curly quotes too", () => {
    const facts = extractFacts('The buyer wrote "arrived on Oct 6" and “thanks!”');
    expect(facts.map((f) => f.type)).toEqual(["quote", "quote"]);
    expect(facts[0]).toMatchObject({ text: "arrived on Oct 6" });
  });
});

it("worked example from the extractor header", () => {
  const facts = extractFacts(
    'Order #1042 for $84.00 shipped via UPS (1Z999AA10123456784) on Oct 2, 2026; buyer wrote "thanks, got it".',
  );
  expect(facts.map((f) => f.type)).toEqual(["identifier", "amount", "carrier", "identifier", "date", "quote"]);
});
