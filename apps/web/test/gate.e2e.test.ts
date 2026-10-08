import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvalHash } from "@alibi/core/server";
import { PaypalError, PaypalNetworkError, PaypalNotSentError } from "@alibi/paypal/read";
import { makeDispute } from "@alibi/test-stub";
import type { AppContext } from "@/lib/server/context";
import { rebuildCase } from "@/lib/server/cases";
import { drainRebuilds } from "@/lib/server/rebuild-queue";
import { makeApproveRoute, makeBuildRoute, makeCaseRoute, makeCompareRoute, makeDemoDocumentRoute, makeReconcileRoute, makeSubmitRoute } from "@/lib/server/routes";
import { buildCase, operatorHeaders, params, resetHarness, startHarness, strongDraft, writes, type Harness } from "./harness";

// SPEC §8.4: the approval gate, end to end, through the real route handlers,
// real PayPal adapters (test mode) and a real Postgres schema (PGlite).

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());
beforeEach(() => resetHarness(h));

const D = "PP-D-GATE-1";
const approve = (ctx: AppContext = h.ctx) => (hash: string) =>
  makeApproveRoute(async () => ctx)(new Request("http://x", { method: "POST", headers: operatorHeaders, body: JSON.stringify({ draftHash: hash }) }), params({ id: D }));
const submit = (ctx: AppContext = h.ctx) => () => makeSubmitRoute(async () => ctx)(new Request("http://x", { method: "POST", headers: operatorHeaders }), params({ id: D }));

async function approvedCase() {
  h.stub.setDispute(makeDispute({ dispute_id: D }));
  const cf = await buildCase(h, D, strongDraft);
  expect(cf.removedByVerifier).toEqual([]); // the fixture draft is fully supported
  expect((await approve()(approvalHash(cf))).status).toBe(200);
  return cf;
}

