import type { EvidenceRecord } from "@alibi/core";
import { makeEvidenceRecord } from "@alibi/core/server";
import { renderDemoPdf } from "./pdf";
import { scenario, type Scenario } from "./scenarios";

export { SCENARIOS, scenario, type Scenario } from "./scenarios";
export { renderDemoPdf } from "./pdf";

// Merchant data adapter (SPEC §6.3). Real store integrations (Shopify etc.) are
// out of scope; they would implement MerchantStore.

export interface LinkedTransaction {
  transactionId: string;
  /** Payment time from PayPal (disputed_transactions[].create_time). */
  paidAt: string;
}

export interface MerchantStore {
  /** All merchant-side records for a PayPal transaction: order, fulfilment, carrier events, messages, policies. */
  recordsForTransaction(tx: LinkedTransaction, now: Date): Promise<EvidenceRecord[]>;
  /** Bytes for a record's documentUrl, if this store serves it. */
  document(documentUrl: string): Promise<{ filename: string; bytes: Uint8Array } | undefined>;
}

export const DEMO_DOCUMENT_PREFIX = "/api/demo-documents/";

/**
 * Demo store: synthetic scenarios linked to real sandbox transactions by id
 * (links come from scripts/seed-demo.ts via the demo_links table).
 */
export class DemoStore implements MerchantStore {
  constructor(private readonly links: readonly { scenario: string; transactionId: string }[]) {}

  async recordsForTransaction(tx: LinkedTransaction, now: Date): Promise<EvidenceRecord[]> {
    const link = this.links.find((l) => l.transactionId === tx.transactionId);
    const s = link ? scenario(link.scenario) : undefined;
    return s ? buildScenarioRecords(s, tx, now) : [];
  }

  async document(documentUrl: string) {
    const m = new RegExp(`^${DEMO_DOCUMENT_PREFIX}([a-z0-9-]+)/([a-z0-9.-]+\\.pdf)$`).exec(documentUrl);
    if (!m) return undefined;
    const doc = scenario(m[1]!)?.shipment?.events.find((e) => e.document?.name === m[2])?.document;
    return doc ? { filename: doc.name, bytes: renderDemoPdf(doc.title, doc.lines) } : undefined;
  }
}

/** Pure: scenario + real payment time → evidence records, omitting anything later than `now`. */
export function buildScenarioRecords(s: Scenario, tx: LinkedTransaction, now: Date): EvidenceRecord[] {
  const paid = Date.parse(tx.paidAt);
  if (Number.isNaN(paid)) throw new Error(`Invalid paidAt ${tx.paidAt}`);
  const at = (h: number) => new Date(paid + h * 3_600_000).toISOString();
  const happened = (h: number) => paid + h * 3_600_000 <= now.getTime();
  const fetchedAt = now.toISOString();
  const base = { source: "merchant_demo" as const, fetchedAt };
  const out: EvidenceRecord[] = [];

  const o = s.order;
  out.push(
    makeEvidenceRecord({
      ...base,
      kind: "order",
      ref: o.number,
      label: `Order #${o.number}: ${o.item}`,
      value: `${o.quantity} x ${o.item}, ${o.amount} ${o.currency}, ship to ${o.shipTo}, PayPal transaction ${tx.transactionId}`,
      occurredAt: at(0),
    }),
  );

  const sh = s.shipment;
  if (sh && happened(sh.atHours)) {
    out.push(
      makeEvidenceRecord({
        ...base,
        kind: "fulfilment",
        ref: sh.tracking,
        label: `Shipped via ${sh.carrier}`,
        value: `${sh.carrier} ${sh.tracking}`,
        occurredAt: at(sh.atHours),
      }),
    );
    for (const e of sh.events) {
      if (!happened(e.atHours)) continue;
      out.push(
        makeEvidenceRecord({
          ...base,
          kind: "carrier_event",
          ref: sh.tracking,
          label: `${sh.carrier} scan`,
          value: e.text,
          occurredAt: at(e.atHours),
          ...(e.document ? { documentUrl: `${DEMO_DOCUMENT_PREFIX}${s.id}/${e.document.name}` } : {}),
        }),
      );
    }
  }

  s.messages.forEach((m, i) => {
    if (!happened(m.atHours)) return;
    out.push(
      makeEvidenceRecord({
        ...base,
        kind: m.from === "buyer" ? "buyer_message" : "seller_message",
        ref: `order-${o.number}/message/${i}`,
        label: m.from === "buyer" ? "Buyer email to store" : "Store reply to buyer",
        value: m.text,
        occurredAt: at(m.atHours),
      }),
    );
  });

  for (const p of s.policies) {
    out.push(makeEvidenceRecord({ ...base, kind: "policy", ref: p.id, label: p.label, value: p.text }));
  }
  return out;
}
