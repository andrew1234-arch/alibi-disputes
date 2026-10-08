import { vi } from "vitest";
import type { PaypalEnv } from "@alibi/core";

export const env: PaypalEnv = {
  PAYPAL_CLIENT_ID: "id",
  PAYPAL_CLIENT_SECRET: "secret",
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  PAYPAL_TEST_MODE: false,
};

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const token = () => json(200, { access_token: "tok", token_type: "Bearer", expires_in: 3600, scope: "s" });

export const mockFetch = () => vi.fn<(u: string, i?: RequestInit) => Promise<Response>>();
