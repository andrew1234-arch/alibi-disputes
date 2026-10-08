import { parseEnv, webEnvSchema, type WebEnv } from "@alibi/core";
import { DemoStore } from "@alibi/merchant";
import { createPaypalReader, type PaypalReader } from "@alibi/paypal/read";
import { createWebhookVerifier, type WebhookVerifier } from "@alibi/paypal/webhooks";
import { createPaypalWriter, type PaypalWriter } from "@alibi/paypal/write";
import { createRepo, createSql, type Repo } from "@alibi/store";
import { drainRebuilds, startRebuildWorker } from "./rebuild-queue";

// Composition root for server routes. Built once per process, on first use
// (never at build time). Secrets stay here and in the adapters; nothing in
// this context is ever serialised to the browser.

export interface AppContext {
  env: Pick<WebEnv, "DEMO_READONLY" | "ALIBI_MERCHANT_TIME_ZONE" | "ALIBI_OPERATOR_TOKEN">;
  repo: Repo;
  reader: Pick<PaypalReader, "getDispute">;
  writer: Pick<PaypalWriter, "provideEvidence">;
  verifier: Pick<WebhookVerifier, "verify">;
  /** Demo links change when scripts/seed-demo.ts runs, so the store is built per use. */
  merchant: () => Promise<DemoStore>;
  /** A rebuild row was committed (by the webhook, in its own transaction): kick the worker. */
  onQueued: (disputeId: string) => void;
  now: () => Date;
}

let context: Promise<AppContext> | undefined;

export function getContext(): Promise<AppContext> {
  context ??= init().catch((e: unknown) => {
    context = undefined; // let the next request retry (e.g. DB was briefly down)
    throw e;
  });
  return context;
}

async function init(): Promise<AppContext> {
  const env = parseEnv(webEnvSchema, process.env);
  const webhookId = env.PAYPAL_WEBHOOK_ID;
  const repo = createRepo(createSql(env.DATABASE_URL));
  await repo.migrate();
  const ctxReader = createPaypalReader(env);
  const ctx: AppContext = {
    env,
    repo,
    reader: ctxReader,
    writer: createPaypalWriter(env),
    verifier: webhookId
      ? createWebhookVerifier({ ...env, PAYPAL_WEBHOOK_ID: webhookId })
      : { verify: async () => ({ verified: false as const, reason: "PAYPAL_WEBHOOK_ID is not configured" }) },
    merchant: async () => new DemoStore(await repo.listDemoLinks()),
    // Durable: the webhook commits the queue row before answering PayPal;
    // this only starts the worker early. Failures are recorded per job and
    // the poller retries.
    onQueued: () => void drainRebuilds(ctx).catch(() => {}),
    now: () => new Date(),
  };
  startRebuildWorker(ctx);
  return ctx;
}
