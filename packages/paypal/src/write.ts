import { z } from "zod";
import type { PaypalEnv, PaypalEvidence } from "@alibi/core";
import { PROVIDE_EVIDENCE_NOTES_MAX } from "@alibi/core";
import { PaypalClient, type PaypalClientOptions } from "./client";
import { linkSchema } from "./schemas";

// Write surface (@alibi/paypal/write). Imported ONLY by apps/web server routes,
// after the approval gate (CLAUDE §1.1). Never by @alibi/agent. Writes are
// never retried automatically.

// ---- File rules: https://developer.paypal.com/disputes/supported-file-sizes-types (verbatim, 2026-10-06)
export const ALLOWED_EVIDENCE_FILE_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".png": "image/png",
  ".pdf": "application/pdf",
};
export const MAX_EVIDENCE_FILE_BYTES = 10 * 1024 * 1024; // "Less than 10 MB per file"
export const MAX_EVIDENCE_TOTAL_BYTES = 50 * 1024 * 1024; // "Up to 50 MB per API call"

// ---- Multipart layout. VERIFY (docs/OPEN_QUESTIONS.md G4):
// the spec names one file part "evidence-file"; PayPal's guides use an "input"
// JSON part for other dispute actions. Confirm both with the first real call.
export const INPUT_PART = "input";
export const FILE_PART = "evidence-file";

export interface EvidenceFile {
  filename: string;
  bytes: Uint8Array;
}

const trackingSchema = z.object({
  carrier_name: z.string().min(1).max(255),
  tracking_number: z.string().min(1).max(255),
  carrier_name_other: z.string().min(1).max(2000).optional(),
});

/** Request validation mirrors PayPal's `evidence` schema limits. */
export const provideEvidenceInputSchema = z.object({
  evidences: z
    .array(
      z.object({
        evidence_type: z.string().regex(/^[0-9A-Z_]+$/),
        evidence_info: z
          .object({
            tracking_info: z.array(trackingSchema).min(1).max(10).optional(),
            refund_ids: z.array(z.string().min(1).max(255)).min(1).max(100).optional(),
          })
          .optional(),
        notes: z.string().min(1).max(PROVIDE_EVIDENCE_NOTES_MAX).optional(),
      }),
    )
    .min(1)
    .max(100),
});

const subsequentActionSchema = z.looseObject({ links: z.array(linkSchema).optional() });

export class EvidenceFileError extends Error {
  override name = "EvidenceFileError";
}

/** Throws EvidenceFileError if a file breaks PayPal's documented limits. Returns the content type per file. */
export function checkEvidenceFiles(files: readonly EvidenceFile[]): string[] {
  let total = 0;
  const types = files.map((f) => {
    const ext = /\.[^.]+$/.exec(f.filename.toLowerCase())?.[0] ?? "";
    const type = ALLOWED_EVIDENCE_FILE_TYPES[ext];
    if (!type) throw new EvidenceFileError(`${f.filename}: PayPal accepts only .jpg, .jpeg, .gif, .png and .pdf`);
    if (f.bytes.byteLength >= MAX_EVIDENCE_FILE_BYTES) throw new EvidenceFileError(`${f.filename}: must be under 10 MB`);
    total += f.bytes.byteLength;
    return type;
  });
  if (total > MAX_EVIDENCE_TOTAL_BYTES) throw new EvidenceFileError("Attachments exceed PayPal's 50 MB per-request limit");
  return types;
}

/**
 * The same local checks provideEvidence runs, without sending anything.
 * The approval gate calls this before claiming the submission slot, so a
 * payload or file PayPal would never accept is reported as our problem (422),
 * not as a PayPal rejection. Returns a reason, or undefined if it's sendable.
 */
export function checkProvideEvidence(input: { evidences: PaypalEvidence[] }, files: readonly EvidenceFile[]): string | undefined {
  const parsed = provideEvidenceInputSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".") || "evidences"}: ${i.message}`).join("; ");
  try {
    checkEvidenceFiles(files);
  } catch (e) {
    if (e instanceof EvidenceFileError) return e.message;
    throw e;
  }
  return undefined;
}

export function createPaypalWriter(env: PaypalEnv, opts?: PaypalClientOptions) {
  const client = new PaypalClient(env, opts);
  return {
    /** POST /v1/customer/disputes/{id}/provide-evidence (multipart). One call, no retry. */
    async provideEvidence(disputeId: string, input: { evidences: PaypalEvidence[] }, files: readonly EvidenceFile[] = []) {
      const body = provideEvidenceInputSchema.parse(input);
      const types = checkEvidenceFiles(files);
      const form = new FormData();
      form.append(INPUT_PART, new Blob([JSON.stringify(body)], { type: "application/json" }));
      files.forEach((f, i) => form.append(FILE_PART, new Blob([new Uint8Array(f.bytes)], { type: types[i]! }), f.filename));
      return client.post(`/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`, form, subsequentActionSchema);
    },
  };
}
export type PaypalWriter = ReturnType<typeof createPaypalWriter>;
