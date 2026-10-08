import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDispute } from "@alibi/test-stub";
import { pollDisputes } from "@/lib/server/poller";
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
  it("queues new and changed disputes only", async () => {
    h.stub.setDispute(makeDispute({ dispute_id: "PP-D-A", update_time: "2026-10-07T10:00:00.000Z" }));
    h.stub.setDispute(makeDispute({ dispute_id: "PP-D-B", update_time: "2026-10-07T10:00:00.000Z" }));

    expect((await pollDisputes(h.ctx)).queued.sort()).toEqual(["PP-D-A", "PP-D-B"]);
    expect(await queuedRows()).toEqual(["PP-D-A", "PP-D-B"]);
    expect(h.ctx.enqueued.sort()).toEqual(["PP-D-A", "PP-D-B"]);

    await h.sql.query(`delete from pending_rebuilds`);
    expect((await pollDisputes(h.ctx)).queued).toEqual([]); // nothing changed

    h.stub.setDispute(makeDispute({ dispute_id: "PP-D-B", status: "UNDER_REVIEW", update_time: "2026-10-08T09:00:00.000Z" }));
    expect((await pollDisputes(h.ctx)).queued).toEqual(["PP-D-B"]);
    expect(await queuedRows()).toEqual(["PP-D-B"]);
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
