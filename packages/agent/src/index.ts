import { baselineStance, SELLER_RESPONSE_STATUS, SELLER_SOURCE, type CaseFile } from "@alibi/core";
import { approvalHash, type DraftInput, type VerifyOptions } from "@alibi/core/server";
import { finishCaseFile, prepareCase, templateDraft, type CaseParts } from "@alibi/casefile";
import { runDrafter } from "./drafter";
import { budgeted, CallBudget, LlmError, type Llm } from "./llm";
import { runStrategist } from "./strategist";

export { createAnthropicLlm, type AnthropicLlmOptions } from "./anthropic";
export { CallBudget, LlmError, type Llm, type LlmRequest } from "./llm";
export { capStance } from "./strategist";
import type { MerchantStore } from "@alibi/merchant";
import { disputeToEvidence, requestedEvidence, type PaypalReader } from "@alibi/paypal/read";

// Agent loop (SPEC §3). May import @alibi/paypal/read only, never write.
//
//   1. fetch     GET /v1/customer/disputes/{id}: details + requested evidence
//   2. gather    PayPal facts → EvidenceRecords; merchant records for the disputed transaction
//   3. case file timeline, checklist, baseline stance (casefile + core, pure)
//   4. strategy  LLM strategist: stance + cited reasons; never more aggressive than the baseline
//   5. draft     LLM drafter → checker → one repair round if the checker removed anything
//   6. verify    every claim and reason checked against its cited evidence (core, pure)
//
// Without an LLM (not configured, budget spent, refusal, API error, invalid
// JSON) steps 4–5 fall back to the baseline stance and the template drafter,
// which passes the verifier by construction. The case records which path ran.
//
// Each step is reported through `log` so the activity feed can show the agent
// working, including the exact PayPal call it made.

export interface AgentDeps {
  reader: Pick<PaypalReader, "getDispute">;
  merchant: MerchantStore;
  now: () => Date;
  timeZone?: string | undefined;
  log?: (step: string, detail?: Record<string, unknown>) => Promise<void> | void;
  /** Strategist + drafter model. Omitted → template drafter and baseline stance. */
  llm?: Llm | undefined;
  /** ALIBI_MAX_LLM_CALLS_PER_CASE (default 8). */
  maxLlmCalls?: number;
  /** Fixed sync drafter (tests). Takes precedence over `llm`. */
  draft?: (parts: CaseParts) => DraftInput;
}

type Log = (step: string, detail?: Record<string, unknown>) => Promise<void> | void;

/** Steps 4–5. Any LlmError falls back to the template drafter; other errors (bugs) propagate. */
async function draftWithLlm(parts: CaseParts, deps: AgentDeps, verify: VerifyOptions, log: Log) {
  if (!deps.llm) {
    await log("llm_skipped", { reason: "LLM not configured" });
    return { draft: templateDraft(parts), authoredBy: { drafter: "template" as const, llmCalls: 0, fallbackReason: "LLM not configured" } };
  }
  const budget = new CallBudget(deps.maxLlmCalls ?? 8);
  const llm = budgeted(deps.llm, budget);
  const describe = (e: LlmError) => `${e.kind}: ${e.message}`;

  let strategy: Awaited<ReturnType<typeof runStrategist>> | undefined;
  try {
    strategy = await runStrategist(parts, llm);
    await log("strategist", { model: llm.model, stance: strategy.stance, reasons: strategy.reasons.length, capped: strategy.capped });
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    await log("llm_fallback", { step: "strategist", error: describe(e) });
  }

  try {
    const r = await runDrafter(parts, llm, strategy ?? { stance: baselineStance(parts.checklist), reasons: [] }, verify);
    await log("drafter", { model: llm.model, claims: r.draft.claims.length, documents: r.draft.documents.length });
    if (r.repaired) await log("repair", { rejected: r.firstPassRemoved });
    return {
      draft: r.draft,
      ...(strategy ? { strategy: { stance: strategy.stance, reasons: strategy.reasons } } : {}),
      authoredBy: {
        drafter: "llm" as const,
        model: llm.model,
        llmCalls: budget.calls.length,
        ...(r.repaired ? { repaired: true } : {}),
        ...(strategy?.capped ? { stanceCapped: true } : {}),
      },
    };
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    await log("llm_fallback", { step: budget.calls.at(-1) ?? "drafter", error: describe(e) });
    return {
      draft: templateDraft(parts),
      ...(strategy ? { strategy: { stance: strategy.stance, reasons: strategy.reasons } } : {}),
      authoredBy: { drafter: "template" as const, llmCalls: budget.calls.length, fallbackReason: describe(e) },
    };
  }
}

