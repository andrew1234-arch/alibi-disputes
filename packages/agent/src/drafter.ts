import { z } from "zod";
import type { DraftClaim, Stance } from "@alibi/core";
import { verifyDraft, type DraftInput, type VerifyOptions } from "@alibi/core/server";
import type { CaseParts } from "@alibi/casefile";
import type { Llm } from "./llm";
import { caseInput, DRAFTER_SYSTEM, REPAIR_SYSTEM } from "./prompts";

// Drafter (SPEC §3 step 5) with one repair round:
//
//   draft (LLM) → verify (pure) → if anything was removed: repair (LLM, told
//   exactly what was rejected) → the final verify happens in finishCaseFile.
//
// The repair round is the agent loop judges can watch: the checker catches an
// unsupported fact, the drafter fixes it, and the activity feed shows both.
// At most one repair: if the second draft still has problems, the verifier
// simply removes them.

export const draftSchema = z.object({
  claims: z.array(z.object({ text: z.string(), evidenceIds: z.array(z.string()) })),
  trackingInfo: z.array(z.object({ carrier: z.string(), number: z.string() })),
  refundIds: z.array(z.string()),
  documents: z.array(z.string()),
});
export type DraftOutput = z.infer<typeof draftSchema>;

export function toDraftInput(out: DraftOutput): DraftInput {
  const evidenceInfo = {
    ...(out.trackingInfo.length ? { trackingInfo: out.trackingInfo } : {}),
    ...(out.refundIds.length ? { refundIds: out.refundIds } : {}),
  };
  return {
    claims: out.claims,
    ...(Object.keys(evidenceInfo).length ? { evidenceInfo } : {}),
    documents: [...new Set(out.documents)],
  };
}

export interface DraftResult {
  draft: DraftInput;
  /** What the checker removed from the first draft (shown in the activity feed). */
  firstPassRemoved: { text: string; reason: string }[];
  repaired: boolean;
}

export async function runDrafter(
  parts: CaseParts,
  llm: Llm,
  strategy: { stance: Stance; reasons: DraftClaim[] },
  verify: VerifyOptions = {},
): Promise<DraftResult> {
  const context = { strategy: { stance: strategy.stance } };
  const first = toDraftInput(
    await llm.complete({ purpose: "drafter", system: DRAFTER_SYSTEM, user: caseInput(parts, context), schema: draftSchema }),
  );
  const check = verifyDraft(first, parts.evidence, parts.checklist, verify);
  if (check.removed.length === 0) return { draft: first, firstPassRemoved: [], repaired: false };

  const repaired = toDraftInput(
    await llm.complete({
      purpose: "drafter_repair",
      system: REPAIR_SYSTEM,
      user: caseInput(parts, { ...context, previousDraft: first, rejected: check.removed }),
      schema: draftSchema,
    }),
  );
  return { draft: repaired, firstPassRemoved: check.removed, repaired: true };
}
