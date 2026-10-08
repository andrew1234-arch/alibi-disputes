import { z } from "zod";
import { baselineStance, type DraftClaim, type Stance } from "@alibi/core";
import type { CaseParts } from "@alibi/casefile";
import type { Llm } from "./llm";
import { caseInput, STRATEGIST_SYSTEM } from "./prompts";

// Strategist (SPEC §3 step 4): fight / fight with gaps / consider conceding,
// with reasons that cite evidence. Its reasons go through the verifier like
// draft claims (finishCaseFile).

const claimSchema = z.object({ text: z.string(), evidenceIds: z.array(z.string()) });

export const strategySchema = z.object({
  stance: z.enum(["fight", "fight_with_gaps", "consider_conceding"]),
  reasons: z.array(claimSchema),
});
export type StrategyOutput = z.infer<typeof strategySchema>;

const RANK: Record<Stance, number> = { consider_conceding: 0, fight_with_gaps: 1, fight: 2 };

/**
 * The model may be more cautious than the evidence-based baseline, never more
 * aggressive: it can't tell a merchant to "fight" when the checklist has gaps.
 *
 * Example: baseline "fight_with_gaps" (no delivery scan), model says "fight"
 * → "fight_with_gaps". Model says "consider_conceding" → kept.
 */
export function capStance(model: Stance, baseline: Stance): Stance {
  return RANK[model] <= RANK[baseline] ? model : baseline;
}

export async function runStrategist(parts: CaseParts, llm: Llm): Promise<{ stance: Stance; reasons: DraftClaim[]; capped: boolean }> {
  const out = await llm.complete({ purpose: "strategist", system: STRATEGIST_SYSTEM, user: caseInput(parts), schema: strategySchema });
  const baseline = baselineStance(parts.checklist);
  const stance = capStance(out.stance, baseline);
  return { stance, reasons: out.reasons.slice(0, 4), capped: stance !== out.stance };
}
