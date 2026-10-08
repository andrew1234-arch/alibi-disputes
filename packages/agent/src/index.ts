import { baselineStance, SELLER_RESPONSE_STATUS, SELLER_SOURCE, type CaseFile } from "@alibi/core";
import { approvalHash, sha256Hex, type DraftInput, type VerifyOptions } from "@alibi/core/server";
import { finishCaseFile, prepareCase, templateDraft, type CaseParts } from "@alibi/casefile";
import { runDrafter } from "./drafter";
import { budgeted, CallBudget, LlmError, type Llm } from "./llm";
import { caseInput, DRAFTER_SYSTEM, REPAIR_SYSTEM, STRATEGIST_SYSTEM } from "./prompts";
import { runStrategist } from "./strategist";

export { createAnthropicLlm, type AnthropicLlmOptions } from "./anthropic";
export { CallBudget, LlmError, type Llm, type LlmRequest } from "./llm";
export { capStance } from "./strategist";
export { assessGenericReply, compareWithGenericReply, genericPrompt, type GenericComparison } from "./generic";
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
  /**
   * The stored case, if any. When the LLM would be shown exactly the same input
   * as last time, its draft and strategy are reused instead of asking again:
   * LLM output varies run to run, so re-drafting on every webhook would replace
   * the text the merchant approved (and lapse the approval) for no reason.
   */
  previous?: CaseFile | undefined;
}

type Log = (step: string, detail?: Record<string, unknown>) => Promise<void> | void;

/** Steps 4–5. Any LlmError falls back to the template drafter; other errors (bugs) propagate. */
async function draftWithLlm(parts: CaseParts, deps: AgentDeps, verify: VerifyOptions, log: Log) {
  if (!deps.llm) {
    await log("llm_skipped", { reason: "LLM not configured" });
    return { draft: templateDraft(parts), authoredBy: { drafter: "template" as const, llmCalls: 0, fallbackReason: "LLM not configured" } };
  }
  // Everything that shapes the LLM's output: the case data, the model and the
  // prompts. Change any of them (new evidence, ALIBI_MODEL, a prompt fix) and
  // the case is re-drafted; otherwise the stored draft is reused.
  const inputHash = sha256Hex(JSON.stringify([caseInput(parts), deps.llm.model, STRATEGIST_SYSTEM, DRAFTER_SYSTEM, REPAIR_SYSTEM]));
  const prev = deps.previous;
  if (prev?.authoredBy?.drafter === "llm" && prev.authoredBy.inputHash === inputHash) {
    // Same input as the stored LLM draft: reuse it. finishCaseFile re-verifies it.
    await log("llm_reused", { inputHash, model: prev.authoredBy.model });
    return {
      draft: { claims: prev.draft.claims, ...(prev.draft.evidenceInfo ? { evidenceInfo: prev.draft.evidenceInfo } : {}), documents: prev.draft.documents },
      strategy: prev.strategy,
      // The stored draft is already clean, so re-verifying it removes nothing.
      // Carry the original removals forward: they're the evidence guard's record.
      carriedRemoved: prev.removedByVerifier,
      authoredBy: { ...prev.authoredBy, llmCalls: 0, reused: true },
    };
  }

  const budget = new CallBudget(deps.maxLlmCalls ?? 8);
  const llm = budgeted(deps.llm, budget);
  const describe = (e: LlmError) => `${e.kind}: ${e.message}`;
  const answeredBy: string[] = [];

  let strategy: Awaited<ReturnType<typeof runStrategist>> | undefined;
  try {
    strategy = await runStrategist(parts, llm);
    answeredBy.push(strategy.model);
    await log("strategist", { model: strategy.model, stance: strategy.stance, reasons: strategy.reasons.length, capped: strategy.capped });
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    await log("llm_fallback", { step: e.purpose ?? "strategist", error: describe(e) });
  }
  const strategyOut = strategy ? { strategy: { stance: strategy.stance, reasons: strategy.reasons } } : {};

  try {
    const r = await runDrafter(parts, llm, strategy ?? { stance: baselineStance(parts.checklist), reasons: [] }, verify);
    answeredBy.push(...r.models);
    await log("drafter", { model: r.models[0], claims: r.draft.claims.length, documents: r.draft.documents.length });
    if (r.repaired) await log("repair", { rejected: r.firstPassRemoved });
    if (r.repairFailed) await log("llm_fallback", { step: "drafter_repair", error: describe(r.repairFailed), kept: "first draft; the checker removes its rejected claims" });
    return {
      draft: r.draft,
      ...strategyOut,
      authoredBy: {
        drafter: "llm" as const,
        model: llm.model,
        answeredBy: [...new Set(answeredBy)],
        inputHash,
        llmCalls: budget.calls.length,
        ...(r.repaired ? { repaired: true } : {}),
        ...(strategy?.capped ? { stanceCapped: true } : {}),
      },
    };
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    await log("llm_fallback", { step: e.purpose ?? "drafter", error: describe(e) });
    return {
      draft: templateDraft(parts),
      ...strategyOut,
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
  const finished = finishCaseFile(parts, authored.draft, { now, verify, ...("strategy" in authored ? { strategy: authored.strategy } : {}) });
  const carried = ("carriedRemoved" in authored ? authored.carriedRemoved : undefined) ?? [];
  const cf = {
    ...finished,
    removedByVerifier: [...carried, ...finished.removedByVerifier],
    ...(d.update_time ? { paypalUpdateTime: d.update_time } : {}),
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

