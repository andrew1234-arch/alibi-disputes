import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDispute } from "@alibi/test-stub";
import { rebuildCase } from "@/lib/server/cases";
import { pollDisputes } from "@/lib/server/poller";
import { drainRebuilds } from "@/lib/server/rebuild-queue";
import { makeHealthRoute } from "@/lib/server/routes";
import { resetHarness, startHarness, type Harness } from "./harness";

// SPEC §5.1 polling fallback, against the PayPal stub and a real schema.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());
beforeEach(() => resetHarness(h));

const queuedRows = async () => (await h.sql.query<{ dispute_id: string }>(`select dispute_id from pending_rebuilds order by dispute_id`)).rows.map((r) => r.dispute_id);

describe("polling fallback", () => {
  it("queues disputes whose PayPal update_time differs from the built case; built ones are skipped", async () => {
    h.stub.setDispute(makeDispute({ dispute_id: "PP-D-A", update_time: "2026-10-07T10:00:00.000Z" }));
    h.stub.setDispute(makeDispute({ dispute_id: "PP-D-B", update_time: "2026-10-07T10:00:00.000Z" }));

    expect((await pollDisputes(h.ctx)).queued.sort()).toEqual(["PP-D-A", "PP-D-B"]);
    expect(await queuedRows()).toEqual(["PP-D-A", "PP-D-B"]);
    await drainRebuilds(h.ctx); // builds both cases (at the listed update_time)
    expect(await queuedRows()).toEqual([]);

    expect((await pollDisputes(h.ctx)).queued).toEqual([]); // nothing changed since the build

    h.stub.setDispute(makeDispute({ dispute_id: "PP-D-B", status: "UNDER_REVIEW", update_time: "2026-10-08T09:00:00.000Z" }));
    expect((await pollDisputes(h.ctx)).queued).toEqual(["PP-D-B"]);
  });

  it("a change a webhook already rebuilt isn't rebuilt again by the poll", async () => {
    h.stub.setDispute(makeDispute({ dispute_id: "PP-D-W", update_time: "2026-10-08T09:00:00.000Z" }));
    await rebuildCase(h.ctx, "PP-D-W"); // what the webhook-triggered rebuild does
    expect((await pollDisputes(h.ctx)).queued).toEqual([]);
  });

  it("a rebuild that failed is retried by the next poll; a waiting row keeps its backoff", async () => {
    h.stub.setDispute(makeDispute({ dispute_id: "PP-D-F", update_time: "2026-10-08T09:00:00.000Z" }));
    await pollDisputes(h.ctx);
    const down = { ...h.ctx, reader: { ...h.ctx.reader, getDispute: async () => Promise.reject(new Error("PayPal 503")) } };
    await drainRebuilds(down);
    const before = (await h.sql.query<{ attempts: number }>(`select attempts from pending_rebuilds`)).rows[0];
    expect(before?.attempts).toBe(1);
    expect((await pollDisputes(h.ctx)).queued).toEqual(["PP-D-F"]); // still not built
    const after = (await h.sql.query<{ attempts: number }>(`select attempts from pending_rebuilds`)).rows[0];
    expect(after?.attempts).toBe(1); // not reset by the poll
  });

  it("after the first full poll, lists only disputes updated since then (with overlap)", async () => {
    const calls: Record<string, unknown>[] = [];
    const reader = {
      ...h.ctx.reader,
      listDisputes: async (p: Record<string, unknown> = {}) => {
        calls.push(p);
        const data = { items: [], links: [] };
        return { data, raw: { status: 200, debugId: undefined, body: data } };
      },
    } as unknown as typeof h.ctx.reader;
    await pollDisputes({ ...h.ctx, reader });
    await pollDisputes({ ...h.ctx, reader });
    expect(calls[0]).not.toHaveProperty("update_time_after");
    // h.ctx.now() is fixed; the second poll asks for changes since then minus 1 h.
    expect(calls[1]!.update_time_after).toBe(new Date(h.ctx.now().getTime() - 3_600_000).toISOString());
  });

  it("follows next-page links", async () => {
    const pages: Record<string, { items: { dispute_id: string; status: string; update_time: string }[]; links: { rel: string; href: string }[] }> = {
      first: { items: [{ dispute_id: "P1", status: "OPEN", update_time: "t1" }], links: [{ rel: "next", href: "https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=50&next_page_token=TOKEN2" }] },
      TOKEN2: { items: [{ dispute_id: "P2", status: "OPEN", update_time: "t1" }], links: [] },
    };
    const seen: (string | undefined)[] = [];
    const reader = {
      ...h.ctx.reader,
      listDisputes: async (p: { next_page_token?: string } = {}) => {
        seen.push(p.next_page_token);
        const data = pages[p.next_page_token ?? "first"]!;
        return { data, raw: { status: 200, debugId: undefined, body: data } };
      },
    } as unknown as typeof h.ctx.reader;
    const r = await pollDisputes({ ...h.ctx, reader });
    expect(seen).toEqual([undefined, "TOKEN2"]);
    expect(r).toMatchObject({ listed: 2, queued: ["P1", "P2"] });
  });
});

describe("health route", () => {
  it("200 with no secrets once the context is up", async () => {
    const res = await makeHealthRoute(async () => h.ctx)();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, readonly: false, llm: false });
  });
});
