# Decisions

Short ADRs. Newest last.

## ADR-001 — Source of truth for PayPal API facts (2026-10-06)
PayPal's official OpenAPI spec (`paypal/paypal-rest-api-specifications`, `openapi/customer_disputes_v1.json`) is the first source for endpoints, enums and limits. Real sandbox responses override it. Every remaining unknown is in `OPEN_QUESTIONS.md`.

## ADR-002 — Internal packages ship TypeScript source (2026-10-06)
`@alibi/*` packages export `src/*.ts` directly. `apps/web` compiles them via `transpilePackages`, and scripts run via `tsx`. A library's `build` script is a strict `tsc --noEmit`, and `next build` is the only real artifact. There are no TS project references: pnpm already runs `-r build` in dependency order, which is what references were meant to give us, and this avoids a stale `dist/` going out of sync with `src/`.
The read/write split is enforced by package `exports`. `@alibi/paypal` has no root entry, only `./read`, `./write` and `./sandbox`.

## ADR-003 — TypeScript 5.9, not 7 (2026-10-06)
TypeScript 7 (the native port) is current, but Next.js 16's type-check step and editor plugin are proven on 5.x. Pinned `~5.9.3`. Revisit after the hackathon.

## ADR-004 — Host guard allows loopback only in test mode (2026-10-06)
`resolveBaseUrl` accepts exactly `https://api-m.sandbox.paypal.com`. With `PAYPAL_TEST_MODE=true` it also accepts `localhost` / `127.0.0.1` / `[::1]` (the test stub), and nothing else. Live PayPal is refused in every mode.

## ADR-005 — `DEMO_READONLY` defaults to true (2026-10-06)
If the variable is unset, submissions are disabled. Only the literal `false` enables them, so a missing variable can never open up the public demo.

## ADR-006 — require-evidence in the probe is opt-in (2026-10-06)
Even sandbox state changes need an explicit `--require-evidence` flag. The default probe run is read-only.

## ADR-007 — Verifier is strict and per-claim (2026-10-06)
Each fact in a claim must match the records *that claim cites*, not just any record in the case. This stops a claim borrowing a real tracking number to support an invented delivery date. One unsupported fact drops the whole claim, and every miss is listed in the reason.
Consequences, all deliberate:
- Derived numbers ("arrived 3 days later") are dropped. The drafter must state facts, not arithmetic.
- Day/month-ambiguous numeric dates (02/10/2026) are dropped. The drafter writes "Oct 2, 2026".
- A date also matches the record's calendar date in the merchant's time zone when one is given, because a 01:15 UTC event is still "yesterday" in Chicago.
- Clock times ("2:42pm", "14:15", "9 a.m.") are their own fact type. They match a record's `occurredAt` in UTC, or in the merchant's time zone when one is given, or a time written in the record. "2pm" matches the hour only. Without a time zone, a local time is dropped, so configure the zone. An invalid zone produces a warning, not a crash.
- `$` is compatible with any dollar currency. A claim that names a currency needs a cited record that names a compatible one: "€84" against a bare `84` is dropped. Adapters must store money as text with its currency ("84.00 USD").
- Not covered deterministically: numbers written as words, item names, tracking numbers with internal spaces. The optional LLM check (SPEC §5.5 step 5) is the backstop.

## ADR-008 — Claim order is priority (2026-10-06)
`DraftClaim` has no priority field. Array order is the priority, and when the notes exceed PayPal's 2000-character limit, claims are dropped whole from the end. The drafter prompt (M3) must order claims most-important first.

## ADR-009 — Hashing in core uses node:crypto (2026-10-06)
Evidence ids (`ev_` + 16 hex chars of SHA-256 over source/kind/ref/value) and draft hashes (SHA-256 over canonical JSON) are computed server-side only. That keeps `core` pure: deterministic, with no I/O.

## ADR-010 — Unmapped requested evidence types become manual-review gaps (2026-10-06)
If PayPal requests a type the reason map doesn't list for that reason, the checklist shows a gap telling the merchant to review it manually. It is never dropped and never forced into a type we know.

## ADR-011 — Coverage respects PayPal's submission routes (2026-10-06, review fix)
Each checklist item carries the routes PayPal accepts for that type under the dispute's reason (`tracking_info`, `refund_ids`, `notes_or_documents`). A type counts as addressed only through one of those routes. Example: for UNAUTHORISED, proof of fulfilment mentioned only in the notes is a gap that says tracking info is required.

## ADR-012 — Evidence identity includes occurredAt (2026-10-06, review fix)
Two "In transit" scans of the same parcel on different days are two facts. Before this change they hashed to the same id and case assembly threw.

