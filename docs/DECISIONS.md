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

## Hooks proof (2026-10-06)
- **pre-commit** (`pnpm typecheck`): staged `packages/core/src/zz-broken.ts` with `export const broken: number = "nope";` → commit refused, exit 1, `error TS2322: Type 'string' is not assignable to type 'number'`. File removed; nothing was committed.
- **pre-push** (`pnpm build:all`): on a throwaway branch, added `import "./missing.css";` to `apps/web/app/page.tsx` (passes `tsc`, fails `next build`) and pushed to a scratch bare remote → push refused, exit 1, `Module not found: Can't resolve './missing.css'`. The remote received 0 refs. Branch and remote deleted.

## Later
- Ideas that are out of scope go here.
