# SPEC.md — Alibi

> Every legitimate sale deserves an alibi.

Read `CLAUDE.md` first (rules, approval gate, evidence guard, verify-don't-guess, hooks). This document is what to build, how, and in what order.

---

## 1. Product

### 1.1 Problem
When a buyer opens a PayPal dispute, the merchant gets a deadline, a reason code, and a request for specific evidence. Small merchants lose cases they should win: they miss the deadline, send the wrong evidence type for the reason, or write a response that doesn't match what PayPal asked for. Enterprise chargeback tools (Chargebacks911, Justt, Chargeflow, Riskified) exist but target larger merchants and card-network chargebacks; the small PayPal merchant answers by hand in the Resolution Center.

### 1.2 Solution
Alibi is an agent that watches a merchant's PayPal disputes and, for each one, builds a **case file**: what PayPal is asking for, every relevant fact from PayPal and the merchant's records, which facts satisfy which requested evidence type, gaps, deadline, and a drafted response in which every claim is sourced. The merchant reviews, edits, approves — and Alibi submits through the PayPal Disputes API. An AG Studio dashboard shows the pipeline: money at risk, deadlines, outcomes, and an agent you can ask questions of.

### 1.3 Users
- **Primary:** small online merchants selling through PayPal (one person handling disputes alongside everything else).
- **Secondary:** ops staff at growing stores handling disputes in volume.

### 1.4 Why it needs PayPal + AI (the bar)
- **PayPal:** disputes, requested evidence, status, deadlines, transactions and the submission itself all live in PayPal. Without the Disputes API there's no product.
- **AI:** mapping messy merchant records (order notes, carrier events, buyer messages) to PayPal's requested evidence types and writing a persuasive, reason-specific response is judgment work a template can't do. The evidence guard makes that AI safe: it can argue, but it can't invent a fact. §5.6 makes this visible side by side.

### 1.5 Positioning vs Recourse (known competitor)
Same space; different bet. Recourse is deterministic with AI off and no hosted demo. Alibi leads with: grounded AI strategy + drafting with a visible verifier, a dispute **pipeline** dashboard (AG Studio + agent), and a polished hosted demo. Never mention Recourse in the submission; just be clearly better on the five criteria.

---

## 2. User flow

1. **Dashboard** (AG Studio): KPI tiles (open disputes, money at risk, due in 72 h, win rate on settled sandbox cases), a dispute grid (id, reason, amount, status, due, evidence requested, case readiness), charts by reason and by stage. An **Ask Alibi** agent panel: "Which disputes over $50 are due this week?" builds or filters widgets live.
2. **New dispute arrives** (webhook, or poll fallback). A live activity feed shows Alibi's steps: fetch details → read requested evidence → gather PayPal facts → gather merchant facts → build case file → strategy → draft → verify.
3. **Case page** (`/case/[disputeId]`):
   - **Header:** reason, amount, stage, status, deadline countdown, PayPal's requested evidence list.
   - **Case file:** evidence timeline (order placed → paid → shipped → carrier events → delivered → buyer messages), every fact tagged `PAYPAL` or `DEMO MERCHANT DATA`.
   - **Evidence checklist:** each requested evidence type → the facts that satisfy it, or a red gap ("No proof of delivery on file").
   - **Strategy:** fight / fight-with-gaps / consider conceding, with reasons tied to evidence. Advice only — Alibi never concedes or refunds on its own (§12).
   - **Draft response:** editable notes + attached evidence documents; every claim has an evidence chip; anything the verifier removed is listed in a "Removed by verifier" drawer.
   - **Review & submit:** confirmation dialog listing exactly what will be sent. Approval → server re-check (CLAUDE §1.1) → `provide-evidence` → status update.
4. **Compare** toggle on the case page: "Generic AI reply" vs "Alibi case file" (§5.6).
5. **Outcome:** after sandbox settlement, the case closes and the dashboard updates.

---

## 3. Architecture

```
PayPal Sandbox ──webhook──▶ /api/webhooks/paypal (verify signature, dedupe event id)
       ▲                              │
       │                              ▼
       │                      job: build case(disputeId)
       │                              │
       │   ┌──────────────────────────┴──────────────────────────┐
       │   │ @alibi/agent                                        │
       │   │  1. Fetch (paypal/read)   dispute details, requested │
       │   │                           evidence, transaction      │
       │   │  2. Gather (merchant)     order, fulfilment, messages│
       │   │  3. Case file (casefile + core, pure)                │
       │   │       facts → EvidenceRecords, timeline, checklist   │
       │   │  4. Strategist (LLM, JSON) fight/gaps/concede advice │
       │   │  5. Drafter   (LLM, JSON) notes + doc selection,     │
       │   │                           every claim cites evidence │
       │   │  6. Verifier  (core, pure + optional LLM)            │
       │   └──────────────────────────┬──────────────────────────┘
       │                              ▼
       │                      Postgres: case, evidence, draft, activity
       │                              │
       │                Next.js UI (dashboard, case page, SSE feed)
       │                              │ merchant approves
       │                              ▼
       └──── paypal/write ◀── /api/cases/[id]/submit
              (re-fetch, status + action + evidence-type checks, then provide-evidence)
```

---

## 4. Data model (`packages/core`)

```ts
type FactSource = "paypal" | "merchant_demo";

interface EvidenceRecord {
  id: string;                     // stable hash of (source, kind, ref, value)
  source: FactSource;
  kind: "transaction" | "order" | "fulfilment" | "carrier_event" | "buyer_message"
      | "seller_message" | "refund" | "policy" | "dispute_field";
  ref: string;                    // e.g. transaction id, order id, tracking number
  label: string;                  // human-readable
  value: string | number;         // the fact itself
  occurredAt?: string;            // ISO
  documentUrl?: string;           // internal URL of an attachable document, if any
  fetchedAt: string;
}

interface RequestedEvidence {
  evidenceType: string;           // VERIFY enum, e.g. PROOF_OF_FULFILLMENT, PROOF_OF_REFUND, OTHER
  source: string;                 // REQUESTED_FROM_SELLER is ours to answer
  dueAt?: string;
}

interface ChecklistItem {
  evidenceType: string;
  satisfiedBy: string[];          // EvidenceRecord ids
  gap?: string;                   // plain-language description if unsatisfied
}

interface DraftClaim {
  text: string;
  evidenceIds: string[];          // MUST be non-empty after verification
}

interface CaseFile {
  disputeId: string;
  reason: string;                 // VERIFY enum (e.g. MERCHANDISE_OR_SERVICE_NOT_RECEIVED)
  status: string;                 // VERIFY enum (e.g. WAITING_FOR_SELLER_RESPONSE)
  stage: string;                  // inquiry / chargeback / ... VERIFY
  amount: { value: string; currency: string };
  dueAt?: string;
  requested: RequestedEvidence[];
  timeline: string[];             // EvidenceRecord ids in time order
  checklist: ChecklistItem[];
  strategy: { stance: "fight" | "fight_with_gaps" | "consider_conceding"; reasons: DraftClaim[] };
  draft: {
    claims: DraftClaim[];
    notes: string;                // assembled from verified claims; VERIFY max length
    evidenceInfo?: { trackingInfo?: { carrier: string; number: string }[]; refundIds?: string[] };
    documents: string[];          // EvidenceRecord ids with documentUrl
  };
  evidence: Record<string, EvidenceRecord>;
  removedByVerifier: { text: string; reason: string }[];
  approval?: { approvedAt: string; draftHash: string };   // hash binds approval to exact content
  submission?: { submittedAt: string; paypalStatusAfter: string; requestId?: string };
  createdAt: string;
}
```

---

## 5. Algorithms

### 5.1 Ingest
- Webhook path: verify signature → dedupe on event id → enqueue `buildCase(disputeId)`. Event names VERIFY.
- Poll path (fallback and boot): `GET /v1/customer/disputes` every N minutes; enqueue any dispute whose `update_time` changed.
- Action-link normalisation: treat `provide-evidence` and `provide_evidence` (and similar) as the same action.

### 5.2 Reason → evidence map (pure, in `core`)
A table from dispute reason to accepted evidence types and the merchant fact kinds that can satisfy each. Built **only** from PayPal docs and observed sandbox responses; every row cites its source in a comment. PayPal's actual `REQUESTED_FROM_SELLER` list always wins over the table — the table is for ranking and gap detection, not for overriding PayPal.

### 5.3 Case file assembly
1. Convert every fetched fact into an `EvidenceRecord` (both sources).
2. Build the timeline by `occurredAt`.
3. Checklist: for each requested evidence type, find satisfying records via §5.2; if none, write a specific gap.
4. Deadline: `hoursLeft = dueAt − now`; warn under `ALIBI_DEADLINE_WARN_HOURS`.

Worked example (put in a code comment): reason = item not received; PayPal requests `PROOF_OF_FULFILLMENT`. Records: capture `$84.00` on Oct 2 (PAYPAL), order #1042 (DEMO), tracking `1Z…` with carrier event "Delivered, front door, Oct 6" (DEMO). Checklist: PROOF_OF_FULFILLMENT ← tracking + delivered event. Stance: fight. If the delivered event were missing, gap = "Tracking shows in transit; no delivery confirmation" and stance = fight_with_gaps.

### 5.4 Strategist + drafter contract
The LLM receives only: reason, stage, amount, requested evidence, the checklist, and `EvidenceRecord` labels/values with ids. It returns JSON: stance with reasons, claims (each with `evidenceIds` from the provided set), and which documents to attach. System prompt: factual, courteous, reason-specific; never invent facts, numbers, dates, carriers or quotes; never make claims about the buyer's character or intent beyond what the records show; say "no record" rather than guess.

### 5.5 Verifier (pure first)
1. Every `evidenceIds` entry exists.
2. Extract every amount, date, order id, tracking number, transaction id and quoted string from each claim (regex extractors in `core`); each must match a value in that claim's cited records (normalised: currency formats, date formats, whitespace). Mismatch → drop claim, record reason.
3. Every requested evidence type is either addressed or listed as a gap — never silently skipped.
4. Assembled `notes` within the PayPal limit (VERIFY); if over, trim lowest-priority claims, never truncate mid-claim.
5. Optional LLM check: "Does this claim follow from these records?" — drop on "no".
6. Draft hash computed; any edit by the merchant re-runs steps 1–4 and invalidates prior approval.

### 5.6 "Generic AI reply" comparison
Same dispute, same model, prompt with only reason + amount and no records. Render side by side with Alibi's draft. Highlight what the generic reply got wrong or vague (wrong evidence type, unsupported claims, no tracking). Label the left panel "Generic AI (no case file)". This is the visual answer to "why not just ask a chatbot?"

---

## 6. Adapters

### 6.1 `@alibi/paypal`
- **read:** `getToken()`, `listDisputes(params)`, `getDispute(id)`, `getTransaction/Capture(id)` (VERIFY best endpoint for linking dispute → capture), `verifyWebhook(headers, body)`.
- **write:** `provideEvidence(id, payload, files)`, `sendMessage(id, text)`. Exported only from `@alibi/paypal/write`.
- **sandbox-only test helpers** (scripts only, never the app path): `requireEvidence(id, action)`, `settleDispute(id, outcome)`, and `createDispute(...)` if the `DISPUTE_CREATE` scope is granted.
- Host guard: reject any base URL except sandbox unless `PAYPAL_TEST_MODE`.
- zod schema per response; unknown fields tolerated, required fields enforced. Retry with backoff on 429/5xx; never retry writes automatically.
- Every read converted into `EvidenceRecord`s before leaving the package.

### 6.2 `@alibi/casefile` (Poirot reuse)
Poirot (Open Agent entry, built Oct 15–20) contains the evidence/case-file engine. Open Agent forbids pre-existing work, so **no Alibi code flows into Poirot**, and nothing is ported until Poirot is submitted. Until then `@alibi/casefile` exposes the interface below with a minimal in-repo implementation; on Oct 31 swap in Poirot's engine behind the same interface and declare the reuse in README and Devpost.
```ts
interface CaseEngine {
  ingest(records: EvidenceRecord[]): void;
  timeline(): EvidenceRecord[];
  satisfy(requested: RequestedEvidence[], map: ReasonEvidenceMap): ChecklistItem[];
}
```
VERIFY before porting: Open Agent's IP/licence terms allow reusing the code elsewhere.

### 6.3 `@alibi/merchant`
- `MerchantStore` interface: `findOrderByTransaction(txId)`, `fulfilment(orderId)`, `messages(orderId)`, `policies()`.
- `DemoStore` implementation backed by Postgres seed data, every record flagged `merchant_demo`, linked to real sandbox transaction ids by `scripts/seed-demo.ts`.
- If PayPal Add Tracking works in sandbox, also push demo tracking to PayPal so proof-of-fulfilment has a `PAYPAL` source too (VERIFY).

### 6.4 Storage
- Tables: `cases`, `evidence_records`, `drafts`, `approvals`, `submissions`, `webhook_events (event_id unique)`, `activity`.
- LLM results cached per (dispute id, evidence-set hash) so reloads don't re-bill or change the draft.

---

## 7. UI and design (Design is 1 of 5 judging criteria)

- **Dashboard first:** AG Studio with custom widgets (deadline countdown tile, money-at-risk tile, case-readiness gauge), custom theme matching Alibi, layout tuned for a 1440 px screen and readable on mobile. Ask Alibi agent panel prominent.
- **Activity feed:** live agent steps with the PayPal calls made — makes the agent visible.
- **Case page:** evidence timeline as the hero; checklist beside it; draft below with evidence chips; verifier drawer.
- **Trust cues:** source tags on every fact, sandbox badge always visible, explicit "nothing is sent until you approve."
- **Compare toggle** prominent on the case page.
- Accessibility: keyboard navigable, sufficient contrast, no colour-only status.
- Empty/error states in plain language, never stack traces.

---

## 8. Testing

### 8.1 Unit (`core`)
- Reason → evidence map lookups and gap detection.
- Fact extractors (amounts in several currency formats, dates, tracking numbers, ids).
- Verifier: invented tracking number dropped; wrong amount dropped; correct claims kept; length limit trimming; edit invalidates approval.
- Deadline math incl. time zones; worked example.
- Action-name normalisation.

### 8.2 Adapters
- `paypal` against recorded sandbox fixtures (secrets stripped).
- Webhook verify: valid accepted, tampered rejected, duplicate event id ignored.
- Host guard: non-sandbox URL throws.
- One live smoke test behind an env flag (not in CI).

### 8.3 Agent
- Golden test: fixture case → drafter mocked with canned JSON containing one invented tracking number and one wrong amount → verifier drops both and records reasons.
- Strategist output validated; call budget enforced.

### 8.4 End-to-end (against `test-stub`)
- No approval → no PayPal write call (assert on stub).
- Approval → exactly one `provide-evidence` with the expected shape.
- Status changed between approval and submit → abort, no write.
- `DEMO_READONLY=true` → submit returns 409 with a clear message.
- Playwright on the deployed URL: dashboard loads → open case → evidence chips present → compare toggle works.

### 8.5 Pre-judging checklist
- [ ] `pnpm reset:demo` run on production; fresh disputes in `WAITING_FOR_SELLER_RESPONSE` plus settled history for the dashboard.
- [ ] Instance won't sleep through Dec 15; AG Studio licence valid through Dec 15.
- [ ] No console errors; no secrets in client bundle (grep build output).
- [ ] Every demo draft read manually for tone and accuracy.

---

## 9. Plan (Oct 6 → Nov 12, 2026, around the other entries)

Other commitments: ETH Lagos Oct 8–10, Open Agent Oct 15–20, Qloo Oct 21–30, Vultr Nov 3–8. Alibi work fits in the gaps.

| Window | Milestone | Done when |
|---|---|---|
| Oct 6–7 | **M0** scaffold, hooks, env; sandbox accounts + REST app; **gate probe** (auth, list, Resolution Center dispute, require-evidence) | `docs/SANDBOX_PROBE.md` shows a real dispute id in `WAITING_FOR_SELLER_RESPONSE`; request `DISPUTE_CREATE` scope |
| Oct 11–12 | **M1** `core`: evidence model, reason map, extractors, verifier, deadlines + tests | Unit tests green |
| Oct 13–14 | **M2** `paypal` read/write + webhook verify + test-stub; **one real provide-evidence success**; `merchant` DemoStore + seed | Adapter + e2e approval-gate tests green; submission captured in probe doc |
| Oct 15–30 | Paused (Open Agent, Qloo). Only: answer OPEN_QUESTIONS, ask AG Grid about licence expiry | — |
| Oct 31 | **M3** port Poirot engine into `casefile`; agent loop (fetch → gather → case → strategist → drafter → verifier) | Golden tests green; CLI builds a full CaseFile for a sandbox dispute |
| Nov 1–2 | **M4** web: case page, activity feed, approval flow, compare panel; deploy to Render; register webhook; **start AG Studio trial (Oct 31 + 45 days = Dec 15)** | Live URL shows real sandbox cases end to end |
| Nov 3–8 | Paused (Vultr). Only fixes | — |
| Nov 9–10 | **M5** AG Studio dashboard: custom widgets, theme, Ask Alibi agent | Dashboard live on production |
| Nov 11 | **M6** polish, Playwright, reset demo, record video (<3 min), README, Devpost text | Pre-judging checklist ticked |
| Nov 12 | Buffer → submit before 12:00pm PST (= 9:00pm WAT) | Submitted |

**Kill / pivot criteria:**
- By Oct 14: if no `provide-evidence` call succeeds in the sandbox → stop and report to the human before building further.
- If sandbox doesn't deliver dispute webhooks → poll only; say so in the README.
- If AG Studio's trial can't cover Dec 15 or the Studio Agent Framework won't integrate by Nov 10 → ship the dashboard with AG Grid/AG Charts and drop the AG Grid prize target; core product unaffected.
- If the Poirot port takes more than Oct 31 → keep the in-repo `casefile` implementation and drop the reuse claim.

**Cut order if behind:** optional LLM verifier step → Ask Alibi agent (keep custom widgets) → send-message action → compare panel animation. Never cut: approval gate, evidence guard, real sandbox submission in the video, live deployment.

---

## 10. Submission package

- **Demo URL** (Render production, read-only submit mode) + complete local run instructions for full submit mode.
- **Public repo** `alibi-disputes` with MIT `LICENSE` (visible in About), README: one-paragraph pitch; architecture diagram; "How Alibi uses PayPal" table (endpoint → what it powers → where in the UI); "How Alibi uses AI" (strategist, drafter, verifier, Ask Alibi); Poirot reuse declaration; setup; tests; known limits (sandbox only, demo merchant data, no auto-concede).
- **Video (<3 min) shot list** (`docs/DEMO_SCRIPT.md`): 0:00 problem in one line → buyer files item-not-received in sandbox → webhook lands, activity feed runs → case file + checklist → compare panel → merchant edits, verifier catches an invented detail → approve → real submission → sandbox settle → dashboard updates + Ask Alibi question → close.
- **Devpost description:** problem → what Alibi does → PayPal integration (endpoints used) → AI design (grounded strategy, evidence guard, human approval) → built with (tools list, how each is used) → what's next (real store integrations, more dispute reasons).
- Screenshots: dashboard, case page, checklist, verifier drawer, compare panel.

---

## 11. References to read first

- Hackathon page, rules, resources: https://paypalaihackathon.devpost.com/ · /rules · /resources
- AG Grid sponsor page: https://paypalaihackathon.devpost.com/details/aggrid · boilerplate: https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate
- Disputes API reference: https://developer.paypal.com/api/customer-disputes/v1
- Disputes set-up (sandbox accounts, buyer consent, scopes): https://developer.paypal.com/disputes/set-up
- Disputes integration guide: https://developer.paypal.com/docs/multiparty/disputes-chargebacks/integrate-disputes/
- Test and go live (sandbox simulation, settle): https://developer.paypal.com/disputes/test-go-live
- AG Studio docs: https://www.ag-grid.com/studio/react/quick-start/ · /custom-widgets/ · /ai-agents/

---

## 12. Out of scope

Live PayPal mode · auto-submitting without approval · accepting claims, refunds or offers (strategy may *suggest* conceding; the merchant does it in PayPal) · card-network chargebacks outside PayPal · real store integrations (Shopify etc.; interface only) · user accounts beyond a single demo merchant · buyer profiling or fraud scoring of the buyer as a person · mobile app · paid tiers.
