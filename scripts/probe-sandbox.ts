// Gate probe (CLAUDE §3, SPEC §9 M0). Talks to the PayPal sandbox and writes
// docs/SANDBOX_PROBE.md plus redacted fixtures under fixtures/paypal/.
//
//   pnpm probe:sandbox                         # read-only: token, list, detail
//   pnpm probe:sandbox --dispute PP-D-123      # probe a specific dispute
//   pnpm probe:sandbox --dispute PP-D-123 --require-evidence
//        # sandbox-only simulation: UNDER_REVIEW → WAITING_FOR_SELLER_RESPONSE
//
// Never prints or writes secrets or access tokens.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasAction, normaliseAction, parseEnv, paypalEnvSchema } from "@alibi/core";
import { createPaypalReader, PaypalError, type DisputeDetail } from "@alibi/paypal/read";
import { createSandboxHelpers } from "@alibi/paypal/sandbox";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const DISPUTE_SCOPES = [
  "https://uri.paypal.com/services/disputes/read-seller",
  "https://uri.paypal.com/services/disputes/update-seller",
];

interface Step {
  name: string;
  ok: boolean;
  detail: string[];
}
const steps: Step[] = [];
const record = (name: string, ok: boolean, ...detail: string[]) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}`);
  for (const d of detail) console.log(`    ${d}`);
};

function describeError(e: unknown): string {
  if (e instanceof PaypalError) return `${e.message}${e.debugId ? ` (PayPal-Debug-Id ${e.debugId})` : ""}`;
  return e instanceof Error ? e.message : String(e);
}

// Fixtures are committed: strip personal data even though sandbox data is fake.
const PII_KEY = /(email|phone|address|postal_code|given_name|surname|full_name|payer_id|account_id)/i;
function redact(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v, parentKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        const personName = k === "name" && /^(buyer|seller|merchant|payer|payee)$/i.test(parentKey);
        if ((PII_KEY.test(k) || personName) && (typeof v === "string" || typeof v === "number")) return [k, "<redacted>"];
        return [k, redact(v, k)];
      }),
    );
  }
  return value;
}

function writeFixture(name: string, body: unknown) {
  const path = join(root, "fixtures/paypal", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(redact(body), null, 2) + "\n");
  return `fixtures/paypal/${name}`;
}

function summariseDetail(d: DisputeDetail): string[] {
  const rels = (d.links ?? []).map((l) => l.rel);
  const requested = (d.evidences ?? []).filter((e) => e.source === "REQUESTED_FROM_SELLER");
  return [
    `dispute_id: ${d.dispute_id}`,
    `status: ${d.status}`,
    `stage: ${d.dispute_life_cycle_stage ?? "—"}`,
    `reason: ${d.reason}`,
    `amount: ${d.dispute_amount ? `${d.dispute_amount.value} ${d.dispute_amount.currency_code}` : "—"}`,
    `seller_response_due_date: ${d.seller_response_due_date ?? "—"}`,
    `link rels (raw): ${rels.join(", ") || "—"}`,
    `link rels (normalised): ${rels.map(normaliseAction).join(", ") || "—"}`,
    `evidence requested from seller: ${requested.map((e) => e.evidence_type ?? "?").join(", ") || "— (none listed)"}`,
    `seller transaction ids: ${(d.disputed_transactions ?? []).map((t) => t.seller_transaction_id ?? "?").join(", ") || "—"}`,
  ];
}

async function main() {
  let env;
  try {
    env = parseEnv(paypalEnvSchema, process.env);
  } catch (e) {
    console.error(describeError(e));
    console.error("\nSet PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env (sandbox REST app, type Merchant).");
    process.exitCode = 1;
    return;
  }

  const reader = createPaypalReader(env);
  const startedAt = new Date().toISOString();

  // 1. OAuth
  try {
    const scope = (await reader.getToken()) ?? "";
    const granted = scope.split(/\s+/).filter(Boolean);
    const missing = DISPUTE_SCOPES.filter((s) => !granted.includes(s));
    const disputeScopes = granted.filter((s) => s.includes("/disputes/"));
    record(
      "OAuth token (client credentials)",
      true,
      `granted dispute scopes: ${disputeScopes.join(", ") || "none"}`,
      missing.length ? `MISSING expected scopes: ${missing.join(", ")}` : "all expected seller dispute scopes present",
    );
  } catch (e) {
    record("OAuth token (client credentials)", false, describeError(e));
    return finish(startedAt);
  }

  // 2. List
  let disputeId = option("--dispute");
  try {
    const { data, raw } = await reader.listDisputes({ page_size: 50 });
    const fixture = writeFixture("disputes.list.json", raw.body);
    const byStatus = new Map<string, number>();
    for (const d of data.items) byStatus.set(d.status, (byStatus.get(d.status) ?? 0) + 1);
    record(
      "GET /v1/customer/disputes",
      raw.status === 200,
      `HTTP ${raw.status}, ${data.items.length} dispute(s)`,
      `by status: ${[...byStatus].map(([s, n]) => `${s}=${n}`).join(", ") || "—"}`,
      ...data.items.slice(0, 10).map((d) => `${d.dispute_id}  ${d.status}  ${d.reason ?? "—"}  ${d.dispute_amount?.value ?? ""} ${d.dispute_amount?.currency_code ?? ""}`),
      `fixture: ${fixture}`,
    );
    disputeId ??= data.items[0]?.dispute_id;
  } catch (e) {
    record("GET /v1/customer/disputes", false, describeError(e));
    return finish(startedAt);
  }

  if (!disputeId) {
    record(
      "Dispute detail",
      false,
      "No disputes on this business account yet.",
      "Create one: log in to sandbox.paypal.com as the PERSONAL account, pay the business account (use a card),",
      "then open a dispute in the Resolution Center. Re-run this probe.",
    );
    return finish(startedAt);
  }

  // 3. Detail
  let detail: DisputeDetail;
  try {
    const res = await reader.getDispute(disputeId);
    detail = res.data;
    record(`GET /v1/customer/disputes/${disputeId}`, true, ...summariseDetail(detail), `fixture: ${writeFixture(`dispute.${disputeId}.json`, res.raw.body)}`);
  } catch (e) {
    record(`GET /v1/customer/disputes/${disputeId}`, false, describeError(e));
    return finish(startedAt);
  }

  // 4. require-evidence (sandbox simulation; opt-in)
  if (flag("--require-evidence")) {
    if (detail.status === "WAITING_FOR_SELLER_RESPONSE") {
      record("require-evidence", true, "Already WAITING_FOR_SELLER_RESPONSE — nothing to do.");
    } else if (!hasAction(detail.links, "require-evidence")) {
      record(
        "require-evidence",
        false,
        `status is ${detail.status}; no require-evidence link offered.`,
        "PayPal documents this needs status UNDER_REVIEW (escalate the dispute to a claim from the personal account first).",
      );
    } else {
      try {
        const sandbox = createSandboxHelpers(env);
        const res = await sandbox.requireEvidence(disputeId, "SELLER_EVIDENCE");
        writeFixture(`require-evidence.${disputeId}.json`, res.raw.body);
        const after = await reader.getDispute(disputeId);
        writeFixture(`dispute.${disputeId}.after-require-evidence.json`, after.raw.body);
        record(
          "POST require-evidence (SELLER_EVIDENCE)",
          after.data.status === "WAITING_FOR_SELLER_RESPONSE",
          `HTTP ${res.raw.status}`,
          ...summariseDetail(after.data),
        );
      } catch (e) {
        record("POST require-evidence (SELLER_EVIDENCE)", false, describeError(e));
      }
    }
  }

  return finish(startedAt);
}

function finish(startedAt: string) {
  const lines = [
    "# Sandbox probe results",
    "",
    "Written by `pnpm probe:sandbox` (scripts/probe-sandbox.ts). No secrets or tokens are recorded here.",
    "Fixtures under `fixtures/paypal/` are redacted copies of the raw responses.",
    "",
    `- Run at: ${startedAt}`,
    `- Base URL: https://api-m.sandbox.paypal.com`,
    `- Args: \`${args.join(" ") || "(none)"}\``,
    "",
    ...steps.flatMap((s) => [`## ${s.ok ? "✔" : "✘"} ${s.name}`, "", ...s.detail.map((d) => `- ${d}`), ""]),
  ];
  writeFileSync(join(root, "docs/SANDBOX_PROBE.md"), lines.join("\n"));
  console.log("\nWrote docs/SANDBOX_PROBE.md");
  if (steps.some((s) => !s.ok)) process.exitCode = 1;
}

await main();
