# Alibi

> Every legitimate sale deserves an alibi.

Alibi is an AI agent that defends online merchants against PayPal disputes. It reads the dispute and works out which evidence PayPal is asking for. It builds a case file from PayPal data and the merchant's records, then drafts a response in which every claim cites its evidence. After the merchant approves, it submits the response through the PayPal Disputes API.

**Status:** early development (milestone M0). **Sandbox only.** There is no live mode.

## Setup

```bash
pnpm install          # also installs git hooks (pre-commit: typecheck, pre-push: build)
cp .env.example .env  # fill in sandbox credentials
pnpm probe:sandbox    # checks auth and dispute access, writes docs/SANDBOX_PROBE.md
pnpm test
pnpm web:dev
```

## Layout

| Package | Role |
|---|---|
| `packages/core` | Pure domain logic: evidence model, PayPal enums, env validation, action-link normalisation |
| `packages/paypal` | PayPal client: `./read` (agent-safe), `./write` (server routes only), `./sandbox` (scripts only) |
| `packages/casefile` | Case-file engine |
| `packages/merchant` | Merchant data adapter (demo store) |
| `packages/agent` | Planner → tools → strategist → drafter → verifier |
| `apps/web` | Next.js app, AG Studio dashboard, webhook receiver |

See `SPEC.md` for the product spec and `CLAUDE.md` for the engineering rules.

## License

MIT
