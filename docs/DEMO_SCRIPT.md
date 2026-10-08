# Demo script and sandbox runbook

## A. Sandbox setup (do once, early)

Synthetic merchant events (shipping, delivery, messages) are dated as **offsets from the real sandbox payment**, and events later than "now" stay hidden. So **pay first and open the disputes days later.** `seed:demo` warns if a dispute was opened before its story could have happened.

1. Create a sandbox REST app of type **Merchant**. Put `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `.env`, and set `DATABASE_URL` (e.g. `pglite://./.data/alibi`).
2. `pnpm probe:sandbox` → check the token, the scopes, and that disputes can be listed.
3. Log in to sandbox.paypal.com as the **personal** account and pay the **business** account, **by card**, these exact amounts (one payment per scenario):

   | Scenario | Amount | Story | Expected stance |
   |---|---|---|---|
   | `inr-delivered` | **84.00 USD** | UPS shows delivered +79 h | fight |
   | `inr-in-transit` | **46.00 USD** | USPS stalls in transit | fight with gaps |
   | `snad-color` | **58.00 USD** | FedEx delivered; colour complaint; listing says colour varies | fight |
   | `inr-no-tracking` | **35.00 USD** | posted without tracking | consider conceding |

4. **Wait at least 4 days**, then open the disputes from the personal account in the Resolution Center (item not received ×3, not as described ×1).
5. `pnpm probe:sandbox --dispute <id>` for one INR dispute. Check whether `provide-evidence` is already offered. If it isn't, and the status is `UNDER_REVIEW`, add `--require-evidence`.
6. `pnpm seed:demo --auto` (matches disputes to scenarios by exact amount), then `pnpm seed:demo --list`.

## B. The M2 gate: one real provide-evidence (kill criterion, by Oct 14)

Only the web app opens the database, so stop any other process using a PGlite `DATABASE_URL` first.

```bash
export ALIBI_OPERATOR_TOKEN=…             # both terminals: same value, ≥32 chars (openssl rand -hex 32)
DEMO_READONLY=false pnpm web:dev          # terminal 1
pnpm case build   <inr-delivered dispute> # terminal 2: fetch → gather → case file → verify
pnpm case show    <id>                    # read the exact payload
pnpm case approve <id>                    # type the dispute id to approve
pnpm case submit  <id>                    # gate re-checks PayPal, then one provide-evidence
pnpm probe:sandbox --dispute <id>         # record the post-submission status in SANDBOX_PROBE.md
```

If PayPal rejects the request format, the error and its `PayPal-Debug-Id` are in the activity log. Compare against OPEN_QUESTIONS G4: the multipart `input` part name and the file part name are the main unknowns.

## C. Video shot list (< 3 min)

1. 0:00 problem in one line
2. Buyer files item-not-received in sandbox
3. Webhook lands, activity feed runs
4. Case file + checklist
5. Compare panel
6. Merchant edits, verifier catches an invented detail
7. Approve → real submission
8. Sandbox settle → dashboard updates + Ask Alibi question
9. Close
