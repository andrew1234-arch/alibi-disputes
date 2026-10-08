import { createHash, timingSafeEqual } from "node:crypto";
import { compareWithGenericReply, genericPrompt, LlmError, type GenericComparison } from "@alibi/agent";
import { canonicalJson, sha256Hex } from "@alibi/core/server";
import { z } from "zod";
import { approveDraft } from "./approve";
import { caseView, rebuildCase } from "./cases";
import type { AppContext } from "./context";
import { submitApprovedDraft } from "./submit";
import { handlePaypalWebhook, MAX_WEBHOOK_BYTES } from "./webhook";

// Route handler factories, so tests can run the exact handlers Next serves
// against a test context (PayPal stub + PGlite).

type Params<P> = { params: Promise<P> };
type GetContext = () => Promise<AppContext>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Plain-language 500: never a stack trace (SPEC §7). Details go to the server log only. */
async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    console.error("[alibi] route error", e);
    return json(500, { code: "INTERNAL", message: "Something went wrong on our side. Nothing was sent to PayPal." });
  }
}

/**
 * In a writable deployment (DEMO_READONLY=false) everything except the PayPal
 * webhook is the merchant's: approve, submit and rebuild act for them, and
 * case reads and documents carry buyer data. All require
 * `Authorization: Bearer <ALIBI_OPERATOR_TOKEN>`; env validation refuses to
 * start without the token in that mode. The public read-only demo needs no
 * token: writes refuse on their own, and its data is the demo disputes.
 * Both sides are hashed first so the compare is constant-time and length-safe.
 */
function operatorDenied(req: Request, env: AppContext["env"]): Response | undefined {
  if (env.DEMO_READONLY) return undefined;
  const expected = env.ALIBI_OPERATOR_TOKEN;
  const given = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  const digest = (s: string) => createHash("sha256").update(s).digest();
  if (expected && given && timingSafeEqual(digest(given), digest(expected))) return undefined;
  return json(401, { code: "UNAUTHORIZED", message: "Only the merchant can do this. Sign in as the operator and try again." });
}

/**
 * Reads a request body as text, giving up (undefined) once it passes `max`
 * bytes, so an oversized POST to a public endpoint is never fully buffered.
 * A Content-Length over the limit is refused before reading anything.
 */
async function readCapped(req: Request, max: number): Promise<string | undefined> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (declared > max) return undefined;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function makeWebhookRoute(getContext: GetContext) {
  return (req: Request) =>
    guarded(async () => {
      const body = await readCapped(req, MAX_WEBHOOK_BYTES);
      if (body === undefined) return json(413, { error: "event too large" });
      const ctx = await getContext();
      const r = await handlePaypalWebhook(body, req.headers, ctx);
      return json(r.httpStatus, r.body);
    });
}

const approveBody = z.object({ draftHash: z.string().regex(/^[0-9a-f]{64}$/) });

export function makeApproveRoute(getContext: GetContext) {
  return (req: Request, { params }: Params<{ id: string }>) =>
    guarded(async () => {
      const ctx = await getContext();
      const denied = operatorDenied(req, ctx.env);
      if (denied) return denied;
      const { id } = await params;
      const parsed = approveBody.safeParse(await req.json().catch(() => undefined));
      if (!parsed.success) return json(400, { code: "BAD_REQUEST", message: "Expected { draftHash }." });
      const r = await approveDraft(id, parsed.data.draftHash, { readonly: ctx.env.DEMO_READONLY, repo: ctx.repo, now: ctx.now });
      return r.ok ? json(200, { approved: true }) : json(r.httpStatus, { code: r.code, message: r.message });
    });
}

export function makeSubmitRoute(getContext: GetContext) {
  return (req: Request, { params }: Params<{ id: string }>) =>
    guarded(async () => {
      const ctx = await getContext();
      const denied = operatorDenied(req, ctx.env);
      if (denied) return denied;
      const { id } = await params;
      const merchant = await ctx.merchant();
      const r = await submitApprovedDraft(id, {
        readonly: ctx.env.DEMO_READONLY,
        repo: ctx.repo,
        reader: ctx.reader,
        writer: ctx.writer,
        loadDocument: (url) => merchant.document(url),
        timeZone: ctx.env.ALIBI_MERCHANT_TIME_ZONE,
      });
      return r.ok ? json(200, r) : json(r.httpStatus, { code: r.code, message: r.message });
    });
}

export function makeDemoDocumentRoute(getContext: GetContext) {
  return (req: Request, { params }: Params<{ scenario: string; file: string }>) =>
    guarded(async () => {
      const ctx = await getContext();
      const denied = operatorDenied(req, ctx.env);
      if (denied) return denied;
      const { scenario, file } = await params;
      const doc = await (await ctx.merchant()).document(`/api/demo-documents/${scenario}/${file}`);
      if (!doc) return json(404, { code: "NOT_FOUND", message: "No such demo document." });
      return new Response(new Uint8Array(doc.bytes), {
        headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${doc.filename}"` },
      });
    });
}