## ADR-013 — `@alibi/core` vs `@alibi/core/server` (2026-10-06, review fix)
The root entry is browser-safe: types, enums, env, reason map, checklist, deadlines and extractors. Hashing, evidence ids and the verifier use `node:crypto` and live in `@alibi/core/server`. `test/entrypoints.test.ts` fails if a Node built-in ever enters the root entry's import graph.

## ADR-014 — Unlisted carriers go out as OTHER (2026-10-06, review fix)
Verified tracking info always uses a PayPal `carrier_name` enum value. A carrier Alibi can't map ("Evri") is sent as `carrier_name: OTHER` with `carrier_name_other`, which PayPal's spec makes mandatory for OTHER. It is never sent as free text.

## ADR-015 — Extensionless relative imports (2026-10-06)
Turbopack (`next build`) does not map `./x.js` specifiers onto `./x.ts` inside `transpilePackages`; tsc, tsx and vitest do. With `moduleResolution: "bundler"`, extensionless relative imports work for all four, so the internal packages use those.

## ADR-016 — `@alibi/store` package (2026-10-06, M2)
CLAUDE §4 lists no storage package, but scripts (seed/reset) and the web app both need the repository, and they may not import across packages by relative path. So storage lives in `packages/store`: Postgres through a small `Sql` interface. It depends only on `core`.
- Production uses `pg` with Render Postgres.
- Tests and local dev without Postgres use **PGlite** (real Postgres compiled to WASM): `DATABASE_URL=pglite://memory` or `pglite://./.data/alibi`. PGlite is single-process, so only one process may open an on-disk PGlite at a time. It also boots slowly on some machines (~30 s here), so tests share one instance per file and truncate between tests.
- The case file (evidence, checklist, draft) is one JSONB document. Approvals (an audit log), submissions, webhook events and activity are tables, because they carry the safety guarantees.
- `submissions_one_live`, a partial unique index, allows at most one pending or succeeded submission per dispute. Double clicks, two tabs and concurrent requests can't send twice. Tested with 5 concurrent attempts.

## ADR-017 — Ambiguous writes re-check PayPal before freeing the slot (2026-10-06, M2)
A PayPal *error response* means it didn't take the evidence: the slot is released for a manual retry. *No response at all* (`PaypalNetworkError`) is ambiguous, so the gate re-fetches the dispute first:
- if it moved off WAITING_FOR_SELLER_RESPONSE, the submission is recorded as succeeded;
- if it's still waiting, the slot stays claimed (`OUTCOME_UNKNOWN`): PayPal may have received it and not updated the status yet *(changed 2026-10-08, review fix)*;
- if PayPal can't be reached, the slot stays claimed (`OUTCOME_UNKNOWN`) until an operator checks.

*Tightened 2026-10-08 (third review pass):* slot release is an **allowlist**. Only a PayPal 4xx (`PAYPAL_REJECTED`) or a `PaypalNotSentError` (the token request failed, so nothing was sent; `SEND_FAILED`) frees it. Everything else is ambiguous: no response, a 5xx that may have been processed, or any unexpected error. For those the gate re-checks PayPal, and only `UNDER_REVIEW` counts as proof the evidence landed; `RESOLVED` could be the buyer cancelling. Otherwise the outcome is `OUTCOME_UNKNOWN` and the slot is kept. VERIFY: `UNDER_REVIEW` is the post-submission status (G5). A 2xx with an unexpected body counts as accepted. Marking the row succeeded and writing `case.submission` happen in one transaction (`recordSubmissionSuccess`). If PayPal accepted but recording it locally fails, the slot stays `pending` and the merchant gets `SUBMITTED_NOT_RECORDED` (500): never invite a second send. Payload and file limits are checked before the slot is claimed (422 `PAYLOAD_INVALID`).

Reads retry on network errors as well as 429/5xx. Writes never retry.

Missing data shows as "—" with a reason (CLAUDE §1.3). A disputed amount PayPal omits becomes `{ value: "—", missing: "…" }`. A transaction without `gross_amount` gets the value "—", never its id, and the template drafter won't claim "the buyer paid" from it.

## ADR-018 — Operator CLI is an API client (2026-10-06, M2)
`pnpm case build|show|approve|submit` calls the web app's routes. This has two benefits: the approval gate is the same code the UI will use (only web routes import `@alibi/paypal/write`, CLAUDE §4.1), and only one process opens the database. `approve` needs the dispute id typed to confirm, and it approves the draft hash the CLI just displayed.

## ADR-019 — Template drafter now, LLM drafter in M3 (2026-10-06, M2)
`@alibi/casefile` has a deterministic template drafter that writes claims straight from record values, so it passes the verifier by construction. It powers the M2 sandbox submission, and it will stay as the fallback when the LLM is unavailable or over budget. M3 plugs the LLM strategist and drafter into `buildCase(…, { draft })`. Their output goes through the same verifier.

