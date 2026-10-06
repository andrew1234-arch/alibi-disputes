import type { EvidenceRecord } from "@alibi/core";

// Merchant data adapter (SPEC §6.3). DemoStore (Postgres seed data, every record
// source "merchant_demo") lands in M2.

export interface MerchantStore {
  findOrderByTransaction(transactionId: string): Promise<EvidenceRecord | undefined>;
  fulfilment(orderId: string): Promise<EvidenceRecord[]>;
  messages(orderId: string): Promise<EvidenceRecord[]>;
  policies(): Promise<EvidenceRecord[]>;
}