export async function buildCase(disputeId: string, deps: AgentDeps): Promise<CaseFile> {
  const log = deps.log ?? (() => {});
  const now = deps.now();

  const { data: d } = await deps.reader.getDispute(disputeId);
  await log("fetch", { call: `GET /v1/customer/disputes/${disputeId}`, status: d.status, reason: d.reason });

  const requested = requestedEvidence(d);
  await log("requested", { fromSeller: requested.filter((r) => r.source === SELLER_SOURCE).map((r) => r.evidenceType) });

  const paypal = disputeToEvidence(d, now.toISOString());
  await log("gather_paypal", { records: paypal.length });

  const merchant = [];
  for (const t of d.disputed_transactions ?? []) {
    if (!t.seller_transaction_id || !t.create_time) continue;
    merchant.push(...(await deps.merchant.recordsForTransaction({ transactionId: t.seller_transaction_id, paidAt: t.create_time }, now)));
  }
  await log("gather_merchant", { records: merchant.length, source: "merchant_demo" });

  const verify: VerifyOptions = deps.timeZone ? { timeZone: deps.timeZone } : {};
  const parts = prepareCase(
    {
      disputeId,
      reason: d.reason,
      status: d.status,
      stage: d.dispute_life_cycle_stage ?? "—",
      amount: d.dispute_amount
        ? { value: d.dispute_amount.value, currency: d.dispute_amount.currency_code }
        : { value: "—", currency: "", missing: "PayPal didn't include the disputed amount" },
      ...(d.seller_response_due_date ? { dueAt: d.seller_response_due_date } : {}),
      requested,
    },
    [...paypal, ...merchant],
  );

  const authored = deps.draft
    ? { draft: deps.draft(parts), authoredBy: { drafter: "template" as const, llmCalls: 0, fallbackReason: "fixed drafter" } }
    : await draftWithLlm(parts, deps, verify, log);
  const cf = {
    ...finishCaseFile(parts, authored.draft, { now, verify, ...("strategy" in authored ? { strategy: authored.strategy } : {}) }),
    authoredBy: authored.authoredBy,
  };
  await log("case_file", {
    checklist: cf.checklist.map((c) => ({ type: c.evidenceType, satisfied: c.satisfiedBy.length, gap: c.gap })),
    stance: cf.strategy.stance,
  });
  await log("verify", { claimsKept: cf.draft.claims.length, removed: cf.removedByVerifier.length });
  return cf;
}

/**
 * A rebuild (e.g. after a CUSTOMER.DISPUTE.UPDATED webhook) replaces the case
 * file but must not lose what the merchant did:
 *   - submission history carries over, unless this is a new evidence round
 *     (see isNewEvidenceRound), which also drops the old round's approval;
 *   - approval carries over only if the rebuild would send exactly the same
 *     thing (approvalHash: draft + payload, which depends on the checklist and
 *     evidence). New requested types or changed evidence mean re-approval.
 */
export function carryOver(prev: CaseFile | undefined, next: CaseFile): CaseFile {
  if (!prev) return next;
  if (isNewEvidenceRound(prev, next)) return next;
  const keepApproval = prev.approval && prev.approval.draftHash === approvalHash(next);
  return {
    ...next,
    ...(keepApproval ? { approval: prev.approval } : {}),
    ...(prev.submission ? { submission: prev.submission } : {}),
  };
}

/**
 * True when PayPal asks for evidence again after an earlier submission went
 * through. We only call it a new round if we saw the dispute leave
 * WAITING_FOR_SELLER_RESPONSE after submitting; right after a send, PayPal
 * may still show the old status for a moment, and that must not reopen it.
 *
 * "Saw it leave" means either the status captured right after submitting,
 * or the status a later rebuild stored (prev.status), was something else.
 *
 * Worked examples:
 *   submitted → after UNDER_REVIEW; days later WAITING again → new round.
 *   submitted → after UNKNOWN (re-read failed); a rebuild stores UNDER_REVIEW;
 *     later WAITING again → new round.
 *   submitted → after WAITING (lag), nothing seen since; rebuild sees WAITING
 *     → not a new round (can't tell it apart from the same one).
 */
export function isNewEvidenceRound(prev: CaseFile | undefined, next: CaseFile): boolean {
  if (!prev?.submission || next.status !== SELLER_RESPONSE_STATUS) return false;
  const after = prev.submission.paypalStatusAfter;
  const leftAfterSubmit = after !== "UNKNOWN" && after !== SELLER_RESPONSE_STATUS;
  return leftAfterSubmit || prev.status !== SELLER_RESPONSE_STATUS;
}

