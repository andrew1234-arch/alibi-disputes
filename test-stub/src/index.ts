import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Local PayPal stub for e2e tests (CLAUDE §1.4: the adapter only accepts a
// non-sandbox URL in PAYPAL_TEST_MODE, and only a loopback one).
//
// It mimics the sandbox behaviour Alibi depends on, using PayPal's documented
// shapes. Where real sandbox behaviour is unconfirmed, the stub follows the
// docs and marks the spot VERIFY. Once docs/SANDBOX_PROBE.md has real
// responses, align the stub with them.
//
// Every request is recorded so tests can assert "no write happened".

export const STUB_TOKEN = "stub-access-token";
export const STUB_VALID_SIGNATURE = "stub-valid-signature";

export interface StubCall {
  method: string;
  path: string;
  /** Parsed JSON body, or for multipart the parsed `input` part. */
  input?: unknown;
  files?: { part: string; filename: string; type: string; size: number }[];
}

export type Dispute = Record<string, unknown> & { dispute_id: string; status: string };

export interface StubOptions {
  webhookId?: string;
  /** Fixed port (default: a free one). */
  port?: number;
  /** Emit HATEOAS rels with underscores ("provide_evidence"), as some integrators report seeing. */
  underscoreRels?: boolean;
}

export interface Stub {
  url: string;
  calls: StubCall[];
  setDispute(d: Dispute): void;
  getDispute(id: string): Dispute | undefined;
  /** Switch HATEOAS rel spelling at runtime (see StubOptions.underscoreRels). */
  setUnderscoreRels(on: boolean): void;
  reset(): void;
  close(): Promise<void>;
}

export function makeDispute(over: Partial<Dispute> & { dispute_id: string }): Dispute {
  return {
    create_time: "2026-10-07T10:00:00.000Z",
    update_time: "2026-10-07T10:00:00.000Z",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_amount: { currency_code: "USD", value: "84.00" },
    dispute_life_cycle_stage: "CHARGEBACK",
    dispute_channel: "INTERNAL",
    seller_response_due_date: "2026-10-17T10:00:00.000Z",
    disputed_transactions: [
      { seller_transaction_id: "8XY12345AB678901C", create_time: "2026-10-02T14:03:00.000Z", gross_amount: { currency_code: "USD", value: "84.00" } },
    ],
    evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", source: "REQUESTED_FROM_SELLER" }],
    messages: [],
    ...over,
  };
}

const ACTIONS_BY_STATUS: Record<string, string[]> = {
  WAITING_FOR_SELLER_RESPONSE: ["provide-evidence", "accept-claim"],
  UNDER_REVIEW: ["require-evidence", "adjudicate"], // VERIFY: which links real sandbox offers here
  OPEN: ["provide-evidence", "accept-claim"],
};

export async function startStub(opts: StubOptions = {}): Promise<Stub> {
  const disputes = new Map<string, Dispute>();
  const calls: StubCall[] = [];
  let base = "";
  let underscoreRels = opts.underscoreRels ?? false;

  const withLinks = (d: Dispute): Dispute => {
    const rel = (r: string) => (underscoreRels ? r.replace(/-/g, "_") : r);
    const self = `${base}/v1/customer/disputes/${d.dispute_id}`;
    const links = [
      { href: self, rel: "self", method: "GET" },
      ...(ACTIONS_BY_STATUS[d.status] ?? []).map((a) => ({ href: `${self}/${a}`, rel: rel(a), method: "POST" })),
    ];
    return { ...d, links };
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => send(res, 500, { name: "INTERNAL_SERVER_ERROR", message: String(e) }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", base);
    const path = url.pathname;
    const method = req.method ?? "GET";
    const raw = await readBody(req);
    const call: StubCall = { method, path };
    calls.push(call);

    if (method === "POST" && path === "/v1/oauth2/token") {
      if (!req.headers.authorization?.startsWith("Basic ")) return send(res, 401, { error: "invalid_client" });
      return send(res, 200, {
        access_token: STUB_TOKEN,
        token_type: "Bearer",
        expires_in: 32400,
        scope: "https://uri.paypal.com/services/disputes/read-seller https://uri.paypal.com/services/disputes/update-seller",
      });
    }
    if (req.headers.authorization !== `Bearer ${STUB_TOKEN}`) return send(res, 401, { name: "AUTHENTICATION_FAILURE" });

    if (method === "POST" && path === "/v1/notifications/verify-webhook-signature") {
      const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      call.input = body;
      const ok = body.transmission_sig === STUB_VALID_SIGNATURE && (!opts.webhookId || body.webhook_id === opts.webhookId);
      return send(res, 200, { verification_status: ok ? "SUCCESS" : "FAILURE" });
    }

    if (method === "GET" && path === "/v1/customer/disputes") {
      const items = [...disputes.values()].map((d) => {
        const full = withLinks(d);
        return pick(full, ["dispute_id", "create_time", "update_time", "reason", "status", "dispute_amount", "dispute_life_cycle_stage", "dispute_channel", "links"]);
      });
      return send(res, 200, { items, links: [] });
    }

    const m = /^\/v1\/customer\/disputes\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
    if (!m) return send(res, 404, { name: "RESOURCE_NOT_FOUND", message: path });
    const id = decodeURIComponent(m[1]!);
    const action = m[2];
    const d = disputes.get(id);
    if (!d) return send(res, 404, { name: "RESOURCE_NOT_FOUND", message: `dispute ${id}` });

    if (method === "GET" && !action) return send(res, 200, withLinks(d));
    if (method !== "POST" || !action) return send(res, 405, { name: "METHOD_NOT_SUPPORTED" });

    const offered = ACTIONS_BY_STATUS[d.status] ?? [];
    if (!offered.includes(action)) {
      return send(res, 422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ACTION_NOT_ALLOWED", description: `${action} not allowed in ${d.status}` }] });
    }

    if (action === "provide-evidence") {
      const ct = req.headers["content-type"] ?? "";
      if (!ct.startsWith("multipart/")) return send(res, 415, { name: "UNSUPPORTED_MEDIA_TYPE" });
      const form = await new Response(new Uint8Array(raw), { headers: { "content-type": ct } }).formData();
      const files: NonNullable<StubCall["files"]> = [];
      let input: unknown;
      for (const [part, value] of form.entries()) {
        if (typeof value === "string") continue;
        if (part === "input") input = JSON.parse(await value.text());
        else files.push({ part, filename: (value as File).name, type: value.type, size: value.size });
      }
      call.input = input;
      call.files = files;
      const evidences = (input as { evidences?: Record<string, unknown>[] } | undefined)?.evidences;
      if (!Array.isArray(evidences) || evidences.length === 0) {
        return send(res, 400, { name: "INVALID_REQUEST", details: [{ field: "evidences", issue: "MISSING_REQUIRED_PARAMETER" }] });
      }
      // VERIFY: real post-submission status. Docs: evidence is reviewed by PayPal.
      d.status = "UNDER_REVIEW";
      d.evidences = [
        ...((d.evidences as unknown[]) ?? []),
        ...evidences.map((e) => ({ ...e, source: "SUBMITTED_BY_SELLER", date: new Date().toISOString() })),
      ];
      d.update_time = new Date().toISOString();
      return send(res, 200, { links: [{ href: `${base}/v1/customer/disputes/${id}`, rel: "up", method: "GET" }] });
    }

    if (action === "require-evidence") {
      const body = JSON.parse(raw.toString("utf8") || "{}") as { action?: string };
      call.input = body;
      if (body.action === "SELLER_EVIDENCE") d.status = "WAITING_FOR_SELLER_RESPONSE";
      else if (body.action === "BUYER_EVIDENCE") d.status = "WAITING_FOR_BUYER_RESPONSE";
      else return send(res, 400, { name: "INVALID_REQUEST" });
      return send(res, 200, { links: [] });
    }

    if (action === "adjudicate") {
      const body = JSON.parse(raw.toString("utf8") || "{}") as { adjudication_outcome?: string };
      call.input = body;
      const outcome = { SELLER_FAVOR: "RESOLVED_SELLER_FAVOUR", BUYER_FAVOR: "RESOLVED_BUYER_FAVOUR" }[body.adjudication_outcome ?? ""];
      if (!outcome) return send(res, 400, { name: "INVALID_REQUEST" });
      d.status = "RESOLVED";
      d.dispute_outcome = { outcome_code: outcome };
      return send(res, 200, { links: [] });
    }

    return send(res, 422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "NOT_IMPLEMENTED_IN_STUB" }] });
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    calls,
    setDispute: (d) => void disputes.set(d.dispute_id, structuredClone(d)),
    getDispute: (id) => {
      const d = disputes.get(id);
      return d ? withLinks(d) : undefined;
    },
    setUnderscoreRels: (on) => {
      underscoreRels = on;
    },
    reset: () => {
      underscoreRels = opts.underscoreRels ?? false;
      disputes.clear();
      calls.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections(); // fetch keeps connections alive; don't wait for them
      }),
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  // connection: close keeps tests deterministic: no idle keep-alive socket for
  // the client to reuse just as the server times it out.
  res.writeHead(status, { "content-type": "application/json", "paypal-debug-id": `stub-${Date.now().toString(36)}`, connection: "close" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function pick<T extends Record<string, unknown>>(o: T, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
}
