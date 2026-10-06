import { z } from "zod";
import type { PaypalEnv } from "@alibi/core";
import { REQUIRE_EVIDENCE_ACTIONS, ADJUDICATION_OUTCOMES } from "@alibi/core";
import { PaypalClient, type PaypalClientOptions } from "./client.js";
import { SANDBOX_BASE } from "./host.js";

// Sandbox-only test helpers (SPEC §6.1). Imported by scripts/ only — never by the
// app. Both endpoints are documented as sandbox-only by PayPal; we additionally
// refuse to run them in test mode against anything but the real sandbox or a stub.

// Response bodies for these endpoints are VERIFY (spec documents a links list);
// accept any JSON object until the probe records a real one.
const anyObject = z.unknown();

export function createSandboxHelpers(env: PaypalEnv, opts?: PaypalClientOptions) {
  const client = new PaypalClient(env, opts);
  if (client.baseUrl !== SANDBOX_BASE && !env.PAYPAL_TEST_MODE) throw new Error("sandbox helpers require the sandbox");
  return {
    /** UNDER_REVIEW → WAITING_FOR_{BUYER|SELLER}_RESPONSE. */
    requireEvidence: (id: string, action: (typeof REQUIRE_EVIDENCE_ACTIONS)[number]) =>
      client.request({
        method: "POST",
        path: `/v1/customer/disputes/${encodeURIComponent(id)}/require-evidence`,
        json: { action },
        schema: anyObject,
      }),
    /** Settles a dispute that is UNDER_REVIEW with an `adjudicate` link. */
    adjudicate: (id: string, outcome: (typeof ADJUDICATION_OUTCOMES)[number]) =>
      client.request({
        method: "POST",
        path: `/v1/customer/disputes/${encodeURIComponent(id)}/adjudicate`,
        json: { adjudication_outcome: outcome },
        schema: anyObject,
      }),
  };
}