describe("approval gate", () => {
  it("no approval → 403 and no PayPal write", async () => {
    h.stub.setDispute(makeDispute({ dispute_id: D }));
    await buildCase(h, D, strongDraft);
    const res = await submit()();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "NOT_APPROVED" });
    expect(writes(h.stub)).toHaveLength(0);
  });

  it("approval → exactly one provide-evidence with the expected shape", async () => {
    await approvedCase();
    const res = await submit()();
    const body = await res.json();
    expect(body, JSON.stringify(body)).toMatchObject({ ok: true, paypalStatusAfter: "UNDER_REVIEW", sent: { evidenceTypes: ["PROOF_OF_FULFILLMENT"] } });

    const w = writes(h.stub);
    expect(w).toHaveLength(1);
    expect(w[0]!.input).toEqual({
      evidences: [
        {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z999AA10123456784" }] },
          notes: "The buyer paid $84.00 on Oct 2, 2026.\n\nUPS recorded the parcel as delivered to the front door on Oct 5, 2026.",
        },
      ],
    });
    expect(w[0]!.files).toEqual([
      expect.objectContaining({ part: "evidence-file", filename: "proof-of-delivery-1042.pdf", type: "application/pdf" }),
    ]);
    const stored = await h.repo.getCase(D);
    expect(stored?.submission?.paypalStatusAfter).toBe("UNDER_REVIEW");
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["succeeded"]);
  });

  it("a second submit (double click, second tab) is refused; still one write", async () => {
    await approvedCase();
    const [a, b] = await Promise.all([submit()(), submit()()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(writes(h.stub)).toHaveLength(1);
    expect((await submit()()).status).toBe(409);
    expect(writes(h.stub)).toHaveLength(1);
  });

  it("status changed between approval and submit → abort, no write", async () => {
    await approvedCase();
    h.stub.setDispute(makeDispute({ dispute_id: D, status: "UNDER_REVIEW" }));
    const res = await submit()();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "STATUS_CHANGED" });
    expect(writes(h.stub)).toHaveLength(0);
  });

  it("PayPal's requested evidence changed → abort, no write", async () => {
    await approvedCase();
    h.stub.setDispute(
      makeDispute({ dispute_id: D, evidences: [{ evidence_type: "PROOF_OF_REFUND", source: "REQUESTED_FROM_SELLER" }] }),
    );
    const res = await submit()();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "REQUEST_CHANGED" });
    expect(writes(h.stub)).toHaveLength(0);
  });

  it("an edit after approval invalidates it → 403, no write", async () => {
    const cf = await approvedCase();
    const approved = (await h.repo.getCase(D))!;
    await h.repo.saveCase({ ...approved, draft: { ...cf.draft, notes: cf.draft.notes + " Edited." } });
    expect((await submit()()).status).toBe(403);
    expect(writes(h.stub)).toHaveLength(0);
  });

  it("a stored draft that no longer passes the verifier is refused, even with a matching approval", async () => {
    const cf = await approvedCase();
    const approved = (await h.repo.getCase(D))!;
    // Tamper below the API: invent a tracking number and re-sign the approval.
    const tampered = { ...cf.draft, claims: [{ text: "Tracking 1Z000000000000000.", evidenceIds: [cf.draft.claims[0]!.evidenceIds[0]!] }] };
    await h.repo.saveCase({ ...approved, draft: tampered, approval: { approvedAt: "x", draftHash: approvalHash({ ...approved, draft: tampered }) } });
    const res = await submit()();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "DRAFT_FAILS_VERIFICATION" });
    expect(writes(h.stub)).toHaveLength(0);
  });

  it("DEMO_READONLY → 409 with a clear message, and no PayPal call at all", async () => {
    await approvedCase();
    const before = h.stub.calls.length;
    const res = await submit(h.readonlyCtx)();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "READ_ONLY_DEMO",
      message: "Submitting is turned off on the public demo. The demo video shows a real, approved sandbox submission.",
    });
    expect(h.stub.calls.length).toBe(before);
  });

  it("a PayPal error response is reported, logged, and frees the slot for a manual retry", async () => {
    await approvedCase();
    const rejecting = {
      ...h.ctx,
      writer: { provideEvidence: async () => Promise.reject(new PaypalError("rejected", 422, "dbg-1", "UNPROCESSABLE_ENTITY", undefined)) },
    };
    const res = await submit(rejecting)();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "PAYPAL_REJECTED" });
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["failed"]);
    expect((await submit()()).status).toBe(200);
  });

  it("a failure before anything is sent (e.g. token fetch) frees the slot and says nothing reached PayPal", async () => {
    await approvedCase();
    const failing = {
      ...h.ctx,
      writer: { provideEvidence: async () => Promise.reject(new PaypalNotSentError("POST provide-evidence", new Error("token fetch failed"))) },
    };
    const res = await submit(failing)();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "SEND_FAILED" });
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["failed"]);
  });

  it("PayPal accepted but recording it failed → 500, slot stays claimed, a retry can't send twice", async () => {
    await approvedCase();
    const brokenRepo = { ...h.repo, recordSubmissionSuccess: async () => Promise.reject(new Error("connection terminated")) };
    const res = await submit({ ...h.ctx, repo: brokenRepo })();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "SUBMITTED_NOT_RECORDED" });
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["pending"]);
    expect((await h.repo.getCase(D))?.submission).toBeUndefined(); // row and case agree: both unrecorded
    expect((await submit()()).status).toBe(409);
    expect(writes(h.stub)).toHaveLength(1);
  });

  it("a PayPal 5xx is ambiguous: re-checked, never treated as a refusal", async () => {
    await approvedCase();
    const gateway504 = (deliver: boolean) => ({
      ...h.ctx,
      writer: {
        provideEvidence: async (...args: Parameters<typeof h.ctx.writer.provideEvidence>) => {
          if (deliver) await h.ctx.writer.provideEvidence(...args);
          throw new PaypalError("gateway timeout", 504, "dbg-504", undefined, undefined);
        },
      },
    });
    // Not processed: status still WAITING → unknown, slot kept.
    const unknown = await submit(gateway504(false))();
    expect(await unknown.json()).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["pending"]);
    expect((await submit()()).status).toBe(409);
  });

  it("an unexpected error after the send started is ambiguous too (allowlist, not denylist)", async () => {
    await approvedCase();
    const weird = { ...h.ctx, writer: { provideEvidence: async () => Promise.reject(new TypeError("aborted")) } };
    expect(await (await submit(weird)()).json()).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["pending"]);
  });

  it("a re-check showing RESOLVED is not proof the evidence landed (buyer may have cancelled)", async () => {
    await approvedCase();
    const cancelled = {
      ...h.ctx,
      writer: {
        provideEvidence: async () => {
          h.stub.setDispute(makeDispute({ dispute_id: D, status: "RESOLVED" }));
          throw new PaypalNetworkError("POST provide-evidence", new Error("reset"));
        },
      },
    };
    expect(await (await submit(cancelled)()).json()).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect((await h.repo.getCase(D))?.submission).toBeUndefined();
  });

  it("a payload or file PayPal would refuse is caught locally (422) before claiming the slot", async () => {
    await approvedCase();
    const badFile = {
      ...h.ctx,
      merchant: async () =>
        Object.assign(await h.ctx.merchant(), { document: async () => ({ filename: "receipt.txt", bytes: new Uint8Array([1]) }) }),
    };
    const res = await submit(badFile)();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "PAYLOAD_INVALID" });
    expect(await h.repo.listSubmissions(D)).toEqual([]);
    expect(writes(h.stub)).toHaveLength(0);
  });
});

