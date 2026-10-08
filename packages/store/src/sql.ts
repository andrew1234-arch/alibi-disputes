import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

// Minimal SQL surface shared by node-postgres (production, Render Postgres)
// and PGlite (tests and local dev without a Postgres server).
//
//   DATABASE_URL=postgres://…        → pg Pool
//   DATABASE_URL=pglite://memory     → in-memory PGlite (tests)
//   DATABASE_URL=pglite://./.data/db → PGlite persisted on disk (local dev only;
//                                      container disks are ephemeral, so never in production)

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<void>;
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createSql(databaseUrl: string): Sql {
  if (databaseUrl.startsWith("pglite://")) {
    const target = databaseUrl.slice("pglite://".length);
    if (target === "memory" || target === "") return pgliteSql(new PGlite());
    const release = lockPgliteDir(target);
    const sql = pgliteSql(new PGlite(target));
    return { ...sql, close: () => sql.close().finally(release) };
  }
  return pgSql(new pg.Pool({ connectionString: databaseUrl, max: 5 }));
}

function pgliteSql(db: PGlite): Sql {
  const wrap = (q: Pick<PGlite, "query" | "exec">): Omit<Sql, "transaction" | "close"> => ({
    query: async <T>(text: string, params?: unknown[]) => ({ rows: (await q.query<T>(text, params)).rows }),
    exec: async (text: string) => void (await q.exec(text)),
  });
  return {
    ...wrap(db),
    transaction: (fn) => db.transaction((tx) => fn({ ...wrap(tx), transaction: () => Promise.reject(new Error("nested transaction")), close: async () => {} })),
    close: () => db.close(),
  };
}

function pgSql(pool: pg.Pool): Sql {
  return {
    query: async <T>(text: string, params?: unknown[]) => ({ rows: (await pool.query(text, params)).rows as T[] }),
    exec: async (text) => void (await pool.query(text)),
    transaction: async (fn) => {
      const client = await pool.connect();
      let released = false;
      try {
        await client.query("BEGIN");
        const tx: Sql = {
          query: async <T>(text: string, params?: unknown[]) => ({ rows: (await client.query(text, params)).rows as T[] }),
          exec: async (text) => void (await client.query(text)),
          transaction: () => Promise.reject(new Error("nested transaction")),
          close: async () => {},
        };
        const out = await fn(tx);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        // Keep the original error; if ROLLBACK fails too the connection is
        // broken, so destroy it instead of returning it to the pool.
        const rollbackError = await client.query("ROLLBACK").then(
          () => undefined,
          (r: unknown) => (r instanceof Error ? r : new Error(String(r))),
        );
        client.release(rollbackError);
        released = true;
        throw e;
      } finally {
        if (!released) client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * PGlite on disk supports one process at a time; a second opener can corrupt
 * it. A pid file next to the data directory makes the second opener fail with
 * a clear message instead. A lock left by a dead process is taken over.
 *
 * Example: `pnpm web:dev` holds ./.data/db; `pnpm seed:demo` with the same
 * DATABASE_URL then fails with "…in use by process 4242…".
 */
function lockPgliteDir(dir: string): () => void {
  const lockFile = `${dir.replace(/\/+$/, "")}.alibi-lock`;
  try {
    writeFileSync(lockFile, String(process.pid), { flag: "wx" });
  } catch {
    const holder = Number(readFileSync(lockFile, "utf8").trim());
    if (holder && holder !== process.pid && isAlive(holder)) {
      throw new Error(
        `The local database ${dir} is in use by process ${holder}. PGlite allows one process at a time: stop it (e.g. pnpm web:dev) first, or use a Postgres DATABASE_URL.`,
      );
    }
    writeFileSync(lockFile, String(process.pid)); // stale lock from a dead process
  }
  const release = () => {
    try {
      if (readFileSync(lockFile, "utf8").trim() === String(process.pid)) rmSync(lockFile);
    } catch {
      // already gone
    }
  };
  process.once("exit", release);
  return release;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}
