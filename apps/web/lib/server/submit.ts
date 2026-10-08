import { buildEvidencePayload, hasAction, SELLER_RESPONSE_STATUS, SELLER_SOURCE, UNDER_REVIEW_STATUS, type CaseFile } from "@alibi/core";
import { draftHash, isApprovalValid, verifyDraft } from "@alibi/core/server";
import type { PaypalReader } from "@alibi/paypal/read";
import { PaypalError, PaypalNotSentError, PaypalResponseShapeError, requestedEvidence } from "@alibi/paypal/read";
import { checkProvideEvidence, type EvidenceFile, type PaypalWriter } from "@alibi/paypal/write";
import type { Repo } from "@alibi/store";

// The approval gate (CLAUDE §1.1). The only code path that writes dispute
// state to PayPal. In order, each step aborts with a plain-language reason:
//
//   1. DEMO_READONLY            → 409, no PayPal call at all
//   2. case exists              → 404
//   3. approval binds to the draft + exact payload     → 403
//   4. draft still passes the verifier, unchanged      → 422
//   5. re-fetch the dispute from PayPal:
//        status is WAITING_FOR_SELLER_RESPONSE         → 409
//        HATEOAS links still offer provide-evidence    → 409
//        requested evidence types unchanged            → 409
//   6. payload non-empty, documents loadable, within
//      PayPal's documented limits                     → 422
//   7. claim the submission slot (one live per dispute)→ 409
//   8. provide-evidence, exactly once, never retried. The slot is released
//      only if PayPal refused it (4xx) or nothing left this server.
//      Anything ambiguous → re-check PayPal; if unproven, keep the slot.
//      Accepted but not recorded locally → 500, slot kept.


export interface GateDeps {
  readonly: boolean;
  repo: Repo;
  reader: Pick<PaypalReader, "getDispute">;
  writer: Pick<PaypalWriter, "provideEvidence">;
  loadDocument: (documentUrl: string) => Promise<EvidenceFile | undefined>;
  timeZone?: string | undefined;
}

export type GateResult =
  | { ok: true; paypalStatusAfter: string; sent: { evidenceTypes: string[]; files: string[] } }
  | { ok: false; httpStatus: 403 | 404 | 409 | 422 | 500 | 502; code: string; message: string };

const fail = (httpStatus: Extract<GateResult, { ok: false }>["httpStatus"], code: string, message: string): GateResult => ({
  ok: false,
  httpStatus,
  code,
  message,
});

