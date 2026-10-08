import { nextPageToken } from "@alibi/paypal/read";
import type { AppContext } from "./context";

// Polling fallback (SPEC §5.1, CLAUDE §1.9): webhooks are the primary signal,
// but a missed webhook, a sandbox that doesn't deliver them, or downtime must
// not leave a dispute stale. Every ALIBI_POLL_MINUTES (and once at startup)
// list the merchant's disputes and queue a rebuild for any whose update_time
// differs from the one its stored case was built from. Webhook rebuilds update
// that too, so a change a webhook already handled isn't rebuilt twice.
//
// After the first full poll, only disputes updated since the last successful
// poll are listed (update_time_after, with an overlap margin).
//
// Example: case D built from update_time T1. A webhook was missed; PayPal now
// lists D with T2 → queued. Once rebuilt (case now at T2), polls skip D.

const PAGE_SIZE = 50; // PayPal's maximum (docs/OPEN_QUESTIONS.md, list params)
const MAX_PAGES = 20; // 1,000 disputes per poll is far beyond a demo merchant
const LAST_POLL_KEY = "poll.last_started_at";
/** Overlap with the previous poll, so clock skew or a slow update never slips through the gap. */
const OVERLAP_MS = 60 * 60_000;

export async function pollDisputes(ctx: AppContext): Promise<{ listed: number; queued: string[] }> {
  const startedAt = ctx.now();
  const last = await ctx.repo.getState(LAST_POLL_KEY);
  // VERIFY (OPEN_QUESTIONS): update_time_after filters on the dispute's update_time.
  const since = last ? new Date(new Date(last).getTime() - OVERLAP_MS).toISOString() : undefined;
  const queued: string[] = [];
  let listed = 0;
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await ctx.reader.listDisputes({
      page_size: PAGE_SIZE,
      ...(since ? { update_time_after: since } : {}),
      ...(token ? { next_page_token: token } : {}),
    });
    for (const d of data.items) {
      listed++;
      if (await ctx.repo.pollNeedsRebuild(d.dispute_id, d.update_time, d.status)) queued.push(d.dispute_id);
    }
    token = nextPageToken(data);
    if (!token) break;
  }
  // Only a poll that got through every page moves the window forward.
  if (!token) await ctx.repo.setState(LAST_POLL_KEY, startedAt.toISOString());
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
