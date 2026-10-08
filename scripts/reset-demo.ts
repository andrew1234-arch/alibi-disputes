// Prepares demo disputes before recording the video and before judging opens.
//
//   pnpm reset:demo                      # report only: state of every linked demo dispute
//   pnpm reset:demo --clear-local        # also forget local cases/approvals/submissions for them
//   pnpm reset:demo --require-evidence   # sandbox-only: UNDER_REVIEW → WAITING_FOR_SELLER_RESPONSE
//
// State-changing steps are opt-in flags. A RESOLVED dispute can't be reopened:
// create a new one in the sandbox (personal account → Resolution Center) and re-run seed:demo.

import { hasAction } from "@alibi/core";
import { SCENARIOS } from "@alibi/merchant";
import { createPaypalReader } from "@alibi/paypal/read";
import { createSandboxHelpers } from "@alibi/paypal/sandbox";
import { flag, openRepo, scriptEnv } from "./lib";

const env = scriptEnv();
const reader = createPaypalReader(env);
const sandbox = createSandboxHelpers(env);
const { repo, close } = await openRepo(env.DATABASE_URL);

try {
  const links = await repo.listDemoLinks();
  if (links.length === 0) console.log("No demo links yet. Run pnpm seed:demo first.");
  const touched: string[] = [];

  for (const link of links) {
    const s = SCENARIOS.find((x) => x.id === link.scenario);
    const { data } = await reader.listDisputes({ disputed_transaction_id: link.transactionId });
    if (data.items.length === 0) console.log(`${link.scenario}: no dispute for transaction ${link.transactionId}`);
    for (const item of data.items) {
      touched.push(item.dispute_id);
      let status = item.status;
      if (flag("--require-evidence") && status === "UNDER_REVIEW") {
        const d = (await reader.getDispute(item.dispute_id)).data;
        if (hasAction(d.links, "require-evidence")) {
          await sandbox.requireEvidence(item.dispute_id, "SELLER_EVIDENCE");
          status = (await reader.getDispute(item.dispute_id)).data.status;
        }
      }
      const ready = status === "WAITING_FOR_SELLER_RESPONSE";
      console.log(`${ready ? "✔" : "·"} ${link.scenario.padEnd(16)} ${item.dispute_id}  ${status}${s ? `  (${s.summary})` : ""}`);
      if (status === "RESOLVED") console.log("    resolved: open a new sandbox dispute for this scenario and re-link it");
    }
  }

  if (flag("--clear-local") && touched.length) {
    await repo.resetDisputes(touched);
    console.log(`Cleared local cases, approvals and submissions for ${touched.length} dispute(s).`);
  }
} finally {
  await close();
}
