import { z } from "zod";
import type { PaypalEnv } from "@alibi/core";
import { PaypalClient, type PaypalClientOptions } from "./client";

// Webhook signature verification (CLAUDE §1.9) via
// POST /v1/notifications/verify-webhook-signature. Field names and required
// set from PayPal's spec (notifications_webhooks_v1.json, verify_webhook_signature).
//
// The event goes to PayPal as the *raw bytes received*, spliced into the JSON
// body, never re-serialised: PayPal signs the original body, and a
// JSON.parse/JSON.stringify round trip (key order, number formatting, unicode
// escapes) can turn a genuine event into a FAILURE.

const HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

const responseSchema = z.looseObject({ verification_status: z.enum(["SUCCESS", "FAILURE"]) });

export type WebhookVerification = { verified: true } | { verified: false; reason: string };

export type HeaderLookup = { get(name: string): string | null };

export function createWebhookVerifier(env: PaypalEnv & { PAYPAL_WEBHOOK_ID: string }, opts?: PaypalClientOptions) {
  const client = new PaypalClient(env, opts);
  return {
    async verify(headers: HeaderLookup, rawBody: string): Promise<WebhookVerification> {
      const fields: Record<string, string> = {};
      for (const [field, header] of Object.entries(HEADERS)) {
        const v = headers.get(header);
        if (!v) return { verified: false, reason: `missing ${header} header` };
        fields[field] = v;
      }
      // Cheap local check before spending a PayPal call: the cert must be
      // served over HTTPS from a paypal.com host. Anything else is forged.
      // VERIFY: host rule against a real sandbox delivery (docs/OPEN_QUESTIONS.md).
      if (!isPaypalCertUrl(fields.cert_url ?? "")) return { verified: false, reason: "cert URL is not an https paypal.com URL" };
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      } catch {
        return { verified: false, reason: "body is not a JSON object" };
      }
      const prefix = JSON.stringify({ ...fields, webhook_id: env.PAYPAL_WEBHOOK_ID }).slice(0, -1);
      const body = `${prefix},"webhook_event":${rawBody}}`;
      const { data } = await client.post("/v1/notifications/verify-webhook-signature", body, responseSchema, "application/json");
      return data.verification_status === "SUCCESS" ? { verified: true } : { verified: false, reason: "PayPal returned FAILURE" };
    },
  };
}
export type WebhookVerifier = ReturnType<typeof createWebhookVerifier>;

/** e.g. https://api.sandbox.paypal.com/v1/notifications/certs/CERT-… → true; http:// or evil.com → false. */
export function isPaypalCertUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "paypal.com" || u.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}