## ADR-020 — Webhook id is optional until deployment (2026-10-06, M2)
`PAYPAL_WEBHOOK_ID` exists only after the public URL is registered with PayPal. Without it, the web app starts but refuses every webhook (401), never accepting one unverified. The env schema for the web server (`webEnvSchema`) asks only for what M2 needs. `appEnvSchema` (Anthropic key, model) applies from M3.

## ADR-021 — Rebuilds keep history, drop stale approvals (2026-10-06, M2)
When a webhook triggers a rebuild, `carryOver` keeps the submission record. It keeps the approval only if the rebuild would send exactly the same thing; otherwise the merchant re-approves.

*Updated 2026-10-08 (review fixes):*
- **The approval covers the payload, not just the text.** `approvalHash` covers the draft plus the exact provide-evidence payload, which depends on the checklist and evidence. A newly requested type lapses the approval even if the draft text is unchanged. The value is still stored as `approval.draftHash`.
- **Rebuild merges are locked.** `repo.updateCase` does a read-modify-write under a per-dispute advisory lock plus a row lock. A rebuild running alongside an approval or a submit merges with it instead of overwriting it.
- **New evidence rounds.** If the dispute left WAITING_FOR_SELLER_RESPONSE after our submission and is back there now, PayPal wants more evidence. The old submission rows become `superseded`, which frees the one-live slot, and the old approval and submission are dropped from the case. If the post-submission status was unknown or still waiting, it's not treated as a new round; an operator checks PayPal first.

## ADR-022 — Evidence notes go on the first evidence entry (2026-10-06, M2)
A response answering several requested types sends the merchant's notes once, on the first evidence, not repeated per type. VERIFY with the first real submission how the PayPal reviewer sees it.

## ADR-023 — Operator token guards merchant actions (2026-10-08, review fix)
Approve, submit and rebuild act for the merchant, and with `DEMO_READONLY=false` they would otherwise be open to anyone with the URL. The case GET even shows the hash needed to approve. When submissions are on, those routes require `Authorization: Bearer $ALIBI_OPERATOR_TOKEN`. So do case reads and demo documents, which carry buyer data, compared in constant time. Env validation refuses to start without a token of at least 32 characters. In read-only mode the routes refuse on their own and need no token. The operator CLI sends the token from env. A real merchant login replaces this when the UI lands; recorded under "Later".

## ADR-024 — Webhook ids are forgotten if handling fails (2026-10-08, review fix)
The event id is recorded right after signature verification, to dedupe retries. *Superseded by ADR-028:* the event id and the queued rebuild now commit in one transaction, so there's nothing to undo. If that transaction fails, the route returns 500 and PayPal's retry is processed normally.

## ADR-025 — Durable rebuild queue (2026-10-08, review fix)
A webhook used to record the event id as processed and then rebuild fire-and-forget. A failed rebuild, or a restart mid-rebuild, silently lost the update, and PayPal's retry was dropped as a duplicate. Now the webhook only writes a `pending_rebuilds` row before answering. A worker in the web process drains it and retries with backoff (30 s doubling, capped at 1 h); at startup it picks up rows a previous process left behind. A row is deleted only when the rebuild for its `version` succeeds, and a failure backs off only its own version, so a re-queue during a rebuild is neither lost nor delayed. A call during a pass triggers another pass right after it. Polling PayPal for disputes with no webhook at all is still the separate fallback (SPEC).

## ADR-026 — Gate re-checks the approval atomically with the claim (2026-10-08, review fix)
The gate's checks take seconds (verifier, PayPal re-fetch, document loads). `beginSubmission` now re-reads the stored case under the case lock and claims the slot only if it still carries the same, still-valid approval; otherwise it returns 409 `APPROVAL_CHANGED`. Errors from failing to get an OAuth token are `PaypalNotSentError`, never mistaken for a write outcome. A response body that breaks off mid-read counts as `PaypalNetworkError` (ambiguous).