export function makeCaseRoute(getContext: GetContext) {
  return (req: Request, { params }: Params<{ id: string }>) =>
    guarded(async () => {
      const ctx = await getContext();
      const denied = operatorDenied(req, ctx.env);
      if (denied) return denied;
      const { id } = await params;
      const cf = await ctx.repo.getCase(id);
      if (!cf) return json(404, { code: "CASE_NOT_FOUND", message: "No case file for this dispute yet." });
      return json(200, { ...caseView(cf), activity: await ctx.repo.listActivity(id, 50) });
    });
}

/** Rebuild from PayPal + merchant data. Disabled in read-only mode (it writes state and calls PayPal). */
export function makeBuildRoute(getContext: GetContext) {
  return (req: Request, { params }: Params<{ id: string }>) =>
    guarded(async () => {
      const ctx = await getContext();
      const denied = operatorDenied(req, ctx.env);
      if (denied) return denied;
      const { id } = await params;
      if (ctx.env.DEMO_READONLY) return json(409, { code: "READ_ONLY_DEMO", message: "Rebuilding cases is turned off on the public demo." });
      return json(200, caseView(await rebuildCase(ctx, id)));
    });
}

const reconcileBody = z.object({ outcome: z.enum(["received", "not_received"]) });

/**
 * Operator-only: resolve a submission left pending (OUTCOME_UNKNOWN or
 * SUBMITTED_NOT_RECORDED) after checking the dispute in PayPal. The current
 * PayPal status is fetched and stored with the decision for the audit trail.
 */
export function makeReconcileRoute(getContext: GetContext) {
  return (req: Request, { params }: Params<{ id: string }>) =>
    guarded(async () => {
      const ctx = await getContext();
      const denied = operatorDenied(req, ctx.env);
      if (denied) return denied;
      if (ctx.env.DEMO_READONLY) return json(409, { code: "READ_ONLY_DEMO", message: "Reconciling is turned off on the public demo." });
      const { id } = await params;
      const parsed = reconcileBody.safeParse(await req.json().catch(() => undefined));
      if (!parsed.success) return json(400, { code: "BAD_REQUEST", message: 'Expected { outcome: "received" | "not_received" }.' });
      const status = (await ctx.reader.getDispute(id)).data.status;
      const done = await ctx.repo.resolvePendingSubmission(id, parsed.data.outcome, status);
      if (!done) return json(409, { code: "NOTHING_PENDING", message: "There's no unconfirmed submission for this dispute." });
      await ctx.repo.logActivity(id, "submission_reconciled", { by: "operator", outcome: parsed.data.outcome, paypalStatus: status });
      return json(200, { reconciled: parsed.data.outcome, paypalStatus: status });
    });
}

/**
 * GET: the "Generic AI (no case file)" comparison for a case (SPEC §5.6).
 * Cached per case + input (reason, amount, model, evidence), so it costs at
 * most one LLM call per case version. Open on the read-only demo like other
 * reads; operator-only in a writable deployment.
 */
export function makeCompareRoute(getContext: GetContext) {
  return (req: Request, { params }: Params<{ id: string }>) =>
    guarded(async () => {
      const ctx = await getContext();
      const denied = operatorDenied(req, ctx.env);
      if (denied) return denied;
      const { id } = await params;
      const cf = await ctx.repo.getCase(id);
      if (!cf) return json(404, { code: "CASE_NOT_FOUND", message: "No case file for this dispute yet." });
      if (!ctx.llm) return json(409, { code: "LLM_NOT_CONFIGURED", message: "The comparison needs the Claude model (ANTHROPIC_API_KEY + ALIBI_MODEL)." });
      const key = sha256Hex(canonicalJson({ prompt: genericPrompt(cf), model: ctx.llm.model, evidence: Object.keys(cf.evidence).sort() }));
      const cached = await ctx.repo.getComparison<GenericComparison>(id, key);
      if (cached) return json(200, cached);
      try {
        const fresh = await compareWithGenericReply(cf, ctx.llm, ctx.now(), ctx.env.ALIBI_MERCHANT_TIME_ZONE);
        return json(200, await ctx.repo.saveComparison(id, key, fresh));
      } catch (e) {
        if (!(e instanceof LlmError)) throw e;
        return json(502, { code: "LLM_FAILED", message: `The generic reply couldn't be generated (${e.kind}). Try again later.` });
      }
    });
}

/** Render health check: 200 once the app context (env, database, migrations) is up. No secrets, no PayPal call. */
export function makeHealthRoute(getContext: GetContext) {
  return () =>
    guarded(async () => {
      const ctx = await getContext();
      await ctx.repo.listDemoLinks();
      return json(200, { ok: true, readonly: ctx.env.DEMO_READONLY, llm: Boolean(ctx.llm) });
    });
}
