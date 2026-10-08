// Operator CLI for one dispute's case file. It is a pure client of the web app's
// API (ALIBI_WEB_URL, default http://localhost:3000), so:
//   - the approval gate and its re-checks are the same code the UI uses
//     (CLAUDE §1.1: only web server routes may import the PayPal write surface);
//   - only the web process opens the database, which PGlite requires.
//
//   pnpm case build   <disputeId>   fetch from PayPal, gather, assemble, verify, store
//   pnpm case show    <disputeId>   checklist, draft, removed claims, and the exact payload
//   pnpm case approve <disputeId>   show the payload, type the dispute id to approve it
//   pnpm case submit  <disputeId>   submit through the approval gate
//   pnpm case reconcile <disputeId> received|not-received
//                                   resolve an unconfirmed submission after checking PayPal
//
// Start the app with DEMO_READONLY=false for build/approve/submit, and set the
// same ALIBI_OPERATOR_TOKEN here: those routes require it as a bearer token.

import { createInterface } from "node:readline/promises";
import { deadlineState, type CaseFile, type PaypalEvidence } from "@alibi/core";

const [command, disputeId] = process.argv.slice(2);
const web = (process.env.ALIBI_WEB_URL ?? "http://localhost:3000").replace(/\/$/, "");

interface CaseView {
  caseFile: CaseFile;
  draftHash: string;
  approvalValid: boolean;
  payload: { evidences: PaypalEvidence[]; files: { id: string; label?: string; url?: string }[]; unanswered: string[] };
}

if (!command || !disputeId || !["build", "show", "approve", "submit", "reconcile"].includes(command)) {
  console.error("Usage: pnpm case <build|show|approve|submit> <disputeId>\n       pnpm case reconcile <disputeId> <received|not-received>");
  process.exit(1);
}
const base = `/api/cases/${encodeURIComponent(disputeId)}`;

if (command === "build") {
  const v = await call<CaseView>("POST", `${base}/build`);
  if (v) show(v);
} else if (command === "show") {
  const v = await call<CaseView>("GET", base);
  if (v) show(v);
} else if (command === "approve") {
  const v = await call<CaseView>("GET", base);
  if (v) {
    show(v);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl.question("\nThis exact payload will be sent to PayPal on submit. Type the dispute id to approve: ")).trim();
    rl.close();
    if (typed === disputeId) report(await call("POST", `${base}/approve`, { draftHash: v.draftHash }));
    else console.log("Not approved.");
  }
} else if (command === "reconcile") {
  // After OUTCOME_UNKNOWN / SUBMITTED_NOT_RECORDED: look the dispute up in
  // PayPal first, then record what you found.
  const outcome = { received: "received", "not-received": "not_received" }[process.argv[4] ?? ""];
  if (!outcome) {
    console.error("Usage: pnpm case reconcile <disputeId> <received|not-received>");
    process.exitCode = 1;
  } else report(await call("POST", `${base}/reconcile`, { outcome }));
} else {
  report(await call("POST", `${base}/submit`, {}));
}

function show({ caseFile: cf, draftHash, approvalValid, payload }: CaseView) {
  const dl = deadlineState(cf.dueAt, new Date(), 72);
  console.log(`\n${cf.disputeId}  ${cf.reason}  ${cf.amount.value} ${cf.amount.currency}${cf.amount.missing ? ` (${cf.amount.missing})` : ""}  ${cf.status}  ${cf.stage}`);
  console.log(`deadline: ${dl.kind}${"hoursLeft" in dl ? ` (${dl.hoursLeft.toFixed(1)} h)` : ` (${dl.reason})`}   stance: ${cf.strategy.stance}`);
  console.log("\nChecklist");
  for (const c of cf.checklist) console.log(`  ${c.gap ? "!" : "✔"} ${c.evidenceType}  ${c.satisfiedBy.length} record(s)${c.gap ? `  — ${c.gap}` : ""}`);
  console.log("\nDraft claims");
  for (const c of cf.draft.claims) {
    const tags = c.evidenceIds.map((id) => (cf.evidence[id]?.source === "paypal" ? "PAYPAL" : "DEMO MERCHANT DATA"));
    console.log(`  - ${c.text}  [${[...new Set(tags)].join(", ")}]`);
  }
  if (cf.removedByVerifier.length) {
    console.log("\nRemoved by verifier");
    for (const r of cf.removedByVerifier) console.log(`  x ${r.text}  — ${r.reason}`);
  }
  console.log("\nPayload (exactly what submit sends)");
  console.log(JSON.stringify({ evidences: payload.evidences }, null, 2).replace(/^/gm, "  "));
  console.log(`  files: ${payload.files.map((f) => f.url).join(", ") || "none"}`);
  if (payload.unanswered.length) console.log(`  unanswered (stay gaps): ${payload.unanswered.join(", ")}`);
  console.log(`\ndraft hash ${draftHash}  approval: ${approvalValid ? "valid" : cf.approval ? "STALE (draft changed)" : "none"}`);
  if (cf.submission) console.log(`submitted ${cf.submission.submittedAt} → ${cf.submission.paypalStatusAfter}`);
}

async function call<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<T | undefined> {
  let res: Response;
  try {
    res = await fetch(`${web}${path}`, {
      method,
      headers: {
        ...(process.env.ALIBI_OPERATOR_TOKEN ? { authorization: `Bearer ${process.env.ALIBI_OPERATOR_TOKEN}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    console.error(`Couldn't reach the web app at ${web}. Start it with: pnpm web:dev`);
    process.exitCode = 1;
    return undefined;
  }
  const data = (await res.json().catch(() => ({}))) as T & { code?: string; message?: string };
  if (!res.ok) {
    console.error(`✘ ${res.status} ${data.code ?? ""} ${data.message ?? ""}`);
    process.exitCode = 1;
    return undefined;
  }
  return data;
}

function report(r: unknown) {
  if (r !== undefined) console.log(`✔ ${JSON.stringify(r)}`);
}
