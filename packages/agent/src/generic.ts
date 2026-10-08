import { z } from "zod";
import { extractFacts, type CaseFile } from "@alibi/core";
import { verifyDraft } from "@alibi/core/server";
import type { Llm } from "./llm";

// "Generic AI reply" comparison (SPEC §5.6): the visual answer to "why not
// just ask a chatbot?". Same model, but the prompt has only the dispute
// reason and amount, no case file. The reply is then checked against this
// case's real evidence, sentence by sentence:
//
//   supported  every fact in the sentence is in some record
//   invented   it states a fact (amount, date, id, tracking number, quote,
//              carrier) that no record contains
//   vague      no checkable fact at all ("We shipped your item promptly.")
//
// Plus what it can't do without a case file: no tracking info, no documents,
// so every requested evidence type stays unanswered.

export const GENERIC_SYSTEM = "You are a helpful assistant.";

export function genericPrompt(c: Pick<CaseFile, "reason" | "amount">): string {
  const amount = c.amount.missing ? "unknown" : `${c.amount.value} ${c.amount.currency}`;
  return `I'm an online seller. A buyer opened a PayPal dispute against me. Reason: ${c.reason}. Amount: ${amount}. Write my response to PayPal.`;
}

const genericSchema = z.object({ reply: z.string() });

export type SentenceVerdict = "supported" | "invented" | "vague";

export interface GenericComparison {
  model: string;
  prompt: string;
  reply: string;
  sentences: { text: string; verdict: SentenceVerdict; reason?: string }[];
  /** Requested evidence types the generic reply leaves unanswered (all of them: it has no evidence to attach). */
  unanswered: string[];
  createdAt: string;
}

// Words that end in "." without ending a sentence ("Oct. 2", "U.S. mail", "Mr. Lee").
const ABBREVIATIONS = new Set(
  "jan feb mar apr jun jul aug sep sept oct nov dec mr mrs ms dr st no vs etc inc ltd co approx e.g i.e u.s u.k".split(" "),
);

/**
 * Splits prose into sentences on line breaks, and on . ! ? followed by
 * whitespace and a capital letter or quote, unless the word before the "."
 * is an abbreviation or a single letter.
 *
 * Example: "Paid on Oct. 2, 2026 via U.S. mail. It arrived." → ["Paid on Oct. 2, 2026 via U.S. mail.", "It arrived."]
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    let start = 0;
    const re = /[.!?]+(?=\s+["'\u201C(]?[A-Z])/g;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      const word = /([A-Za-z.]+)$/.exec(line.slice(start, m.index))?.[1]?.toLowerCase() ?? "";
      const bare = word.replace(/\.$/, "");
      if (m[0] === "." && (ABBREVIATIONS.has(bare) || /^[a-z]$/.test(bare) || /^([a-z]\.)+[a-z]$/.test(bare))) continue;
      out.push(line.slice(start, m.index + m[0].length));
      start = m.index + m[0].length;
    }
    out.push(line.slice(start));
  }
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Pure: classify each sentence against the case's evidence. A sentence is
 * checked as if it cited every record, so "invented" means no record anywhere
 * supports it, which is generous to the generic reply.
 */
export function assessGenericReply(reply: string, cf: Pick<CaseFile, "evidence" | "checklist">, timeZone?: string): Omit<GenericComparison, "model" | "prompt" | "createdAt"> {
  const allIds = Object.keys(cf.evidence);
  const out = sentences(reply).map((text) => {
    if (extractFacts(text).length === 0) return { text, verdict: "vague" as const };
    // No notes-length limit here: a long sentence isn't an invented one.
    const v = verifyDraft({ claims: [{ text, evidenceIds: allIds }], documents: [] }, cf.evidence, [], { notesMax: Number.POSITIVE_INFINITY, ...(timeZone ? { timeZone } : {}) });
    const removed = v.removed[0];
    return removed ? { text, verdict: "invented" as const, reason: removed.reason } : { text, verdict: "supported" as const };
  });
  return { reply, sentences: out, unanswered: cf.checklist.map((c) => c.evidenceType) };
}

/** One LLM call: the generic reply, then the pure assessment. */
export async function compareWithGenericReply(
  cf: Pick<CaseFile, "reason" | "amount" | "evidence" | "checklist">,
  llm: Llm,
  now: Date,
  timeZone?: string,
): Promise<GenericComparison> {
  const prompt = genericPrompt(cf);
  const { output, model } = await llm.complete({ purpose: "generic_reply", system: GENERIC_SYSTEM, user: prompt, schema: genericSchema });
  return { model, prompt, ...assessGenericReply(output.reply, cf, timeZone), createdAt: now.toISOString() };
}
