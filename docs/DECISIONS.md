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

## Hooks proof (2026-10-06)
- **pre-commit** (`pnpm typecheck`): staged `packages/core/src/zz-broken.ts` with `export const broken: number = "nope";` → commit refused, exit 1, `error TS2322: Type 'string' is not assignable to type 'number'`. File removed; nothing was committed.
- **pre-push** (`pnpm build:all`): on a throwaway branch, added `import "./missing.css";` to `apps/web/app/page.tsx` (passes `tsc`, fails `next build`) and pushed to a scratch bare remote → push refused, exit 1, `Module not found: Can't resolve './missing.css'`. The remote received 0 refs. Branch and remote deleted.

## Later
- Ideas that are out of scope go here.
