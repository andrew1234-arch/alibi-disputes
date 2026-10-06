# CLAUDE.md — Alibi

You are building **Alibi**: an AI agent that defends online merchants against PayPal disputes. When a buyer files a dispute, Alibi reads it, works out what evidence PayPal is asking for, gathers that evidence from PayPal and the merchant's own records, builds a case file, drafts the response, and — after the merchant approves — submits it through the PayPal Disputes API. An AG Studio dashboard shows the whole dispute pipeline. Read `SPEC.md` before writing any code. This file is the rules; `SPEC.md` is the product, architecture and plan.

**Competition:** PayPal AI Hackathon — "Build What's Next with PayPal and AI" (Devpost). Deadline **Nov 12, 2026, 12:00pm PST** (Devpost page; one third-party listing says 2:00pm PT — use the earlier time). Prizes: $12,000 / $8,000 / $5,000; $5,000 each for Most Creative, Most Impactful, Best Demo Delivery, Best Use of PayPal + AI, Best Use of Agentic Commerce; AG Grid $5,000 / $2,000 / 3× $1,000; Render credits. Judges score, unweighted: **Technological Implementation, Design, Potential Impact, Innovation/Idea, Presentation**. Every decision in this repo serves those five criteria.

**Known competitor:** *Recourse* (github.com/miko-keng/Resource) builds the same core idea. As of Oct 6 its AI is switched off (deterministic engine only), it has no hosted demo, and it uses no AG Studio. Alibi wins on: AI that genuinely reasons over evidence (with a guard that proves it doesn't invent facts), a working hosted demo, and the AG Studio dispute dashboard with an agent. Don't copy its code; it's a reference for pitfalls only.

---

## 1. Non-negotiable rules

1. **The merchant approves every PayPal write.** No call that changes dispute state (`provide-evidence`, `send-message`, anything else) runs without an explicit, per-action approval stored with the case. Immediately before submitting, the server re-fetches the dispute and checks: status is `WAITING_FOR_SELLER_RESPONSE`, the returned HATEOAS links still offer the action, and the evidence types match what PayPal requested. Any mismatch → abort, show why. The LLM never holds PayPal credentials and has no path to the write adapter.
2. **Evidence guard is mandatory.** Every factual claim in a drafted response (amount, date, order id, tracking number, carrier, item name, message quote) must trace to a stored `EvidenceRecord`. A pure verifier checks every number, date and identifier in the draft against the evidence map before the merchant sees it. Unsupported claims are removed, not softened. This is the core of "AI that's safe to let near a dispute."
3. **No fabricated data presented as real.** PayPal-sourced facts are labelled `PAYPAL`. Demo merchant records (orders, fulfilment, customer messages) are synthetic, labelled `DEMO MERCHANT DATA` in the UI, and linked to real sandbox transactions by transaction id. Synthetic records are never described as PayPal evidence. If data is missing, show "—" and the reason.
4. **Sandbox only.** The PayPal adapter refuses any base URL other than `https://api-m.sandbox.paypal.com` unless `PAYPAL_TEST_MODE=true` points it at the local test stub. There is no live mode in this repo.
5. **Do not guess the PayPal API.** Endpoint paths, request bodies (especially `provide-evidence` multipart format and file limits), evidence type enums, status values, webhook event names, note length limits and auth scopes must come from developer.paypal.com / docs.paypal.ai or real sandbox responses. Anything unconfirmed gets a `// VERIFY:` comment, a typed stub, and an entry in `docs/OPEN_QUESTIONS.md`. Third-party repos (including Recourse) are hints, not sources of truth.
6. **Validate every external response with zod.** PayPal, LLM JSON, AG Studio agent payloads. A response that fails validation is an error state, not a partial render.
7. **Secrets only from env.** `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `ANTHROPIC_API_KEY`, AG Studio licence key. Never logged, never sent to the browser, never committed. All PayPal and LLM calls happen server-side.
8. **Pure core, impure edges.** Evidence model, evidence-type mapping per dispute reason, deadline math, draft verifier, fact extraction and case-file assembly live in `packages/core` as pure functions with unit tests. Network code lives in adapters.
9. **Webhooks are verified and idempotent.** Verify every PayPal webhook via `/v1/notifications/verify-webhook-signature` against `PAYPAL_WEBHOOK_ID`; refuse unverified events. Record event ids so PayPal retries never double-process. Polling is the fallback, not a replacement.
10. **The hosted demo must work for a stranger with no setup.** Judges must be able to run or interact with a working build. Public demo runs in read-only submit mode (`DEMO_READONLY=true`) so visitors can't burn the demo disputes; the video shows the real approved submission. If it isn't deployed and working, it doesn't exist.

---

## 2. Hackathon facts you can rely on (verified from the official Devpost page, Oct 6)

- Build or update an app that integrates the PayPal developer platform (free sandbox) plus an AI tool/model of your choice. Must meaningfully integrate at least one PayPal technology and meaningfully incorporate AI.
- New or existing projects allowed, as long as meaningful progress happens during the hackathon (Oct 1 – Nov 12). Reuse of Poirot's engine must be declared in the description.
- Submission: text description of features; **functional demo** (hosted URL or complete run instructions — mockups don't count); list of tools and how each is used; **public GitHub repo** with all source, assets and instructions, open source with a **license visible in the About section**; **demo video under 3 minutes** on public YouTube, showing the project working on its target device, with no unlicensed third-party trademarks or music.
- Judging runs Nov 13 – Dec 15; winners around Dec 21. The hosted demo must stay up through Dec 15.
- Eligibility: above age of majority; all countries except standard exceptions (Nigeria is eligible).
- AG Grid prize = **AG Studio** specifically. Judges want polish (custom widgets, theming, layout) and use of the **Studio Agent Framework**. Free 45-day trial licence; official boilerplate at `paypaldev/hackathon-paypal-ag-grid-boilerplate`.

---

## 3. Things to verify first (gate before building features)

Record answers with source links in `docs/OPEN_QUESTIONS.md`.

- [ ] Sandbox REST app (type Merchant) gets an OAuth token and `GET /v1/customer/disputes` returns 200.
- [ ] A dispute created from the sandbox **personal** account in the Resolution Center appears via the API on the **business** app. Record the id.
- [ ] `require-evidence` (sandbox-only) moves it to `WAITING_FOR_SELLER_RESPONSE`.
- [ ] Exact `provide-evidence` request format: multipart parts, `evidence_type` enum, `evidence_info` (`tracking_info`, `refund_ids`), `notes` max length, file types/sizes.
- [ ] One `provide-evidence` call succeeds and the post-submission status is captured.
- [ ] Sandbox settle endpoint closes a dispute in the merchant's favour (for the demo's ending and dashboard outcomes).
- [ ] Action link names as actually returned (Recourse reports underscores `provide_evidence` vs documented hyphens) — normalise both.
- [ ] Webhook event names for dispute created/updated/resolved, and whether sandbox delivers them.
- [ ] API dispute creation (`DISPUTE_CREATE` scope + buyer consent + `PayPal-Auth-Assertion`) — nice-to-have only; request early, don't depend on it.
- [ ] PayPal Add Tracking API availability in sandbox (strengthens proof-of-fulfilment).
- [ ] AG Studio: trial licence behaviour on expiry (watermark? breaks?) — the demo must work through Dec 15. Ask the AG Grid team on the PayPal Discord.

**Go/no-go:** see SPEC §9 kill criteria. Do not build UI until one evidence submission has succeeded in the sandbox.

---

## 4. Repo layout (pnpm monorepo, repo name `alibi-disputes`)

```
alibi-disputes/
├─ CLAUDE.md
├─ SPEC.md
├─ LICENSE                      # MIT, visible in GitHub About
├─ README.md
├─ docs/
│  ├─ OPEN_QUESTIONS.md         # every VERIFY item with answer + source
│  ├─ DECISIONS.md              # short ADRs
│  ├─ SANDBOX_PROBE.md          # gate results: ids, statuses, raw request/response shapes (no secrets)
│  └─ DEMO_SCRIPT.md            # the scripted demo dispute(s), video shot list
├─ packages/
│  ├─ core/                     # PURE: evidence model, reason→evidence map, deadlines, verifier, case file
│  ├─ paypal/                   # PayPal client: OAuth, disputes read/write, transactions, webhooks verify, zod
│  ├─ casefile/                 # evidence/case-file engine (ported from Poirot after Oct 20; see SPEC §6.2)
│  ├─ agent/                    # planner + tools + strategist + drafter + verifier loop
│  └─ merchant/                 # merchant data adapter (demo store now; interface for real stores later)
├─ apps/
│  └─ web/                      # Next.js (App Router) UI, AG Studio dashboard, API routes, webhook receiver
├─ scripts/
│  ├─ probe-sandbox.ts          # gate: auth, list, detail, require-evidence, writes docs/SANDBOX_PROBE.md
│  ├─ seed-demo.ts              # links demo merchant records to real sandbox transaction ids
│  └─ reset-demo.ts             # prepares fresh disputes before recording / judging
├─ fixtures/paypal/             # recorded real sandbox responses (secrets stripped)
└─ test-stub/                   # local PayPal stub server for e2e tests
```

### 4.1 Monorepo wiring
- `pnpm-workspace.yaml` lists `packages/*` and `apps/*`. Scoped names `@alibi/core`, `@alibi/paypal`, `@alibi/casefile`, `@alibi/agent`, `@alibi/merchant`, `@alibi/web` (private; never published).
- Internal deps via `"workspace:*"`. Never import across packages by relative path.
- `tsconfig.base.json` (strict, ES2022, `moduleResolution: "bundler"`, `incremental: true`), project references so `pnpm -r build` builds in order.
- Dependency direction: `core` imports nothing internal. `paypal`, `merchant`, `casefile` may import `core`. `agent` may import `core`, `casefile`, `merchant` and the **read-only** surface of `paypal` (`@alibi/paypal/read`). Only `apps/web` server routes import `@alibi/paypal/write`. Packages never import from apps.
- `apps/web` lists internal packages in `transpilePackages`.
- One `.env.example` at root documenting every variable in §7.

### 4.2 Git hooks (mandatory, set up first)
- husky at root (`"prepare": "husky"`).
- **pre-commit → `pnpm typecheck`** (`pnpm -r --if-present typecheck`, each package `tsc --noEmit`). Any type error blocks the commit.
- **pre-push → `pnpm build:all`** (`pnpm -r build`, including `next build`). Any failure blocks the push.
- Never bypass (`--no-verify`, editing hooks, commenting out code). Fix the cause or stop and tell the human.
- Prove both hooks block a deliberate failure; log it in `docs/DECISIONS.md`.

---

## 5. Stack

- **TypeScript strict** everywhere. **pnpm**, **vitest**, **zod**, **Playwright**.
- **Next.js (App Router)**. API routes / server actions hold all secrets; webhook receiver at `/api/webhooks/paypal`.
- **Hosting:** Render (sponsor; eligible for Render prizes; stable public URL for webhook registration). Use a paid/credit-backed instance through judging — free instances sleep, and a cold start can outlast PayPal's webhook timeout. Record the choice in `DECISIONS.md`.
- **Storage:** Postgres (Render) for cases, evidence, approvals, webhook event ids, activity log. Not local JSON — container disks are ephemeral.
- **LLM:** Anthropic API via the official SDK, model from env (`ALIBI_MODEL`). Structured JSON output validated by zod. Low temperature for strategy and verification.
- **Agent:** a small explicit loop written in-repo (planner → tools → strategist → drafter → verifier) so judges can read every PayPal call. No heavyweight framework unless it clearly saves time; if used, record why.
- **Dashboard:** **AG Studio** (React) with custom widgets + theming, and the **Studio Agent Framework** wired to a custom Alibi agent. Start from the official boilerplate.
- **UI:** Tailwind + a small component set. Calm, trustworthy palette (this handles money). Mobile-responsive.

---

## 6. Working style

- Work milestone by milestone (SPEC §9). Each milestone: tests pass, `pnpm typecheck` + `pnpm build:all` pass, commit, then a 5-line summary: works / tested / stubbed / open questions / next.
- Conventional commits: `feat(core): evidence types by dispute reason`, `test(agent): verifier strips unsourced tracking number`.
- Comment non-obvious logic with a worked example (verifier matching and deadline math especially).
- When unsure, stop and ask. Especially about anything that writes to PayPal, handles buyer data, or the API shape.
- No scope creep. Out-of-scope list is in SPEC §12. Ideas go to `DECISIONS.md` under "Later".

---

## 7. Environment variables (validated with zod at startup)

```
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com   # adapter rejects anything else unless PAYPAL_TEST_MODE
PAYPAL_WEBHOOK_ID=
PAYPAL_TEST_MODE=false          # true only in e2e tests (points at test-stub)
ANTHROPIC_API_KEY=
ALIBI_MODEL=                    # Anthropic model id, e.g. a current Sonnet model
AG_STUDIO_LICENSE_KEY=
DATABASE_URL=
DEMO_READONLY=true              # public deployment: submission disabled with a clear message
ALIBI_MAX_LLM_CALLS_PER_CASE=8
ALIBI_DEADLINE_WARN_HOURS=72
```

---

## 8. Commands (keep working)

```
pnpm install                  # installs husky hooks
pnpm typecheck                # pre-commit
pnpm build:all                # pre-push
pnpm -r test
pnpm test:e2e                 # boots web against test-stub
pnpm probe:sandbox            # gate; writes docs/SANDBOX_PROBE.md
pnpm seed:demo
pnpm reset:demo               # before recording and before judging opens
pnpm web:dev
```

---

## 9. Definition of done

- Live URL works for a stranger: dashboard loads with real sandbox disputes; opening a case shows the case file, strategy and verified draft with evidence chips; submit is disabled with an explanation in read-only mode.
- One real approved `provide-evidence` submission captured end to end in the video, followed by sandbox settlement and the dashboard updating.
- Evidence-guard, approval-gate and webhook-idempotency tests pass.
- Public repo, MIT LICENSE visible in About, README with setup, architecture, "How Alibi uses PayPal" table, Poirot reuse declaration, screenshots.
- Video under 3 minutes on public YouTube; Devpost text written (SPEC §10).
