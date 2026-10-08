import { approvalHash } from "@alibi/core/server";
import type { Repo } from "@alibi/store";

// Records the merchant's explicit approval of one exact draft (by hash). The
// client sends the hash it rendered; if the draft has changed since, the
// approval is refused so the merchant re-reads what will actually be sent.

export type ApproveResult = { ok: true } | { ok: false; httpStatus: 404 | 409; code: string; message: string };

export async function approveDraft(
  disputeId: string,
  hash: string,
  deps: { readonly: boolean; repo: Repo; now: () => Date },
): Promise<ApproveResult> {
  if (deps.readonly) {
    return { ok: false, httpStatus: 409, code: "READ_ONLY_DEMO", message: "Approvals are turned off on the public demo." };
  }
  if (!(await deps.repo.getCase(disputeId))) return { ok: false, httpStatus: 404, code: "CASE_NOT_FOUND", message: "No case file for this dispute yet." };
  const ok = await deps.repo.approve(disputeId, hash, approvalHash, deps.now());
  if (!ok) {
    return { ok: false, httpStatus: 409, code: "STALE_DRAFT", message: "The draft changed since you opened it. Review the latest version and approve again." };
  }
  await deps.repo.logActivity(disputeId, "approved", { draftHash: hash });
  return { ok: true };
}