## ADR-028 — Unconfirmed submissions get resolved, never stuck (2026-10-08, review fix)
A submission left `pending` (OUTCOME_UNKNOWN, SUBMITTED_NOT_RECORDED) would otherwise block the dispute forever. There are two ways out:
- **Automatic.** A rebuild that sees `UNDER_REVIEW`, with the row older than 2 minutes (so it can't still be in flight), marks it succeeded and writes `case.submission`. A later evidence request is then detected as a new round.
- **Operator.** `pnpm case reconcile <id> received|not-received` (POST `/api/cases/[id]/reconcile`, operator token) records what the operator found in PayPal: `received` keeps the slot blocked, and `not-received` frees it. The current PayPal status is stored with the decision.

The rebuild merge is one transaction under the case lock (`repo.applyRebuild`): reconcile, merge, detect a new round, supersede. The slot can never be free while the stored case still carries the old round's approval.

Webhooks record the event id and queue the rebuild in one transaction too, so an event is never marked processed without its rebuild queued. Rebuilds give up on permanent errors (PayPal 4xx other than 429) and after 24 attempts, logging `build_abandoned`.

## ADR-027 — One process per on-disk PGlite (2026-10-08, review fix)
`pglite://<dir>` takes a pid lock file (`<dir>.alibi-lock`). A second process, such as `seed:demo` while `web:dev` runs, fails with a clear message instead of corrupting the data. A lock left by a dead process is taken over. Production uses Postgres and is unaffected.

## ADR-029 — LLM strategist and drafter (2026-10-08, M3)
- **Loop** (`packages/agent`, readable top to bottom): prepare case (pure) → strategist (LLM) → drafter (LLM) → checker → one repair round if the checker removed anything → final verify (`finishCaseFile`). The repair prompt lists exactly what was rejected and why.
- **Port and adapter.** The agent talks to an `Llm` interface (`llm.ts`); `anthropic.ts` implements it with `client.beta.messages.parse` and `betaZodOutputFormat`. The output is re-validated with the same zod schema (CLAUDE §1.6). Thinking is adaptive, effort `medium`. Refusals are checked before content is read. `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) is sent only to models that accept it.
- **Guards.**
  - Strategy reasons are claims: they cite evidence and are verified, and a bad reason is removed and labelled "Strategy reason:".
  - The model's stance is capped at the evidence-based baseline (`capStance`), so it can be more cautious, never more aggressive.
  - The prompt carries record data only (ids, labels, values, `hasDocument`), never document URLs or credentials. Buyer text is marked as data.
- **Budget and fallback.** `ALIBI_MAX_LLM_CALLS_PER_CASE` (default 8; a case uses 2–3). Any `LlmError` (budget, refusal, truncation, invalid output, API error) falls back to the template drafter, which passes the verifier by construction. Other errors are bugs and propagate. `case.authoredBy` records which path ran, the model, the call count, whether the draft was repaired, and whether the stance was capped.
- **Configuration.** `ANTHROPIC_API_KEY` and `ALIBI_MODEL` are optional on the web server but must be set together; without them every case uses the template. The recommended model is `claude-opus-5-5`.
- **Review fixes (same day):**
  - **Reuse unchanged drafts.** A rebuild whose LLM input is unchanged (`authoredBy.inputHash`, a hash of the exact prompt data) reuses the stored draft and strategy with no LLM calls. Otherwise every webhook would re-draft, replace the text the merchant approved and lapse the approval.
  - **No temperature.** Current models reject sampling parameters, so there's no low temperature (CLAUDE §5 asks for one). This is the exception, recorded here: repeatability comes from reuse, and correctness from the checker.
  - **A stance needs a reason.** A stance that departs from the baseline needs at least one verified reason; otherwise the baseline is used and the removal is shown.
  - **Escaped prompt data.** `<` and `>` in record data are escaped, so a buyer can't close the `<case>` block.
  - **Read the reply in order.** The adapter checks refusal → truncation → JSON → zod itself (the SDK's `parse()` would hide truncation), and records the model that actually answered (`answeredBy`).
  - **Repair failure keeps the first draft.** A failed repair call keeps the first draft, and the checker removes its rejected claims.
  - **Bounded waits.** The rebuild queue runs up to 4 cases at once, and LLM calls are capped at 60 s × 2 attempts, so one slow case can't stall the others.
- **Poirot port.** Not started (SPEC §6.2: only after Poirot is submitted). `@alibi/casefile` keeps its in-repo engine behind `CaseEngine`.

## Hooks proof (2026-10-06)
- **pre-commit** (`pnpm typecheck`): staged `packages/core/src/zz-broken.ts` with `export const broken: number = "nope";` → commit refused, exit 1, `error TS2322: Type 'string' is not assignable to type 'number'`. File removed; nothing was committed.
- **pre-push** (`pnpm build:all`): on a throwaway branch, added `import "./missing.css";` to `apps/web/app/page.tsx` (passes `tsc`, fails `next build`) and pushed to a scratch bare remote → push refused, exit 1, `Module not found: Can't resolve './missing.css'`. The remote received 0 refs. Branch and remote deleted.

## Later
- Merchant login (session auth) for the dashboard, replacing the single operator token (ADR-023).
- `send-message` (on the cut list; the spec's request body only shows a file part, so the message text field needs verifying first).
- Rate limiting on the public webhook endpoint. Forged posts are already rejected before any DB write; with a non-PayPal cert URL they're also rejected before any PayPal call; and bodies over 512 KB are cut off while reading.
- Ideas that are out of scope go here.