describe("approval gate: write with no response (ambiguous)", () => {
  it("PayPal actually received it → recorded as submitted; a retry can't send it twice", async () => {
    await approvedCase();
    // Deliver to PayPal, then lose the response.
    const lossy = {
      ...h.ctx,
      writer: {
        provideEvidence: async (...args: Parameters<typeof h.ctx.writer.provideEvidence>) => {
          await h.ctx.writer.provideEvidence(...args);
          throw new PaypalNetworkError("POST provide-evidence", new Error("other side closed"));
        },
      },
    };
    const res = await submit(lossy)();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, paypalStatusAfter: "UNDER_REVIEW" });
    expect((await submit()()).status).toBe(409);
    expect(writes(h.stub)).toHaveLength(1);
  });

  it("PayPal unreachable to confirm → OUTCOME_UNKNOWN and the slot stays claimed", async () => {
    await approvedCase();
    const dark = {
      ...h.ctx,
      writer: { provideEvidence: async () => Promise.reject(new PaypalNetworkError("POST provide-evidence", new Error("timeout"))) },
    };
    let reads = 0;
    const flakyReader = {
      ...h.ctx.reader,
      getDispute: async (id: string) => {
        if (reads++ > 0) throw new PaypalNetworkError("GET dispute", new Error("down"));
        return h.ctx.reader.getDispute(id);
      },
    };
    const res = await submit({ ...dark, reader: flakyReader })();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["pending"]);
    expect((await submit()()).status).toBe(409);
  });
});

describe("approval gate: write with no response, status not yet changed", () => {
  it("re-check still shows WAITING_FOR_SELLER_RESPONSE → OUTCOME_UNKNOWN, slot kept (it may have landed)", async () => {
    await approvedCase();
    const lossy = {
      ...h.ctx,
      writer: { provideEvidence: async () => Promise.reject(new PaypalNetworkError("POST provide-evidence", new Error("reset"))) },
    };
    const res = await submit(lossy)();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["pending"]);
    expect((await submit()()).status).toBe(409);
  });
});

describe("operator auth", () => {
  it("approve, submit and build need the operator token when submissions are on", async () => {
    const cf = await approvedCase();
    const post = (headers: Record<string, string>) => new Request("http://x", { method: "POST", headers, body: JSON.stringify({ draftHash: approvalHash(cf) }) });
    for (const headers of [{}, { authorization: "Bearer wrong-token" }] as Record<string, string>[]) {
      expect((await makeApproveRoute(async () => h.ctx)(post(headers), params({ id: D }))).status).toBe(401);
      expect((await makeSubmitRoute(async () => h.ctx)(post(headers), params({ id: D }))).status).toBe(401);
      expect((await makeBuildRoute(async () => h.ctx)(post(headers), params({ id: D }))).status).toBe(401);
    }
    expect(writes(h.stub)).toHaveLength(0);
  });

  it("case reads and documents need it too in a writable deployment, but not on the read-only demo", async () => {
    await approvedCase();
    const get = (headers: Record<string, string> = {}) => new Request("http://x", { headers });
    expect((await makeCaseRoute(async () => h.ctx)(get(), params({ id: D }))).status).toBe(401);
    expect((await makeCaseRoute(async () => h.ctx)(get(operatorHeaders), params({ id: D }))).status).toBe(200);
    expect((await makeDemoDocumentRoute(async () => h.ctx)(get(), params({ scenario: "inr-delivered", file: "x.pdf" }))).status).toBe(401);
    expect((await makeCaseRoute(async () => h.readonlyCtx)(get(), params({ id: D }))).status).toBe(200);
  });
});

