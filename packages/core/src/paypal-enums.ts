// Known PayPal Disputes v1 enum values.
// Source: PayPal's official OpenAPI spec,
//   https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/customer_disputes_v1.json
//   (commit a54ed770aec6cfa9f0fdde2bc0f9318fff7b18fd, 2025-07-16)
// Real sandbox responses override this file — see docs/OPEN_QUESTIONS.md.

/** components.schemas.status */
export const DISPUTE_STATUSES = [
  "OPEN",
  "WAITING_FOR_BUYER_RESPONSE",
  "WAITING_FOR_SELLER_RESPONSE",
  "UNDER_REVIEW",
  "RESOLVED",
  "OTHER",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** components.schemas.dispute_lifecycle_stage */
export const DISPUTE_STAGES = ["INQUIRY", "CHARGEBACK", "PRE_ARBITRATION", "ARBITRATION"] as const;

/** components.schemas.dispute_reason */
export const DISPUTE_REASONS = [
  "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  "UNAUTHORISED",
  "CREDIT_NOT_PROCESSED",
  "DUPLICATE_TRANSACTION",
  "INCORRECT_AMOUNT",
  "PAYMENT_BY_OTHER_MEANS",
  "CANCELED_RECURRING_BILLING",
  "PROBLEM_WITH_REMITTANCE",
  "OTHER",
] as const;

/** components.schemas.evidence.properties.source */
export const EVIDENCE_SOURCES = [
  "REQUESTED_FROM_BUYER",
  "REQUESTED_FROM_SELLER",
  "SUBMITTED_BY_BUYER",
  "SUBMITTED_BY_SELLER",
  "SUBMITTED_BY_PARTNER",
] as const;

/** components.schemas.evidence.properties.notes.maxLength */
export const PROVIDE_EVIDENCE_NOTES_MAX = 2000;

/** components.schemas.require_evidence.properties.action (sandbox only) */
export const REQUIRE_EVIDENCE_ACTIONS = ["BUYER_EVIDENCE", "SELLER_EVIDENCE"] as const;

/** components.schemas.adjudicate.properties.adjudication_outcome (sandbox only) */
export const ADJUDICATION_OUTCOMES = ["BUYER_FAVOR", "SELLER_FAVOR"] as const;
