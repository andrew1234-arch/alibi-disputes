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

/**
 * The `next_page_token` from a dispute list's `rel: "next"` HATEOAS link, if any.
 * VERIFY (OPEN_QUESTIONS): sandbox list responses carry pagination as a "next"
 * link whose href has `next_page_token`; confirm with a real multi-page list.
 *
 * Example: { rel: "next", href: "https://…/v1/customer/disputes?page_size=50&next_page_token=ABC" } → "ABC".
 */
export function nextPageToken(list: { links?: { rel: string; href: string }[] | undefined }): string | undefined {
  const href = list.links?.find((l) => l.rel === "next")?.href;
  if (!href) return undefined;
  try {
    return new URL(href).searchParams.get("next_page_token") ?? undefined;
  } catch {
    return undefined;
  }
}
