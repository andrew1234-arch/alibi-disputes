import { nextPageToken } from "@alibi/paypal/read";
import type { AppContext } from "./context";

// Polling fallback (SPEC §5.1, CLAUDE §1.9): webhooks are the primary signal,
// but a missed webhook, a sandbox that doesn't deliver them, or downtime must
// not leave a dispute stale. Every ALIBI_POLL_MINUTES (and once at startup)
// list the merchant's disputes and queue a rebuild for any whose update_time
// changed since the last poll. Queueing goes through the same durable
// pending_rebuilds table as webhooks, so a dispute both polled and webhooked
// is rebuilt once.
//
// Example: dispute D last seen with update_time T1. A webhook was missed;
// PayPal now lists D with T2 → recordPolledDispute returns true → D queued.
// The next poll still sees T2 → nothing queued.

const PAGE_SIZE = 50; // PayPal's maximum (docs/OPEN_QUESTIONS.md, list params)
const MAX_PAGES = 20; // 1,000 disputes per poll is far beyond a demo merchant

export async function pollDisputes(ctx: AppContext): Promise<{ listed: number; queued: string[] }> {
  const queued: string[] = [];
  let listed = 0;
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await ctx.reader.listDisputes({ page_size: PAGE_SIZE, ...(token ? { next_page_token: token } : {}) });
    for (const d of data.items) {
      listed++;
      // No update_time: fall back to the status, so at least status changes are seen.
      if (await ctx.repo.recordPolledDispute(d.dispute_id, d.update_time ?? `status:${d.status}`)) queued.push(d.dispute_id);
    }
    token = nextPageToken(data);
    if (!token) break;
  }
  if (queued.length) {
    await ctx.repo.logActivity(null, "poll", { call: "GET /v1/customer/disputes", listed, queued }).catch(() => {});
    for (const id of queued) ctx.onQueued(id);
  }
  return { listed, queued };
}

/** Polls at startup, then every `minutes` (0 = never). Errors are logged; the next tick retries. */
export function startPoller(ctx: AppContext, minutes: number): void {
  if (minutes <= 0) return;
  const tick = () =>
    void pollDisputes(ctx).catch((e: unknown) => console.error("[alibi] poll failed:", e instanceof Error ? e.message : e));
  tick();
  setInterval(tick, minutes * 60_000).unref();
}