export async function submitApprovedDraft(disputeId: string, deps: GateDeps): Promise<GateResult> {
  const { repo } = deps;
  const log = (step: string, detail: Record<string, unknown> = {}) => repo.logActivity(disputeId, step, detail);

  if (deps.readonly) {
    return fail(409, "READ_ONLY_DEMO", "Submitting is turned off on the public demo. The demo video shows a real, approved sandbox submission.");
  }

  const cf = await repo.getCase(disputeId);
  if (!cf) return fail(404, "CASE_NOT_FOUND", "No case file for this dispute yet.");

  if (!isApprovalValid(cf)) {
    return fail(403, "NOT_APPROVED", "Approve the current draft first. Any edit after approval needs a fresh approval.");
  }

  // Defence in depth: the stored draft must pass the verifier exactly as approved.
  const reverified = verifyDraft(
    { claims: cf.draft.claims, ...(cf.draft.evidenceInfo ? { evidenceInfo: cf.draft.evidenceInfo } : {}), documents: cf.draft.documents },
    cf.evidence,
    cf.checklist,
    deps.timeZone ? { timeZone: deps.timeZone } : {},
  );
  if (reverified.removed.length > 0 || reverified.draftHash !== draftHash(cf.draft)) {
    await log("submit_blocked", { code: "DRAFT_FAILS_VERIFICATION", removed: reverified.removed });
    return fail(422, "DRAFT_FAILS_VERIFICATION", "The approved draft no longer passes the evidence check. Review the case again.");
  }

  // Re-fetch: PayPal's current state wins over anything we stored.
  let fresh;
  try {
    fresh = (await deps.reader.getDispute(disputeId)).data;
  } catch (e) {
    return fail(502, "PAYPAL_UNAVAILABLE", `Couldn't re-check the dispute with PayPal: ${describe(e)}. Nothing was sent.`);
  }
  await log("recheck", { call: `GET /v1/customer/disputes/${disputeId}`, status: fresh.status });

  if (fresh.status !== SELLER_RESPONSE_STATUS) {
    return blocked(deps, disputeId, 409, "STATUS_CHANGED", `PayPal now shows this dispute as ${fresh.status}, so it isn't waiting for your response. Nothing was sent.`);
  }
  if (!hasAction(fresh.links, "provide-evidence")) {
    return blocked(deps, disputeId, 409, "ACTION_NOT_OFFERED", "PayPal is no longer offering evidence submission on this dispute. Nothing was sent.");
  }
  const requestedNow = new Set(requestedEvidence(fresh).filter((r) => r.source === SELLER_SOURCE).map((r) => r.evidenceType));
  const requestedThen = new Set(cf.checklist.map((c) => c.evidenceType));
  if (!sameSet(requestedNow, requestedThen)) {
    return blocked(
      deps,
      disputeId,
      409,
      "REQUEST_CHANGED",
      `PayPal now requests ${[...requestedNow].join(", ") || "no evidence"}; the case file answered ${[...requestedThen].join(", ") || "nothing"}. Rebuild the case. Nothing was sent.`,
    );
  }

  const payload = buildEvidencePayload(cf.draft, cf.checklist, cf.evidence);
  if (payload.evidences.length === 0) return fail(422, "NOTHING_TO_SEND", "The draft doesn't answer any requested evidence type.");

  const files: EvidenceFile[] = [];
  for (const id of payload.documentIds) {
    const url = cf.evidence[id]?.documentUrl;
    const file = url ? await deps.loadDocument(url) : undefined;
    if (!file) return fail(422, "DOCUMENT_MISSING", `Couldn't load the document for "${cf.evidence[id]?.label ?? id}".`);
    files.push(file);
  }

  const notSendable = checkProvideEvidence({ evidences: payload.evidences }, files);
  if (notSendable) return fail(422, "PAYLOAD_INVALID", `This submission breaks PayPal's limits, so nothing was sent: ${notSendable}`);

  // Re-check the approval against the case as stored *now*, atomically with
  // the claim: a rebuild or edit during the checks above may have lapsed it.
  const approvedHash = cf.approval!.draftHash;
  const claim = await repo.beginSubmission(disputeId, approvedHash, (latest) => latest?.approval?.draftHash === approvedHash && isApprovalValid(latest));
  if (claim === "approval_changed") {
    return fail(409, "APPROVAL_CHANGED", "The case changed while we were checking it, so your approval no longer matches. Review it and approve again. Nothing was sent.");
  }
  if (claim === undefined) return fail(409, "ALREADY_SUBMITTED", "Evidence for this dispute is already submitted or being submitted.");
  const submissionId = claim;
  const sent = { evidenceTypes: payload.evidences.map((e) => e.evidence_type), files: files.map((f) => f.filename) };

  let debugId: string | undefined;
  try {
    const res = await deps.writer.provideEvidence(disputeId, { evidences: payload.evidences }, files);
    debugId = res.raw.debugId;
  } catch (e) {
    return sendFailed(e);
  }
  // PayPal accepted. From here on nothing may release the slot: a failure to
  // record it locally must never invite a second send.
  return recordAccepted(undefined);

  /** PayPal accepted (or a re-check proves it did). A bookkeeping error keeps the slot claimed. */
  async function recordAccepted(knownStatus: string | undefined): Promise<GateResult> {
    try {
      const after =
        knownStatus ??
        (await deps.reader
          .getDispute(disputeId)
          .then((r) => r.data.status)
          .catch(() => "UNKNOWN"));
      await repo.recordSubmissionSuccess(submissionId, disputeId, { paypalStatusAfter: after, ...(debugId ? { paypalDebugId: debugId } : {}) }, (latest) => ({
        ...(latest ?? cf!),
        ...(after === "UNKNOWN" ? {} : { status: after }),
        submission: { submittedAt: new Date().toISOString(), paypalStatusAfter: after, ...(debugId ? { requestId: debugId } : {}) },
      }));
      await log("provide_evidence", {
        call: `POST /v1/customer/disputes/${disputeId}/provide-evidence`,
        evidenceTypes: sent.evidenceTypes,
        files: sent.files,
        paypalDebugId: debugId,
        ...(knownStatus ? { confirmedBy: "recheck", status: knownStatus } : {}),
      }).catch(() => {}); // recorded above; the activity line is best-effort
      return { ok: true, paypalStatusAfter: after, sent };
    } catch (e) {
      // recordSubmissionSuccess is one transaction: on failure the row is still
      // 'pending', which blocks any resend until an operator reconciles it.
      return fail(
        500,
        "SUBMITTED_NOT_RECORDED",
        `PayPal accepted the evidence${debugId ? ` (PayPal-Debug-Id ${debugId})` : ""}, but Alibi couldn't record it: ${describe(e)}. Don't submit again. Once confirmed in PayPal, record it with: pnpm case reconcile ${disputeId} received`,
      );
    }
  }

  /**
   * Classifies a failed send. Only outcomes that PROVE PayPal didn't take the
   * evidence free the slot for a retry (an allowlist):
   *   - PaypalNotSentError: the token request failed; nothing was sent;
   *   - PaypalError with a 4xx status: PayPal looked at it and refused.
   * A 2xx with an odd body was accepted. Everything else (no response, a 5xx
   * that may have been processed, or any unexpected error) is ambiguous: we
   * re-check PayPal, and only UNDER_REVIEW counts as proof it landed (a
   * RESOLVED status could be the buyer cancelling). Otherwise the slot stays
   * claimed and the merchant is told to check PayPal first.
   *
   * Example: a 504 from PayPal's gateway after the dispute service stored the
   * evidence → re-check shows UNDER_REVIEW → recorded as submitted. If it
   * still shows WAITING_FOR_SELLER_RESPONSE (lag) → OUTCOME_UNKNOWN, no resend.
   */
  async function sendFailed(e: unknown): Promise<GateResult> {
    if (e instanceof PaypalResponseShapeError) return recordAccepted(undefined);

    const refused = e instanceof PaypalError && e.status >= 400 && e.status < 500;
    if (refused || e instanceof PaypalNotSentError) {
      const errDebugId = e instanceof PaypalError ? e.debugId : undefined;
      try {
        await repo.finishSubmission(submissionId, { state: "failed", error: describe(e), ...(errDebugId ? { paypalDebugId: errDebugId } : {}) });
        await log("provide_evidence_failed", { error: describe(e), paypalDebugId: errDebugId, rejectedByPaypal: refused });
      } catch {
        // Slot stays pending: safe, just needs an operator.
      }
      return refused
        ? fail(502, "PAYPAL_REJECTED", `PayPal didn't accept the submission: ${describe(e)}. You can review and try again.`)
        : fail(502, "SEND_FAILED", `Couldn't send the submission: ${describe(e)}. Nothing reached PayPal. You can try again.`);
    }

    // VERIFY (OPEN_QUESTIONS G5): UNDER_REVIEW is the status after a successful provide-evidence.
    const status = await deps.reader
      .getDispute(disputeId)
      .then((r) => r.data.status)
      .catch(() => undefined);
    if (status === UNDER_REVIEW_STATUS) return recordAccepted(status);
    await log("provide_evidence_unknown", { error: describe(e), recheckStatus: status ?? "unreachable" }).catch(() => {});
    return fail(502, "OUTCOME_UNKNOWN", `We can't confirm whether PayPal received the evidence. Check the dispute in PayPal, then record what you find with: pnpm case reconcile ${disputeId} received|not-received. A rebuild that sees ${UNDER_REVIEW_STATUS} records it automatically.`);
  }
}

async function blocked(deps: GateDeps, disputeId: string, httpStatus: 409, code: string, message: string): Promise<GateResult> {
  await deps.repo.logActivity(disputeId, "submit_blocked", { code });
  return fail(httpStatus, code, message);
}

function sameSet(a: Set<string>, b: Set<string>) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function describe(e: unknown): string {
  if (e instanceof PaypalError) return `${e.status}${e.errorName ? ` ${e.errorName}` : ""}${e.debugId ? ` (PayPal-Debug-Id ${e.debugId})` : ""}`;
  return e instanceof Error ? e.message : String(e);
}
