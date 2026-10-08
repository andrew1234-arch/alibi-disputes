import { z } from "zod";

// zod schemas for PayPal responses (CLAUDE §1.6). Loose objects: unknown fields
// are tolerated, the fields we rely on are enforced.
// Field names from PayPal's OpenAPI spec (customer_disputes_v1.json, see
// @alibi/core paypal-enums.ts). Which fields are *always* present in real
// sandbox responses is VERIFY — tighten after docs/SANDBOX_PROBE.md has data.

export const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
  app_id: z.string().optional(),
});

export const moneySchema = z.looseObject({
  currency_code: z.string(),
  value: z.string(),
});

export const linkSchema = z.looseObject({
  href: z.string(),
  rel: z.string(),
  method: z.string().optional(),
});

export const disputeSummarySchema = z.looseObject({
  dispute_id: z.string(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  reason: z.string().optional(),
  status: z.string(),
  dispute_amount: moneySchema.optional(),
  dispute_life_cycle_stage: z.string().optional(),
  dispute_channel: z.string().optional(),
  links: z.array(linkSchema).optional(),
});
export type DisputeSummary = z.infer<typeof disputeSummarySchema>;

export const disputeListSchema = z.looseObject({
  items: z.array(disputeSummarySchema).optional().default([]),
  links: z.array(linkSchema).optional(),
});

export const evidenceSchema = z.looseObject({
  evidence_type: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
  date: z.string().optional(),
  dispute_life_cycle_stage: z.string().optional(),
});

export const disputedTransactionSchema = z.looseObject({
  seller_transaction_id: z.string().optional(),
  buyer_transaction_id: z.string().optional(),
  create_time: z.string().optional(),
  transaction_status: z.string().optional(),
  gross_amount: moneySchema.optional(),
  invoice_number: z.string().optional(),
  custom: z.string().optional(),
});

export const messageSchema = z.looseObject({
  posted_by: z.string().optional(), // BUYER | SELLER (spec message.posted_by)
  time_posted: z.string().optional(),
  content: z.string().optional(),
});

export const disputeDetailSchema = disputeSummarySchema.extend({
  messages: z.array(messageSchema).optional(),
  reason: z.string(),
  disputed_transactions: z.array(disputedTransactionSchema).optional(),
  evidences: z.array(evidenceSchema).optional(),
  seller_response_due_date: z.string().optional(),
  buyer_response_due_date: z.string().optional(),
  dispute_outcome: z.looseObject({ outcome_code: z.string().optional() }).optional(),
});
export type DisputeDetail = z.infer<typeof disputeDetailSchema>;
