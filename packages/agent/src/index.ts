import { SELLER_RESPONSE_STATUS, SELLER_SOURCE, type CaseFile } from "@alibi/core";
import { approvalHash, type DraftInput, type VerifyOptions } from "@alibi/core/server";
import { assembleCaseFile, type CaseParts } from "@alibi/casefile";
import type { MerchantStore } from "@alibi/merchant";
import { disputeToEvidence, requestedEvidence, type PaypalReader } from "@alibi/paypal/read";

// Agent loop (SPEC §3). May import @alibi/paypal/read only, never write.
//
//   1. fetch     GET /v1/customer/disputes/{id}: details + requested evidence
//   2. gather    PayPal facts → EvidenceRecords; merchant records for the disputed transaction
//   3. case file timeline, checklist, baseline stance (casefile + core, pure)
//   4. draft     template drafter today; M3 adds the LLM strategist + drafter here
//   5. verify    every claim checked against its cited evidence (core, pure)
//
// Each step is reported through `log` so the activity feed can show the agent
// working, including the exact PayPal call it made.

export interface AgentDeps {
  reader: Pick<PaypalReader, "getDispute">;
  merchant: MerchantStore;
  now: () => Date;
  timeZone?: string | undefined;
  log?: (step: string, detail?: Record<string, unknown>) => Promise<void> | void;
  /** Override the drafter (tests; M3's LLM drafter). Defaults to the template drafter. */
  draft?: (parts: CaseParts) => DraftInput;
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
  const cf = assembleCaseFile(
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
    { now, verify, ...(deps.draft ? { draft: deps.draft } : {}) },
  );
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

