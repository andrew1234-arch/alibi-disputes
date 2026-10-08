import { buildCase as agentBuildCase } from "@alibi/agent";
import type { CaseFile, PaypalEnv } from "@alibi/core";
import type { DraftInput } from "@alibi/core/server";
import { DemoStore } from "@alibi/merchant";
import { createPaypalReader } from "@alibi/paypal/read";
import { createWebhookVerifier } from "@alibi/paypal/webhooks";
import { createPaypalWriter } from "@alibi/paypal/write";
import { createRepo, createSql, type Repo, type Sql } from "@alibi/store";
import { startStub, type Stub, type StubOptions } from "@alibi/test-stub";
import type { AppContext } from "@/lib/server/context";

export const OPERATOR_TOKEN = "test-operator-token-0123456789abcdef";
/** Headers an authorised merchant request carries. */
export const operatorHeaders = { authorization: `Bearer ${OPERATOR_TOKEN}` };

// Test context: real adapters in PAYPAL_TEST_MODE against the local stub,
// real Postgres SQL via PGlite, and the real agent loop (template drafter or a
// test-chosen draft; the LLM arrives in M3).

export const TX = "8XY12345AB678901C";
export const NOW = new Date("2026-10-20T00:00:00Z");
export const WEBHOOK_ID = "STUBWEBHOOK";

export interface Harness {
  stub: Stub;
  sql: Sql;
  repo: Repo;
  ctx: AppContext & { enqueued: string[] };
  readonlyCtx: AppContext;
  close(): Promise<void>;
}

export async function startHarness(stubOpts: StubOptions = {}): Promise<Harness> {
  const stub = await startStub({ webhookId: WEBHOOK_ID, ...stubOpts });
  const sql = createSql("pglite://memory");
  const repo = createRepo(sql);
  await repo.migrate();
  const env: PaypalEnv & { PAYPAL_WEBHOOK_ID: string } = {
    PAYPAL_CLIENT_ID: "id",
    PAYPAL_CLIENT_SECRET: "secret",
    PAYPAL_API_BASE: stub.url,
    PAYPAL_TEST_MODE: true,
    PAYPAL_WEBHOOK_ID: WEBHOOK_ID,
  };
  const enqueued: string[] = [];
  const ctx: AppContext & { enqueued: string[] } = {
    env: { DEMO_READONLY: false, ALIBI_MERCHANT_TIME_ZONE: undefined, ALIBI_OPERATOR_TOKEN: OPERATOR_TOKEN, ALIBI_MAX_LLM_CALLS_PER_CASE: 8 },
    repo,
    reader: createPaypalReader(env),
    writer: createPaypalWriter(env),
    verifier: createWebhookVerifier(env),
    merchant: async () => new DemoStore(await repo.listDemoLinks()),
    onQueued: (id) => void enqueued.push(id),
    now: () => NOW,
    enqueued,
  };
  return {
    stub,
    sql,
    repo,
    ctx,
    readonlyCtx: { ...ctx, env: { ...ctx.env, DEMO_READONLY: true } },
    close: async () => {
      await stub.close();
      await sql.close();
    },
  };
}

export async function resetHarness(h: Harness) {
  h.stub.reset();
  h.ctx.enqueued.length = 0;
  await h.sql.exec("truncate cases, approvals, submissions, webhook_events, activity, demo_links, pending_rebuilds, app_state, comparisons restart identity");
}

/** Builds and stores a case through the real agent loop, with a chosen draft. */
export async function buildCase(h: Harness, disputeId: string, draft: (ids: CaseIds) => DraftInput): Promise<CaseFile> {
  await h.repo.setDemoLink("inr-delivered", TX);
  const cf = await agentBuildCase(disputeId, {
    reader: h.ctx.reader,
    merchant: await h.ctx.merchant(),
    now: () => NOW,
    draft: ({ records }) =>
      draft({
        tx: records.find((r) => r.kind === "transaction" && r.source === "paypal")!.id,
        delivered: records.find((r) => r.kind === "carrier_event" && /Delivered/.test(String(r.value)))!.id,
        shipment: records.find((r) => r.kind === "fulfilment")!.id,
      }),
  });
  await h.repo.saveCase(cf);
  return cf;
}

export interface CaseIds {
  tx: string;
  delivered: string;
  shipment: string;
}

/** The demo's strong INR response: two claims, UPS tracking, proof-of-delivery PDF. */
export const strongDraft = (ids: CaseIds): DraftInput => ({
  claims: [
    { text: "The buyer paid $84.00 on Oct 2, 2026.", evidenceIds: [ids.tx] },
    { text: "UPS recorded the parcel as delivered to the front door on Oct 5, 2026.", evidenceIds: [ids.delivered] },
  ],
  evidenceInfo: { trackingInfo: [{ carrier: "UPS", number: "1Z999AA10123456784" }] },
  documents: [ids.delivered],
});

export const writes = (stub: Stub) => stub.calls.filter((c) => c.method === "POST" && /\/provide-evidence$/.test(c.path));
export const params = <P>(p: P) => ({ params: Promise.resolve(p) });