describe("evidence rounds and concurrent rebuilds", () => {
  it("a rebuild while the dispute is under review keeps the submission", async () => {
    await approvedCase();
    expect((await submit()()).status).toBe(200);
    const rebuilt = await rebuildCase(h.ctx, D);
    expect(rebuilt.submission?.paypalStatusAfter).toBe("UNDER_REVIEW");
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["succeeded"]);
  });

  it("PayPal asks for evidence again → new round: old submission superseded, slot free, approval needed again", async () => {
    await approvedCase();
    expect((await submit()()).status).toBe(200);
    h.stub.setDispute(makeDispute({ dispute_id: D })); // back to WAITING_FOR_SELLER_RESPONSE
    const rebuilt = await rebuildCase(h.ctx, D);
    expect(rebuilt.submission).toBeUndefined();
    expect(rebuilt.approval).toBeUndefined();
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["superseded"]);
    expect(await h.repo.beginSubmission(D, "next-round")).toBeTypeOf("number");
  });
});

describe("rebuild queue", () => {
  it("a failed rebuild stays queued with backoff; the job is removed once a rebuild succeeds", async () => {
    h.stub.setDispute(makeDispute({ dispute_id: D }));
    await h.repo.setDemoLink("inr-delivered", "TX-UNUSED");
    await h.repo.queueRebuild(D);
    const down = { ...h.ctx, reader: { ...h.ctx.reader, getDispute: async () => Promise.reject(new Error("PayPal 503")) } };
    await drainRebuilds(down);
    expect(await h.repo.getCase(D)).toBeUndefined();
    const [row] = (await h.sql.query<{ attempts: number; last_error: string }>(`select attempts, last_error from pending_rebuilds`)).rows;
    expect(row).toMatchObject({ attempts: 1, last_error: "PayPal 503" });

    await h.sql.query(`update pending_rebuilds set next_attempt_at = now()`); // skip the wait
    await drainRebuilds(h.ctx);
    expect((await h.repo.getCase(D))?.disputeId).toBe(D);
    expect((await h.sql.query(`select 1 from pending_rebuilds`)).rows).toEqual([]);
  });

  it("a permanent error (PayPal 404) is abandoned instead of retried forever", async () => {
    await h.repo.queueRebuild(D);
    const gone = { ...h.ctx, reader: { ...h.ctx.reader, getDispute: async () => Promise.reject(new PaypalError("not found", 404, "dbg", "RESOURCE_NOT_FOUND", undefined)) } };
    await drainRebuilds(gone);
    expect((await h.sql.query(`select 1 from pending_rebuilds`)).rows).toEqual([]);
    expect((await h.repo.listActivity(D)).map((a) => a.step)).toContain("build_abandoned");
  });
});

describe("unconfirmed submissions get resolved", () => {
  // Deliver to PayPal but report a 504, while PayPal still shows WAITING: OUTCOME_UNKNOWN, row pending.
  async function unconfirmed() {
    await approvedCase();
    const status = h.stub.getDispute(D)!.status;
    const lagging = {
      ...h.ctx,
      writer: {
        provideEvidence: async (...args: Parameters<typeof h.ctx.writer.provideEvidence>) => {
          await h.ctx.writer.provideEvidence(...args);
          h.stub.setDispute({ ...h.stub.getDispute(D)!, status }); // status change not visible yet
          throw new PaypalError("gateway timeout", 504, "dbg-504", undefined, undefined);
        },
      },
    };
    expect(await (await submit(lagging)()).json()).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["pending"]);
  }
  const age = () => h.sql.query(`update submissions set started_at = now() - interval '10 minutes'`);
  const reconcile = (outcome: string) =>
    makeReconcileRoute(async () => h.ctx)(
      new Request("http://x", { method: "POST", headers: operatorHeaders, body: JSON.stringify({ outcome }) }),
      params({ id: D }),
    );

  it("a later rebuild that sees UNDER_REVIEW records it as submitted", async () => {
    await unconfirmed();
    h.stub.setDispute(makeDispute({ dispute_id: D, status: "UNDER_REVIEW" }));
    await age();
    const rebuilt = await rebuildCase(h.ctx, D);
    expect(rebuilt.submission?.paypalStatusAfter).toBe("UNDER_REVIEW");
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["succeeded"]);
    // ...so a later evidence request is detected as a new round.
    h.stub.setDispute(makeDispute({ dispute_id: D }));
    await rebuildCase(h.ctx, D);
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["superseded"]);
  });

  it("a fresh pending row (maybe still in flight) is left alone by rebuilds", async () => {
    await unconfirmed();
    h.stub.setDispute(makeDispute({ dispute_id: D, status: "UNDER_REVIEW" }));
    await rebuildCase(h.ctx, D);
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["pending"]);
  });

  it("operator: not-received frees the slot; received records it", async () => {
    await unconfirmed();
    expect((await reconcile("not_received")).status).toBe(200);
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["failed"]);
    expect((await reconcile("not_received")).status).toBe(409); // nothing pending any more

    await resetHarness(h);
    await unconfirmed();
    expect((await reconcile("received")).status).toBe(200);
    expect((await h.repo.listSubmissions(D)).map((s) => s.state)).toEqual(["succeeded"]);
    expect((await h.repo.getCase(D))?.submission).toBeDefined();
    expect((await submit()()).status).toBe(409);
  });
});

