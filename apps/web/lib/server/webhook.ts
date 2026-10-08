import { z } from "zod";
import type { HeaderLookup, WebhookVerifier } from "@alibi/paypal/webhooks";
import type { Repo } from "@alibi/store";

// PayPal webhook receiver (CLAUDE §1.9, SPEC §5.1).
// Order matters: verify the signature *before* recording the event id, so an
// unverified request can never poison the dedupe table and block the genuine
// event later.
//
// Dispute event names (verbatim, developer.paypal.com/disputes/test-go-live):
//   CUSTOMER.DISPUTE.CREATED · CUSTOMER.DISPUTE.UPDATED · CUSTOMER.DISPUTE.RESOLVED

export const DISPUTE_EVENTS = ["CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED"] as const;

const eventSchema = z.looseObject({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource: z.looseObject({ dispute_id: z.string().optional() }).optional(),
});

export interface WebhookDeps {
  verifier: Pick<WebhookVerifier, "verify">;
  repo: Repo;
  /** The rebuild row is committed; start working on it now (don't wait for the poller). Must not throw. */
  onQueued: (disputeId: string) => void;
}

export type WebhookResult = { httpStatus: 200 | 400 | 401; body: Record<string, unknown> };

/** Dispute events are a few KB; anything far bigger isn't from PayPal. Enforced while reading (routes.ts). */
export const MAX_WEBHOOK_BYTES = 512 * 1024;

export async function handlePaypalWebhook(rawBody: string, headers: HeaderLookup, deps: WebhookDeps): Promise<WebhookResult> {
  let event: z.infer<typeof eventSchema>;
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
    event = eventSchema.parse(payload);
  } catch {
    return { httpStatus: 400, body: { error: "invalid event body" } };
  }

  const v = await deps.verifier.verify(headers, rawBody);
  if (!v.verified) {
    // Server log only: the endpoint is public, and nothing from an unverified
    // body should be able to fill the merchant's activity log.
    console.warn(`[alibi] webhook rejected: ${v.reason}`);
    return { httpStatus: 401, body: { error: "signature not verified" } };
  }

  const disputeId = event.resource?.dispute_id;
  const relevant = (DISPUTE_EVENTS as readonly string[]).includes(event.event_type) && disputeId ? disputeId : undefined;
  // Event id and queued rebuild commit together: PayPal retries are deduped,
  // and an event is never marked processed without its rebuild queued.
  if (!(await deps.repo.recordWebhookEvent(event.id, event.event_type, payload, relevant))) {
    return { httpStatus: 200, body: { duplicate: true } };
  }
  // Best effort from here: the queue row is durable and the poller picks it up.
  await deps.repo
    .logActivity(disputeId ?? null, "webhook", { eventId: event.id, eventType: event.event_type, queued: Boolean(relevant) })
    .catch(() => {});
  if (relevant) deps.onQueued(relevant);
  return { httpStatus: 200, body: { received: true } };
}
