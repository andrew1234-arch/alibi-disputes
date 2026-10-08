import { describe, expect, it } from "vitest";
import { checkEvidenceFiles, createPaypalWriter, EvidenceFileError, FILE_PART, INPUT_PART } from "../src/write";
import { PaypalNetworkError } from "../src/errors";
import { env, json, mockFetch, token } from "./helpers";

const evidences = [
  {
    evidence_type: "PROOF_OF_FULFILLMENT",
    evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z999AA10123456784" }] },
    notes: "Delivered Oct 6, 2026.",
  },
];

describe("provideEvidence", () => {
  it("sends one multipart POST with the JSON input part and file parts", async () => {
    const fetch = mockFetch().mockResolvedValueOnce(token()).mockResolvedValueOnce(json(200, { links: [{ rel: "up", href: "x" }] }));
    const w = createPaypalWriter(env, { fetch });
    const pdf = new TextEncoder().encode("%PDF-1.4 demo");
    await w.provideEvidence("PP-D-1", { evidences }, [{ filename: "pod.pdf", bytes: pdf }]);

    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-evidence");
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect(JSON.parse(await (form.get(INPUT_PART) as Blob).text())).toEqual({ evidences });
    const file = form.get(FILE_PART) as File;
    expect(file.name).toBe("pod.pdf");
    expect(file.type).toBe("application/pdf");
    // Content-Type is left to fetch so the multipart boundary is set correctly.
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("never retries a failed write", async () => {
    const fetch = mockFetch().mockResolvedValueOnce(token()).mockResolvedValueOnce(json(503, {}));
    const w = createPaypalWriter(env, { fetch, sleep: async () => {} });
    await expect(w.provideEvidence("PP-D-1", { evidences })).rejects.toThrow(/503/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a write with no response is not retried and is flagged as ambiguous", async () => {
    const fetch = mockFetch().mockResolvedValueOnce(token()).mockRejectedValueOnce(new TypeError("other side closed"));
    const w = createPaypalWriter(env, { fetch, sleep: async () => {} });
    await expect(w.provideEvidence("PP-D-1", { evidences })).rejects.toBeInstanceOf(PaypalNetworkError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects payloads PayPal would reject, before any network call", async () => {
    const fetch = mockFetch();
    const w = createPaypalWriter(env, { fetch });
    await expect(w.provideEvidence("x", { evidences: [{ evidence_type: "OTHER", notes: "x".repeat(2001) }] })).rejects.toThrow();
    await expect(w.provideEvidence("x", { evidences: [] })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("checkEvidenceFiles (PayPal: jpg/jpeg/gif/png/pdf, <10 MB each, ≤50 MB total)", () => {
  const f = (filename: string, size: number) => ({ filename, bytes: new Uint8Array(size) });
  it("accepts allowed types", () => {
    expect(checkEvidenceFiles([f("a.PDF", 10), f("b.jpeg", 10), f("c.png", 10)])).toEqual(["application/pdf", "image/jpeg", "image/png"]);
  });
  it("rejects other types, oversize files and oversize totals", () => {
    expect(() => checkEvidenceFiles([f("a.docx", 10)])).toThrow(EvidenceFileError);
    expect(() => checkEvidenceFiles([f("noext", 10)])).toThrow(EvidenceFileError);
    expect(() => checkEvidenceFiles([f("a.pdf", 10 * 1024 * 1024)])).toThrow(/under 10 MB/);
    const nine = 9 * 1024 * 1024;
    expect(() => checkEvidenceFiles(Array.from({ length: 6 }, (_, i) => f(`${i}.pdf`, nine)))).toThrow(/50 MB/);
  });
});
