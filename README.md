# Alibi

> Every legitimate sale deserves an alibi.

Alibi is an AI agent that defends online merchants against PayPal disputes. It reads the dispute and works out which evidence PayPal is asking for. It builds a case file from PayPal data and the merchant's records, then drafts a response in which every claim cites its evidence. After the merchant approves, it submits the response through the PayPal Disputes API.

**Status:** milestone M2. The full pipeline (case build, evidence check, approval gate, PayPal submission) runs end to end against a local PayPal stub, and is waiting on the first real sandbox submission. The web UI comes in M4. **Sandbox only.** There is no live mode.

## Setup

```bash
pnpm install          # also installs git hooks (pre-commit: typecheck, pre-push: build)
cp .env.example .env  # sandbox credentials; DATABASE_URL=pglite://./.data/alibi works without Postgres
pnpm probe:sandbox    # checks auth and dispute access, writes docs/SANDBOX_PROBE.md
pnpm test             # unit + e2e (e2e runs against test-stub with an in-memory Postgres)
pnpm web:dev
```

Sandbox setup and the first real submission: see `docs/DEMO_SCRIPT.md`.

### Try it without PayPal credentials

```bash
STUB_PORT=4010 pnpm --filter @alibi/test-stub start     # local PayPal stub with demo disputes
export PAYPAL_CLIENT_ID=stub PAYPAL_CLIENT_SECRET=stub PAYPAL_TEST_MODE=true \
       PAYPAL_API_BASE=http://127.0.0.1:4010 DATABASE_URL=pglite://./.data/stub
pnpm seed:demo --link inr-delivered=PP-D-STUB-1
export ALIBI_OPERATOR_TOKEN=$(openssl rand -hex 32)      # approve/submit/build need it when submissions are on
export ANTHROPIC_API_KEY=… ALIBI_MODEL=claude-opus-5-5   # optional: Claude strategist + drafter (template drafter without)
DEMO_READONLY=false pnpm web:dev                         # other terminal, same env
pnpm case build PP-D-STUB-1 && pnpm case approve PP-D-STUB-1 && pnpm case submit PP-D-STUB-1
```

## Layout

| Package | Role |
|---|---|
| `packages/core` | Pure domain logic: evidence model, reason→evidence map, checklist, deadlines, extractors, verifier, payload builder (`@alibi/core/server` for hashing) |
| `packages/paypal` | PayPal client: `./read` (agent-safe), `./write` (server routes only), `./sandbox` (scripts only) |
| `packages/casefile` | Case-file engine: assembly, timeline, checklist, template drafter |
| `packages/merchant` | Merchant data adapter: synthetic demo scenarios linked to real sandbox transactions, demo PDFs |
| `packages/agent` | Fetch → gather → case file → draft → verify (LLM strategist/drafter in M3) |
| `packages/store` | Postgres repository (pg in production, PGlite in tests/local) |
| `apps/web` | Next.js app: approval gate, webhook receiver, case API (UI and AG Studio dashboard in M4/M5) |
| `test-stub` | Local PayPal stub for e2e tests and credential-free demos |

See `SPEC.md` for the product spec and `CLAUDE.md` for the engineering rules.

## License

MIT
