# Open questions

Every `VERIFY` item in the code, with the answer and its source once known.
Status: **open** · **answered (docs)** = from PayPal's docs/spec, still to confirm against a real sandbox response · **confirmed** = seen in a real sandbox response (link to `SANDBOX_PROBE.md` / fixture).

Primary source for "answered (docs)": PayPal's official OpenAPI spec
[`customer_disputes_v1.json`](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/customer_disputes_v1.json)
(commit `a54ed770`, 2025-07-16), referred to as **spec** below.

## Gate (CLAUDE §3)

| # | Question | Status | Answer / source |
|---|---|---|---|
| G1 | Sandbox REST app (Merchant) gets a token; `GET /v1/customer/disputes` returns 200 | open | Run `pnpm probe:sandbox` (needs credentials) |
| G2 | A Resolution Center dispute from the personal account appears via API on the business app | open | — |
| G3 | `require-evidence` moves it to `WAITING_FOR_SELLER_RESPONSE` | answered (docs) | spec: sandbox only; needs status `UNDER_REVIEW` and a `require-evidence` link; body `{"action":"SELLER_EVIDENCE"}` (or `BUYER_EVIDENCE`). Implemented in `packages/paypal/src/sandbox.ts`, opt-in via `--require-evidence` |
| G4 | Exact `provide-evidence` request format | **open, conflicting sources** | spec: `POST /v1/customer/disputes/{id}/provide-evidence`, request body only shows a multipart file part named `evidence-file`; description says "specify the evidence in the JSON request body". [Test & go-live guide](https://developer.paypal.com/disputes/test-go-live) (read via a summariser, not verbatim) shows `Content-Type: multipart/related` with an `input` JSON part and `file1`, `file2`… parts. Evidence object fields (spec `evidence`): `evidence_type`, `evidence_info` {`tracking_info`[], `refund_ids`[]}, `documents`, `notes`. The verbatim `.md` of that guide has **no** provide-evidence curl. It does show the same multipart pattern (`-F 'input={…}'` JSON part, `Content-Type: multipart/related`) for `change-reason`, and `multipart/form-data` for create-dispute. Best hypothesis: `input` JSON part `{"evidences":[…]}` + file parts. Confirm with a real call (M2) |
| G4a | `notes` max length | answered (docs) | spec `evidence.notes`: minLength 1, maxLength **2000** → `PROVIDE_EVIDENCE_NOTES_MAX` |
| G4b | File types / size / count limits | answered (docs) | [Supported file types and sizes](https://developer.paypal.com/disputes/supported-file-sizes-types) (verbatim, last updated May 21, 2026): `.jpg`, `.jpeg`, `.gif`, `.png`, `.pdf`; **under 10 MB per file**; **up to 50 MB per API call**. No file-count limit stated. (An earlier summariser read of the guide claimed 20 MB/100 MB/10 files. That was wrong; discard it.) |
| G4c | `evidence_type` enum | answered (docs) | spec `evidence.evidence_type`: 76 values incl. `PROOF_OF_FULFILLMENT`, `PROOF_OF_REFUND`, `PROOF_OF_DELIVERY_SIGNATURE`, `PROOF_OF_RECEIPT_COPY`, `RETURN_POLICY`, `OTHER` … Spec note: `evidence_info` expected for `PROOF_OF_FULFILLMENT`, `PROOF_OF_REFUND`, `PROOF_OF_RETURN`; documents + notes for the rest |
| G5 | One `provide-evidence` succeeds; post-submission status captured | open | M2 (kill criterion: by Oct 14) |
| G6 | Sandbox settle closes in merchant's favour | answered (docs) | spec: `POST …/adjudicate` `{"adjudication_outcome":"SELLER_FAVOR"}` (sandbox only; needs `UNDER_REVIEW` + `adjudicate` link). Outcome code `RESOLVED_SELLER_FAVOUR` (note British spelling in outcome vs `FAVOR` in request) |
| G7 | Action link rel names as returned (hyphen vs underscore) | open | Normalised either way (`packages/core/src/actions.ts`); probe records raw rels |
| G8 | Webhook event names; does sandbox deliver them? | answered (docs), delivery open | `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED`, verbatim in [Test and go live](https://developer.paypal.com/disputes/test-go-live.md) ("Test webhooks": wait a few minutes after creating the dispute for actions to become available). Sandbox delivery still to observe |
| G9 | API dispute creation (`DISPUTE_CREATE` scope) | open | Nice-to-have; request scope early |
| G10 | Add Tracking API in sandbox | open | — |
| G11 | AG Studio trial behaviour on expiry; covers Dec 15? | open | Ask AG Grid team on the PayPal Discord |

## Reason → evidence (answered, docs)

[Dispute reasons and evidence](https://developer.paypal.com/disputes/reasons-evidence) (`.md` read verbatim 2026-10-06) is encoded row by row in `packages/core/src/reason-map.ts`, with each row's quote. Highlights:
- INR: `PROOF_OF_FULFILLMENT` via tracking_info **or** notes/documents; `PROOF_OF_REFUND` via refund_ids.
- SNAD: `OTHER` (notes/documents: description, item URL, return policy, contract, affidavit); `PROOF_OF_REFUND`.
- UNAUTHORISED: `PROOF_OF_FULFILLMENT` via tracking_info only; `PROOF_OF_REFUND`; `OTHER`.
- Every other reason: `PROOF_OF_REFUND` + `OTHER`.
- Which fact kinds satisfy each type is Alibi's mapping, derived from PayPal's examples.

## Other API facts (answered from spec)

- Endpoints: `GET /v1/customer/disputes`, `GET /v1/customer/disputes/{id}`, `POST …/{id}/provide-evidence`, `…/send-message` (multipart, file part `message_document`), `…/accept-claim`, `…/make-offer`, `…/escalate`, `…/appeal`, `…/acknowledge-return-item`, `…/provide-supporting-info`, `…/require-evidence` (sandbox), `…/adjudicate` (sandbox).
- Scopes: read `https://uri.paypal.com/services/disputes/read-seller`; write `…/disputes/update-seller`. The probe reports which the app was granted.
- List params: `start_time`, `disputed_transaction_id`, `page_size` (1–50, default 10), `next_page_token`, `dispute_state`, `update_time_before`, `update_time_after`. `start_time` must be within the last 180 days.
- `status`: `OPEN`, `WAITING_FOR_BUYER_RESPONSE`, `WAITING_FOR_SELLER_RESPONSE`, `UNDER_REVIEW`, `RESOLVED`, `OTHER`.
- `dispute_life_cycle_stage`: `INQUIRY`, `CHARGEBACK`, `PRE_ARBITRATION`, `ARBITRATION`.
- `reason`: `MERCHANDISE_OR_SERVICE_NOT_RECEIVED`, `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`, `UNAUTHORISED`, `CREDIT_NOT_PROCESSED`, `DUPLICATE_TRANSACTION`, `INCORRECT_AMOUNT`, `PAYMENT_BY_OTHER_MEANS`, `CANCELED_RECURRING_BILLING`, `PROBLEM_WITH_REMITTANCE`, `OTHER`.
- Requested evidence: `evidences[]` entries with `source = REQUESTED_FROM_SELLER`.
- `tracking_info`: required `carrier_name` (enum, 1257 values. Every value Alibi emits was checked present on 2026-10-06: `UPS`, `USPS`, `FEDEX`, `DHL`, `ROYAL_MAIL`, `CANADA_POST`, `AUSTRALIA_POST`, `DPD`, `GLS`, `ONTRAC`, `NIPOST_NG`, `OTHER`. `carrier_name_other` (max 2000) is mandatory when the carrier is `OTHER`) and `tracking_number`; optional `tracking_url`.
- `provide-evidence` is only possible when the dispute's HATEOAS links include `provide-evidence` (spec description).

## Still to answer

- Best endpoint to link dispute → capture/transaction (`disputed_transactions[].seller_transaction_id` → Transaction Search or Captures API?).
- Poirot / Open Agent IP terms allow reuse (SPEC §6.2).
