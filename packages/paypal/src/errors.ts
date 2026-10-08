export class PaypalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** PayPal-Debug-Id header — safe to log, needed when asking PayPal for help. */
    readonly debugId: string | undefined,
    /** PayPal's error `name` (e.g. UNPROCESSABLE_ENTITY), if the body had one. */
    readonly errorName: string | undefined,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "PaypalError";
  }
}

export class PaypalResponseShapeError extends Error {
  constructor(
    readonly endpoint: string,
    readonly issues: string[],
  ) {
    super(`Unexpected PayPal response shape from ${endpoint}:\n  ${issues.join("\n  ")}`);
    this.name = "PaypalResponseShapeError";
  }
}

/** The request got no HTTP response. For a write, PayPal may or may not have received it. */
export class PaypalNetworkError extends Error {
  constructor(
    readonly endpoint: string,
    override readonly cause: unknown,
  ) {
    super(`${endpoint}: no response from PayPal (${cause instanceof Error ? cause.message : String(cause)})`);
    this.name = "PaypalNetworkError";
  }
}

/**
 * The request was never sent: getting the OAuth token failed first (network,
 * HTTP error or unexpected token body). Unlike PaypalNetworkError on a write,
 * this is never ambiguous: PayPal cannot have received the request.
 */
export class PaypalNotSentError extends Error {
  constructor(
    readonly endpoint: string,
    override readonly cause: unknown,
  ) {
    super(`${endpoint}: not sent, couldn't get a PayPal access token (${cause instanceof Error ? cause.message : String(cause)})`);
    this.name = "PaypalNotSentError";
  }

  get paypalError(): PaypalError | undefined {
    return this.cause instanceof PaypalError ? this.cause : undefined;
  }
}
