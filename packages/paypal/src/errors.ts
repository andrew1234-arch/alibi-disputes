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
