// Host guard (CLAUDE §1.4): sandbox only. The single exception is
// PAYPAL_TEST_MODE=true, which may point at the local test stub — and only at a
// loopback host, so a typo can never send test traffic somewhere real.

export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function resolveBaseUrl(base: string, testMode: boolean): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`PAYPAL_API_BASE is not a valid URL`);
  }
  const normalised = url.origin;
  if (normalised === SANDBOX_BASE && url.pathname.replace(/\/+$/, "") === "") return SANDBOX_BASE;
  if (testMode && LOOPBACK.has(url.hostname)) return normalised;
  throw new Error(
    `Refusing PayPal base URL ${normalised}: only ${SANDBOX_BASE} is allowed` +
      (testMode ? " (test mode allows loopback hosts only)" : ""),
  );
}
