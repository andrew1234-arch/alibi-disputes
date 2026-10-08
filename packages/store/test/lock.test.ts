import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSql } from "../src/sql";

describe("on-disk PGlite lock", () => {
  it("refuses to open a data directory another live process holds", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "alibi-lock-")), "db");
    writeFileSync(`${dir}.alibi-lock`, String(process.ppid)); // the test runner's parent: alive, not us
    expect(() => createSql(`pglite://${dir}`)).toThrow(/in use by process/);
  });
});
