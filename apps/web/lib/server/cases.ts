import { buildCase, carryOver, isNewEvidenceRound } from "@alibi/agent";
import { buildEvidencePayload, UNDER_REVIEW_STATUS, type CaseFile } from "@alibi/core";
import { approvalHash } from "@alibi/core/server";
import type { AppContext } from "./context";

// Case build and read, shared by the webhook queue and the API routes.

/** A pending submission younger than this may still be in flight; leave it to the gate. */
export const RECONCILE_AFTER_MS = 2 * 60_000;

export async function rebuildCase(ctx: AppContext, disputeId: string): Promise<CaseFile> {
  const cf = await buildCase(disputeId, {
    reader: ctx.reader,
    merchant: await ctx.merchant(),
    now: ctx.now,
    timeZone: ctx.env.ALIBI_MERCHANT_TIME_ZONE,
    log: (step, detail) => ctx.repo.logActivity(disputeId, step, detail ?? {}),
  });
  // buildCase did the network work. Reconciling a stuck send, detecting a new
  // evidence round, freeing the slot and merging the case all happen in one
  // transaction under the case lock (repo.applyRebuild).
  const r = await ctx.repo.applyRebuild(
    disputeId,
    cf.status,
    (prev) => ({ caseFile: carryOver(prev, cf), newRound: isNewEvidenceRound(prev, cf) }),
    { acceptedStatus: UNDER_REVIEW_STATUS, reconcileAfterMs: RECONCILE_AFTER_MS },
  );
  if (r.reconciled) await ctx.repo.logActivity(disputeId, "submission_reconciled", { by: "rebuild", status: cf.status }).catch(() => {});
  if (r.newRound) await ctx.repo.logActivity(disputeId, "new_evidence_round", {}).catch(() => {});
  return r.caseFile;
}

/** What the case page (and the CLI) shows: the case plus exactly what submit would send. */
export function caseView(cf: CaseFile) {
  const payload = buildEvidencePayload(cf.draft, cf.checklist, cf.evidence);
  const hash = approvalHash(cf); // same rule as isApprovalValid, computed once
  return {
    caseFile: cf,
    // The approval token: covers the draft and the exact payload below.
    draftHash: hash,
    approvalValid: cf.approval?.draftHash === hash,
    payload: {
      evidences: payload.evidences,
      files: payload.documentIds.map((id) => ({ id, label: cf.evidence[id]?.label, url: cf.evidence[id]?.documentUrl })),
      unanswered: payload.unanswered,
    },
  };
}
