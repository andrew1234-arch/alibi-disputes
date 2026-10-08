import { parseEnv, paypalEnvSchema } from "@alibi/core";
import { createRepo, createSql } from "@alibi/store";
import { z } from "zod";

// Shared setup for operator scripts. Never prints secrets.

export const args = process.argv.slice(2);
export const flag = (name: string) => args.includes(name);
export const options = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));

export function scriptEnv() {
  try {
    return parseEnv(paypalEnvSchema.extend({ DATABASE_URL: z.string().min(1, "is required") }), process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    console.error("\nSet the PayPal sandbox credentials and DATABASE_URL in .env (see .env.example).");
    process.exit(1);
  }
}

export async function openRepo(databaseUrl: string) {
  const sql = createSql(databaseUrl);
  const repo = createRepo(sql);
  await repo.migrate();
  return { repo, close: () => sql.close() };
}
