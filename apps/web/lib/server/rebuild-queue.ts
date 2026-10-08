import { PaypalError } from "@alibi/paypal/read";
import { rebuildCase } from "./cases";
import type { AppContext } from "./context";

// Durable rebuild queue (pending_rebuilds). A webhook's job ends once the row
// is written; this worker does the slow part and retries until it succeeds,
// so a failed rebuild or a restart never loses a dispute update.
//
// Backoff: 30 s, 1 min, 2 min, … capped at 1 h. Worked example: a rebuild
// fails 3 times (PayPal 503s) → retries at +30 s, +1 min, +2 min; the 4th
// succeeds and the row is deleted.

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 60 * 60_000;
export const POLL_INTERVAL_MS = 30_000;

export const retryDelayMs = (attempts: number) => Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
/** ~1 day of retries at the 1 h cap; after that a human should look. */
export const MAX_ATTEMPTS = 24;

/**
 * Errors no retry can fix: PayPal says the dispute doesn't exist or isn't
 * ours (4xx other than 429), or the input is malformed. Retrying those only
 * spams PayPal and the activity feed.
 */
export function isPermanent(e: unknown): boolean {
  if (e instanceof PaypalError) return e.status >= 400 && e.status < 500 && e.status !== 429;
  return e instanceof RangeError || e instanceof SyntaxError;
}

let draining: Promise<void> | undefined;
let rerun = false;

/**
 * Runs every due rebuild. Calls during a pass don't start a second one in
 * parallel; they flag another pass, so a job queued mid-pass (after the
 * pass read its list) is picked up right away instead of at the next poll.
 */
export function drainRebuilds(ctx: AppContext): Promise<void> {
  if (draining) {
    rerun = true;
    return draining;
  }
  draining = (async () => {
    try {
      do {
        rerun = false;
        for (const job of await ctx.repo.dueRebuilds()) {
          try {
            await rebuildCase(ctx, job.disputeId);
            await ctx.repo.rebuildDone(job.disputeId, job.version);
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            const attempt = job.attempts + 1;
            if (isPermanent(e) || attempt >= MAX_ATTEMPTS) {
              // Give up on this queueing; a new webhook or a manual build re-queues it.
              await ctx.repo.rebuildDone(job.disputeId, job.version);
              await ctx.repo.logActivity(job.disputeId, "build_abandoned", { error, attempt, permanent: isPermanent(e) });
            } else {
              await ctx.repo.rebuildFailed(job.disputeId, job.version, error, retryDelayMs(job.attempts));
              await ctx.repo.logActivity(job.disputeId, "build_failed", { error, attempt });
            }
          }
        }
      } while (rerun);
    } finally {
      draining = undefined;
    }
  })();
  return draining;
}

/** Picks up rows left by a previous process, then polls for due retries. */
export function startRebuildWorker(ctx: AppContext): void {
  const tick = () =>
    void drainRebuilds(ctx).catch((e: unknown) => console.error("[alibi] rebuild queue", e instanceof Error ? e.message : e));
  tick();
  setInterval(tick, POLL_INTERVAL_MS).unref();
}
