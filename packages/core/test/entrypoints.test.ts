import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// apps/web transpiles @alibi/core into client bundles. A Node built-in anywhere
// in the root entry's import graph breaks `next build` the first time a client
// component imports from it.

const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/g;

function graph(entry: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(entry)) return seen;
  const code = readFileSync(entry, "utf8");
  const specs = [...code.matchAll(IMPORT)]
    .filter((m) => !/^\s*(import|export)\s+type\b/.test(m[0])) // type-only imports are erased
    .map((m) => m[1]!);
  seen.set(entry, specs);
  for (const s of specs) if (s.startsWith(".")) graph(resolve(dirname(entry), s.replace(/\.js$/, ".ts")), seen);
  return seen;
}

describe("entry points", () => {
  it("@alibi/core (root) imports no Node built-ins", () => {
    const offenders = [...graph(join(src, "index.ts"))].flatMap(([file, specs]) =>
      specs.filter((s) => s.startsWith("node:")).map((s) => `${file.replace(src, "src")} → ${s}`),
    );
    expect(offenders).toEqual([]);
  });

  it("@alibi/core/server carries the hashing code", () => {
    const files = [...graph(join(src, "server.ts")).keys()].map((f) => f.replace(src + "/", ""));
    expect(files).toEqual(expect.arrayContaining(["hash.ts", "evidence.ts", "verify.ts"]));
  });
});
