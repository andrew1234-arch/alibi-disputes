import type { PaypalEnv } from "@alibi/core";
import { PaypalClient, type PaypalClientOptions } from "./client";
import { disputeDetailSchema, disputeListSchema } from "./schemas";

// Read-only PayPal surface (@alibi/paypal/read). Safe for @alibi/agent to import:
// nothing here changes dispute state.

export { PaypalError, PaypalNetworkError, PaypalNotSentError, PaypalResponseShapeError } from "./errors";
export { SANDBOX_BASE } from "./host";
export { disputeDetailSchema, type DisputeDetail, type DisputeSummary } from "./schemas";
export { disputeToEvidence, requestedEvidence } from "./to-evidence";

export interface ListDisputesParams {
  /** Comma-separated states, e.g. "REQUIRED_ACTION". */
  dispute_state?: string;
  disputed_transaction_id?: string;
  start_time?: string;
  update_time_after?: string;
  update_time_before?: string;
  /** 1–50, PayPal default 10. */
  page_size?: number;
  next_page_token?: string;
}

export function createPaypalReader(env: PaypalEnv, opts?: PaypalClientOptions) {
  const client = new PaypalClient(env, opts);
  return {
    baseUrl: client.baseUrl,
    getToken: async () => (await client.getToken()).scope,
    listDisputes: (params: ListDisputesParams = {}) =>
      client.request({ method: "GET", path: "/v1/customer/disputes", query: { ...params }, schema: disputeListSchema }),
    getDispute: (id: string) =>
      client.request({
        method: "GET",
        path: `/v1/customer/disputes/${encodeURIComponent(id)}`,
        schema: disputeDetailSchema,
      }),
  };
}
export type PaypalReader = ReturnType<typeof createPaypalReader>;
