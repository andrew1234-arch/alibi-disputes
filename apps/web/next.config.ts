import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Internal packages ship TypeScript source (see docs/DECISIONS.md, ADR-002).
  transpilePackages: ["@alibi/core", "@alibi/paypal", "@alibi/casefile", "@alibi/agent", "@alibi/merchant"],
};

export default nextConfig;
