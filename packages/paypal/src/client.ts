import type { z } from "zod";
import type { PaypalEnv } from "@alibi/core";
import { PaypalError, PaypalResponseShapeError } from "./errors.js";
import { resolveBaseUrl } from "./host.js";
import { tokenResponseSchema } from "./schemas.js";

// Low-level HTTP client shared by read/write/sandbox surfaces. Not exported from
// any package entry point: consumers get only the surface they are allowed.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PaypalClientOptions {
  fetch?: FetchLike;
  /** Delay between GET retries; injectable so tests don't sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RequestSpec<S extends z.ZodType> {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  schema: S;
  /** Extra headers (never Authorization — the client owns that). */
  headers?: Record<string, string>;
}

export interface RawResult {
  status: number;
  debugId: string | undefined;
  body: unknown;
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_GET_ATTEMPTS = 3;

export class PaypalClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number; scope: string | undefined } | undefined;

  constructor(
    private readonly env: PaypalEnv,
    opts: PaypalClientOptions = {},
  ) {
    this.baseUrl = resolveBaseUrl(env.PAYPAL_API_BASE, env.PAYPAL_TEST_MODE);
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** Client-credentials token, cached until 60 s before expiry. */
  async getToken(): Promise<{ accessToken: string; scope: string | undefined }> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) {
      return { accessToken: this.token.value, scope: this.token.scope };
    }
    const basic = Buffer.from(`${this.env.PAYPAL_CLIENT_ID}:${this.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const body = await readBody(res);
    if (!res.ok) throw toPaypalError("POST /v1/oauth2/token", res, body);
    const parsed = parseOrThrow("POST /v1/oauth2/token", tokenResponseSchema, body);
    this.token = {
      value: parsed.access_token,
      expiresAt: this.now() + parsed.expires_in * 1000,
      scope: parsed.scope,
    };
    return { accessToken: parsed.access_token, scope: parsed.scope };
  }

  /** JSON request validated against `schema`. GETs retry on 429/5xx; writes never retry. */
  async request<S extends z.ZodType>(spec: RequestSpec<S>): Promise<{ data: z.infer<S>; raw: RawResult }> {
    const endpoint = `${spec.method} ${spec.path}`;
    const url = new URL(spec.path, this.baseUrl);
    for (const [k, v] of Object.entries(spec.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const attempts = spec.method === "GET" ? MAX_GET_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt++) {
      const { accessToken } = await this.getToken();
      const res = await this.fetchImpl(url.toString(), {
        method: spec.method,
        headers: {
          ...spec.headers,
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...(spec.json !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(spec.json !== undefined ? { body: JSON.stringify(spec.json) } : {}),
      });
      const body = await readBody(res);
      if (!res.ok) {
        if (attempt < attempts && RETRY_STATUSES.has(res.status)) {
          await this.sleep(250 * 2 ** (attempt - 1));
          continue;
        }
        throw toPaypalError(endpoint, res, body);
      }
      const raw = { status: res.status, debugId: res.headers.get("paypal-debug-id") ?? undefined, body };
      return { data: parseOrThrow(endpoint, spec.schema, body), raw };
    }
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toPaypalError(endpoint: string, res: Response, body: unknown): PaypalError {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name : typeof b.error === "string" ? b.error : undefined;
  const msg =
    typeof b.message === "string" ? b.message : typeof b.error_description === "string" ? b.error_description : "";
  const debugId = res.headers.get("paypal-debug-id") ?? (typeof b.debug_id === "string" ? b.debug_id : undefined);
  return new PaypalError(`${endpoint} failed: ${res.status} ${name ?? ""} ${msg}`.trim(), res.status, debugId, name, b.details);
}

function parseOrThrow<S extends z.ZodType>(endpoint: string, schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new PaypalResponseShapeError(endpoint, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  return r.data;
}
