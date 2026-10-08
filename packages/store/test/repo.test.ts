import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CaseFile } from "@alibi/core";
import { createRepo, createSql, type Repo, type Sql } from "../src/index";

// PGlite (real Postgres in WASM) takes tens of seconds to boot on some
// machines, so one instance serves the file and tables are truncated per test.
let sql: Sql;
let repo: Repo;
beforeAll(async () => {
  sql = createSql("pglite://memory");
  repo = createRepo(sql);
  await repo.migrate();
  await repo.migrate(); // idempotent
}, 180_000);
beforeEach(async () => {
  await sql.exec("truncate cases, approvals, submissions, webhook_events, activity, demo_links, pending_rebuilds restart identity");
});
afterAll(() => sql.close());

const cf = (over: Partial<CaseFile> = {}): CaseFile => ({
  disputeId: "PP-D-1",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  stage: "CHARGEBACK",
  amount: { value: "84.00", currency: "USD" },
  requested: [],
  timeline: [],
  checklist: [],
  strategy: { stance: "fight", reasons: [] },
  draft: { claims: [], notes: "v1", documents: [] },
  evidence: {},
  removedByVerifier: [],
  createdAt: "2026-10-07T00:00:00Z",
  ...over,
});
const hashOf = (c: CaseFile) => `hash:${c.draft.notes}`;

describe("repo", () => {
  it("round-trips case files", async () => {
    await repo.saveCase(cf());
    await repo.saveCase(cf({ status: "UNDER_REVIEW" }));
    expect((await repo.getCase("PP-D-1"))?.status).toBe("UNDER_REVIEW");
    expect(await repo.getCase("nope")).toBeUndefined();
    expect(await repo.listCases()).toHaveLength(1);
  });

  it("only approves the draft that is current", async () => {
    await repo.saveCase(cf());
    expect(await repo.approve("PP-D-1", "hash:stale", hashOf, new Date("2026-10-08T00:00:00Z"))).toBe(false);
    expect((await repo.getCase("PP-D-1"))?.approval).toBeUndefined();
    expect(await repo.approve("PP-D-1", "hash:v1", hashOf, new Date("2026-10-08T00:00:00Z"))).toBe(true);
    expect((await repo.getCase("PP-D-1"))?.approval).toEqual({ approvedAt: "2026-10-08T00:00:00.000Z", draftHash: "hash:v1" });
    expect(await repo.approve("missing", "hash:v1", hashOf, new Date())).toBe(false);
  });

  it("refuses to claim the slot if the stored case no longer carries the approval", async () => {
    expect(await repo.beginSubmission("PP-D-9", "h", (cf) => cf?.approval?.draftHash === "h")).toBe("approval_changed");
    expect(await repo.listSubmissions("PP-D-9")).toEqual([]);
  });

  it("allows one live submission per dispute; a failed one frees the slot", async () => {
    const first = await repo.beginSubmission("PP-D-1", "h");
    expect(first).toBeTypeOf("number");
    expect(await repo.beginSubmission("PP-D-1", "h")).toBeUndefined();
    expect(await repo.beginSubmission("PP-D-1", "other")).toBeUndefined();
    await repo.finishSubmission(first as number, { state: "failed", error: "PayPal 500" });
    const second = await repo.beginSubmission("PP-D-1", "h");
    expect(second).toBeTypeOf("number");
    await repo.finishSubmission(second as number, { state: "succeeded", paypalStatusAfter: "UNDER_REVIEW", paypalDebugId: "dbg" });
    expect(await repo.beginSubmission("PP-D-1", "h")).toBeUndefined();
    const rows = await repo.listSubmissions("PP-D-1");
    expect(rows.map((r) => r.state)).toEqual(["failed", "succeeded"]);
    expect(rows[1]).toMatchObject({ paypalStatusAfter: "UNDER_REVIEW", paypalDebugId: "dbg", error: null });
  });

  it("concurrent submission attempts: exactly one wins", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => repo.beginSubmission("PP-D-2", "h")));
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
  });

  it("dedupes webhook events by id", async () => {
    expect(await repo.recordWebhookEvent("WH-1", "CUSTOMER.DISPUTE.CREATED", { a: 1 })).toBe(true);
    expect(await repo.recordWebhookEvent("WH-1", "CUSTOMER.DISPUTE.CREATED", { a: 1 })).toBe(false);
    expect(await repo.recordWebhookEvent("WH-2", "CUSTOMER.DISPUTE.UPDATED", {})).toBe(true);
  });

  it("logs activity newest first, per dispute or overall", async () => {
    await repo.logActivity("PP-D-1", "fetch", { call: "GET /v1/customer/disputes/PP-D-1" });
    await repo.logActivity("PP-D-1", "verify");
    await repo.logActivity(null, "poll");
    expect((await repo.listActivity("PP-D-1")).map((a) => a.step)).toEqual(["verify", "fetch"]);
    expect((await repo.listActivity()).map((a) => a.step)).toEqual(["poll", "verify", "fetch"]);
    expect((await repo.listActivity("PP-D-1"))[1]?.detail).toEqual({ call: "GET /v1/customer/disputes/PP-D-1" });
  });

  it("demo links and reset", async () => {
    await repo.setDemoLink("inr-delivered", "TX1");
    await repo.setDemoLink("inr-delivered", "TX2");
    expect(await repo.listDemoLinks()).toEqual([{ scenario: "inr-delivered", transactionId: "TX2" }]);
    await repo.saveCase(cf());
    await repo.beginSubmission("PP-D-1", "h");
    await repo.resetDisputes(["PP-D-1"]);
    expect(await repo.getCase("PP-D-1")).toBeUndefined();
    expect(await repo.beginSubmission("PP-D-1", "h")).toBeTypeOf("number");
  });

  it("rebuild queue: due jobs, backoff on failure, and a re-queue during work isn't lost", async () => {
    await repo.queueRebuild("PP-D-Q");
    const [job] = await repo.dueRebuilds();
    expect(job).toMatchObject({ disputeId: "PP-D-Q", attempts: 0 });
    await repo.rebuildFailed("PP-D-Q", job!.version, "PayPal 503", 60_000);
    expect(await repo.dueRebuilds()).toEqual([]); // backing off
    await repo.queueRebuild("PP-D-Q"); // a new webhook resets the backoff
    const [again] = await repo.dueRebuilds();
    expect(again!.version).toBeGreaterThan(job!.version);
    await repo.rebuildDone("PP-D-Q", job!.version); // stale finish: newer request survives
    expect(await repo.dueRebuilds()).toHaveLength(1);
    await repo.rebuildFailed("PP-D-Q", job!.version, "late failure of the old attempt", 60_000);
    expect(await repo.dueRebuilds()).toHaveLength(1); // the newer queueing keeps its schedule
    await repo.rebuildDone("PP-D-Q", again!.version);
    expect(await repo.dueRebuilds()).toEqual([]);
  });

  it("re-linking a transaction to another scenario moves it instead of failing", async () => {
    await repo.setDemoLink("inr-delivered", "TX-1");
    await repo.setDemoLink("snad-color", "TX-1");
    expect(await repo.listDemoLinks()).toEqual([{ scenario: "snad-color", transactionId: "TX-1" }]);
  });
});
