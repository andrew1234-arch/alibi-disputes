import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Internal packages ship TypeScript source (see docs/DECISIONS.md, ADR-002).
  transpilePackages: ["@alibi/core", "@alibi/paypal", "@alibi/casefile", "@alibi/agent", "@alibi/merchant", "@alibi/store"],
  // Native/WASM database drivers are loaded by Node at runtime, not bundled.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default nextConfig;
