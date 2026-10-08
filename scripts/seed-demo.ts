// Links the synthetic demo-merchant scenarios to REAL sandbox transactions
// (CLAUDE §1.3: demo records are synthetic, labelled, and tied to real
// sandbox transaction ids).
//
//   pnpm seed:demo --link inr-delivered=PP-D-123 --link snad-color=PP-D-456
//   pnpm seed:demo --auto        # match open disputes to scenarios by exact amount
//   pnpm seed:demo --list        # show scenarios and current links
//
// A link is refused if the sandbox payment amount differs from the
// scenario's order amount: the case file would contradict itself.

import { SCENARIOS, scenario } from "@alibi/merchant";
import { createPaypalReader, type DisputeDetail } from "@alibi/paypal/read";
import { flag, openRepo, options, scriptEnv } from "./lib";

const env = scriptEnv();
const reader = createPaypalReader(env);
const { repo, close } = await openRepo(env.DATABASE_URL);

try {
  if (flag("--list")) {
    const links = await repo.listDemoLinks();
    for (const s of SCENARIOS) {
      const l = links.find((x) => x.scenario === s.id);
      console.log(`${s.id.padEnd(16)} ${s.order.amount} ${s.order.currency}  ${l ? `→ ${l.transactionId}` : "(not linked)"}  ${s.summary}`);
    }
  } else {
    const pairs = options("--link").map((p) => p.split("=") as [string, string]);
    if (flag("--auto")) pairs.push(...(await autoPairs(new Set((await repo.listDemoLinks()).map((l) => l.scenario)))));
    if (pairs.length === 0) {
      console.error("Nothing to link. Use --link <scenario>=<disputeId>, --auto, or --list.");
      process.exitCode = 1;
    }
    for (const [scenarioId, disputeId] of pairs) await link(scenarioId, disputeId);
  }
} finally {
  await close();
}

async function link(scenarioId: string, disputeId: string) {
  const s = scenario(scenarioId);
  if (!s) return fail(`Unknown scenario "${scenarioId}". Known: ${SCENARIOS.map((x) => x.id).join(", ")}`);
  const d = (await reader.getDispute(disputeId)).data;
  const tx = d.disputed_transactions?.[0];
  if (!tx?.seller_transaction_id || !tx.create_time) return fail(`${disputeId}: PayPal returned no seller transaction id/time.`);
  const paid = tx.gross_amount;
  if (!paid || paid.currency_code !== s.order.currency || Number(paid.value) !== Number(s.order.amount)) {
    return fail(
      `${disputeId}: sandbox payment is ${paid ? `${paid.value} ${paid.currency_code}` : "unknown"}, scenario ${s.id} is ${s.order.amount} ${s.order.currency}. Pay the exact scenario amount.`,
    );
  }
  await repo.setDemoLink(s.id, tx.seller_transaction_id);
  console.log(`✔ ${s.id} → transaction ${tx.seller_transaction_id} (dispute ${disputeId}, ${d.status})`);
  warnTiming(s.id, tx.create_time, d);
}

/** Warn if the dispute was opened before the scenario's story (e.g. delivery) could have happened. */
function warnTiming(id: string, paidAt: string, d: DisputeDetail) {
  const s = scenario(id)!;
  const lastHours = Math.max(0, ...(s.shipment?.events.map((e) => e.atHours) ?? []), ...s.messages.map((m) => m.atHours));
  const opened = d.create_time ? Date.parse(d.create_time) : Date.now();
  const storyEnds = Date.parse(paidAt) + lastHours * 3_600_000;
  if (opened < storyEnds) {
    console.warn(
      `  ! Dispute opened ${((storyEnds - opened) / 3_600_000).toFixed(0)} h before the scenario's last event. ` +
        `Events after "now" are hidden until they "happen"; for the demo, open disputes ≥ ${Math.ceil(lastHours / 24)} days after paying.`,
    );
  }
}

async function autoPairs(already: Set<string>): Promise<[string, string][]> {
  const { data } = await reader.listDisputes({ page_size: 50 });
  const out: [string, string][] = [];
  const used = new Set<string>();
  for (const s of SCENARIOS) {
    if (already.has(s.id)) continue;
    const match = data.items.find(
      (d) =>
        !used.has(d.dispute_id) &&
        d.status !== "RESOLVED" &&
        d.dispute_amount?.currency_code === s.order.currency &&
        Number(d.dispute_amount.value) === Number(s.order.amount),
    );
    if (match) {
      used.add(match.dispute_id);
      out.push([s.id, match.dispute_id]);
    } else console.log(`· ${s.id}: no open sandbox dispute for ${s.order.amount} ${s.order.currency}`);
  }
  return out;
}

function fail(msg: string) {
  console.error(`✘ ${msg}`);
  process.exitCode = 1;
}