describe("approval gate: approval lapses during the checks", () => {
  it("a rebuild that changes the case between the checks and the claim → 409 APPROVAL_CHANGED, no write", async () => {
    const cf = await approvedCase();
    // While the gate re-fetches the dispute, a merchant edit lands and drops the approval.
    const racingReader = {
      ...h.ctx.reader,
      getDispute: async (id: string) => {
        const r = await h.ctx.reader.getDispute(id);
        await h.repo.updateCase(D, (prev) => ({ ...prev!, draft: { ...cf.draft, notes: cf.draft.notes + " Edited." } }));
        return r;
      },
    };
    const res = await submit({ ...h.ctx, reader: racingReader })();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "APPROVAL_CHANGED" });
    expect(writes(h.stub)).toHaveLength(0);
    expect(await h.repo.listSubmissions(D)).toEqual([]);
  });
});

describe("generic AI comparison route", () => {
  it("409 without an LLM; with one: generated once, then served from cache; open on the read-only demo", async () => {
    await approvedCase();
    const get = (ctx: AppContext) => makeCompareRoute(async () => ctx)(new Request("http://x", { headers: operatorHeaders }), params({ id: D }));
    expect((await get(h.ctx)).status).toBe(409);

    let calls = 0;
    const llm = {
      model: "m",
      complete: async (req: { schema: { parse: (v: unknown) => unknown } }) => {
        calls++;
        return { output: req.schema.parse({ reply: "We shipped via FedEx, tracking 7712345678901234." }), model: "m" };
      },
    } as unknown as NonNullable<AppContext["llm"]>;
    const withLlm = { ...h.ctx, llm };
    const first = await get(withLlm);
    expect(first.status).toBe(200);
    expect((await first.json()).sentences[0].verdict).toBe("invented");
    expect((await get(withLlm)).status).toBe(200);
    const anon = await makeCompareRoute(async () => ({ ...withLlm, env: { ...withLlm.env, DEMO_READONLY: true } }))(new Request("http://x"), params({ id: D }));
    expect(anon.status).toBe(200);
    expect(calls).toBe(1);
  });
});

describe("approve route", () => {
  it("refuses a stale hash and malformed bodies", async () => {
    h.stub.setDispute(makeDispute({ dispute_id: D }));
    await buildCase(h, D, strongDraft);
    expect((await approve()("0".repeat(64))).status).toBe(409);
    const bad = await makeApproveRoute(async () => h.ctx)(new Request("http://x", { method: "POST", headers: operatorHeaders, body: "{}" }), params({ id: D }));
    expect(bad.status).toBe(400);
  });

  it("is disabled in read-only mode", async () => {
    h.stub.setDispute(makeDispute({ dispute_id: D }));
    const cf = await buildCase(h, D, strongDraft);
    expect((await approve(h.readonlyCtx)(approvalHash(cf))).status).toBe(409);
  });
});

describe("HATEOAS rel spelling", () => {
  it("accepts provide_evidence (underscore) links", async () => {
    h.stub.setUnderscoreRels(true);
    await approvedCase();
    expect(h.stub.getDispute(D)?.links).toEqual(expect.arrayContaining([expect.objectContaining({ rel: "provide_evidence" })]));
    // The stub only *advertises* underscores; action paths keep hyphens, as PayPal's do.
    expect((await submit()()).status).toBe(200);
  });
});
