# Deploying the public demo (Render)

Nothing here runs automatically: each step is done by a person with access to the Render and PayPal accounts.

## 1. Create the Blueprint
Render dashboard → **New → Blueprint** → pick the `alibi-disputes` repo. Render reads `render.yaml` and creates:
- `alibi-db`: Postgres on a paid plan;
- `alibi`: a Node web service on a paid plan (it must not sleep: PayPal webhooks and judges hitting a cold start);
- a generated `ALIBI_OPERATOR_TOKEN`.

At creation Render prompts for the `sync: false` secrets: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `ANTHROPIC_API_KEY`. Leave `PAYPAL_WEBHOOK_ID` empty for now: webhooks are refused until it's set, and the poller covers the gap.

## 2. Check it's up
`https://<service>.onrender.com/api/health` → `{"ok":true,"readonly":true,"llm":true}`.

## 3. Seed the demo data
Link the demo merchant scenarios to the real sandbox disputes (docs/DEMO_SCRIPT.md). This runs in a Render shell against the production database, with the service's env:
```
pnpm seed:demo --auto
pnpm seed:demo --list
```

## 4. Register the webhook
developer.paypal.com → the sandbox REST app → **Webhooks → Add webhook**:
- URL: `https://<service>.onrender.com/api/webhooks/paypal`;
- events: `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED`.

Copy the webhook id into the service's `PAYPAL_WEBHOOK_ID` and redeploy. Check: open a dispute in the sandbox and watch `webhook` then `queued` appear in the activity log. If none arrives within a few minutes, the poller still picks the dispute up within `ALIBI_POLL_MINUTES`; note it in OPEN_QUESTIONS G8.

## 5. Before judging opens
- `pnpm reset:demo` (docs/DEMO_SCRIPT.md), then confirm the dashboard shows fresh disputes in `WAITING_FOR_SELLER_RESPONSE` plus settled history.
- `DEMO_READONLY` stays `true` on the public service. The recorded video shows a real approved submission made from a writable local or operator instance.
- The AG Studio licence must cover Dec 15 (CLAUDE §3).

## Notes
- Production uses Postgres (`DATABASE_URL` from `alibi-db`), never PGlite: container disks are ephemeral.
- Migrations run on startup (`repo.migrate()`); they're idempotent and guarded.
