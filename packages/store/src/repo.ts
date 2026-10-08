import type { CaseFile } from "@alibi/core";
import { SCHEMA } from "./schema";
import type { Sql } from "./sql";

// Repository over Sql. Every method is one statement or one transaction; the
// approval gate's guarantees live here (beginSubmission) and in the schema.

export interface ActivityEntry {
  id: number;
  disputeId: string | null;
  at: string;
  step: string;
  detail: Record<string, unknown>;
}

export interface SubmissionRow {
  id: number;
  disputeId: string;
  draftHash: string;
  state: "pending" | "succeeded" | "failed" | "superseded";
  startedAt: string;
  finishedAt: string | null;
  paypalStatusAfter: string | null;
  paypalDebugId: string | null;
  error: string | null;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown) => (v == null ? null : iso(v));

async function queueRebuildIn(q: Pick<Sql, "query">, disputeId: string): Promise<void> {
  await q.query(
    `insert into pending_rebuilds (dispute_id) values ($1)
     on conflict (dispute_id) do update set queued_at = now(), version = pending_rebuilds.version + 1,
       attempts = 0, next_attempt_at = now(), last_error = null`,
    [disputeId],
  );
}

async function updateCaseIn(
  tx: Sql,
  disputeId: string,
  fn: (prev: CaseFile | undefined) => CaseFile | Promise<CaseFile>,
): Promise<CaseFile> {
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [disputeId]);
  const { rows } = await tx.query<{ case_file: CaseFile }>(`select case_file from cases where dispute_id = $1 for update`, [disputeId]);
  const next = await fn(rows[0]?.case_file);
  if (next.disputeId !== disputeId) throw new Error(`updateCase: dispute id changed (${disputeId} → ${next.disputeId})`);
  await tx.query(
    `insert into cases (dispute_id, case_file, paypal_status, updated_at) values ($1, $2, $3, now())
     on conflict (dispute_id) do update set case_file = excluded.case_file, paypal_status = excluded.paypal_status, updated_at = now()`,
    [disputeId, JSON.stringify(next), next.status],
  );
  return next;
}

export function createRepo(sql: Sql) {
  return {
    migrate: () => sql.exec(SCHEMA),

    async saveCase(cf: CaseFile): Promise<void> {
      await sql.query(
        `insert into cases (dispute_id, case_file, paypal_status, updated_at) values ($1, $2, $3, now())
         on conflict (dispute_id) do update set case_file = excluded.case_file, paypal_status = excluded.paypal_status, updated_at = now()`,
        [cf.disputeId, JSON.stringify(cf), cf.status],
      );
    },

    /**
     * Read-modify-write of one case under a lock, so concurrent writers (a
     * webhook rebuild, an approval, a submit) each see the others' changes
     * instead of overwriting them with a stale copy. `fn` must be quick and
     * do no network I/O. The advisory lock also covers the not-yet-inserted
     * case; `for update` waits for approve()'s row lock.
     */
    async updateCase(disputeId: string, fn: (prev: CaseFile | undefined) => CaseFile): Promise<CaseFile> {
      return sql.transaction((tx) => updateCaseIn(tx, disputeId, fn));
    },

    /**
     * PayPal accepted: mark the submission succeeded AND write it into the
     * case file in one transaction. Either both land or neither does (the row
     * then stays 'pending', which keeps blocking a resend). New-round
     * detection reads case.submission, so the two must never disagree.
     */
    async recordSubmissionSuccess(
      submissionId: number,
      disputeId: string,
      result: { paypalStatusAfter: string; paypalDebugId?: string },
      fn: (prev: CaseFile | undefined) => CaseFile,
    ): Promise<void> {
      await sql.transaction(async (tx) => {
        await tx.query(
          `update submissions set state = 'succeeded', finished_at = now(), paypal_status_after = $2, paypal_debug_id = $3
           where id = $1 and state = 'pending'`,
          [submissionId, result.paypalStatusAfter, result.paypalDebugId ?? null],
        );
        await updateCaseIn(tx, disputeId, fn);
      });
    },

    async getCase(disputeId: string): Promise<CaseFile | undefined> {
      const { rows } = await sql.query<{ case_file: CaseFile }>(`select case_file from cases where dispute_id = $1`, [disputeId]);
      return rows[0]?.case_file;
    },

    async listCases(): Promise<CaseFile[]> {
      const { rows } = await sql.query<{ case_file: CaseFile }>(`select case_file from cases order by updated_at desc`);
      return rows.map((r) => r.case_file);
    },

    /**
     * Records the merchant's approval of a specific draft hash. Returns false
     * (and stores nothing) if the case's current draft no longer has that hash,
     * so an approval given in a stale tab can't attach to newer content.
     */
    async approve(disputeId: string, draftHash: string, currentHash: (cf: CaseFile) => string, at: Date): Promise<boolean> {
      return sql.transaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [disputeId]);
        const { rows } = await tx.query<{ case_file: CaseFile }>(`select case_file from cases where dispute_id = $1 for update`, [disputeId]);
        const cf = rows[0]?.case_file;
        if (!cf || currentHash(cf) !== draftHash) return false;
        const updated: CaseFile = { ...cf, approval: { approvedAt: at.toISOString(), draftHash } };
        await tx.query(`update cases set case_file = $2, updated_at = now() where dispute_id = $1`, [disputeId, JSON.stringify(updated)]);
        await tx.query(`insert into approvals (dispute_id, draft_hash, approved_at) values ($1, $2, $3)`, [disputeId, draftHash, at.toISOString()]);
        return true;
      });
    },

    /**
     * Claims the right to submit. Returns the submission id, undefined if one
     * is in flight or already succeeded, or "approval_changed" if
     * `stillApproved` rejects the case as stored right now.
     *
     * The approval check and the claim happen under the same case lock that
     * approve() and updateCase() take, so an edit or rebuild that lapses the
     * approval either lands before the claim (and is seen) or waits for it.
     */
    async beginSubmission(
      disputeId: string,
      draftHash: string,
      stillApproved?: (cf: CaseFile | undefined) => boolean,
    ): Promise<number | undefined | "approval_changed"> {
      return sql.transaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [disputeId]);
        if (stillApproved) {
          const { rows } = await tx.query<{ case_file: CaseFile }>(`select case_file from cases where dispute_id = $1 for update`, [disputeId]);
          if (!stillApproved(rows[0]?.case_file)) return "approval_changed" as const;
        }
        const { rows } = await tx.query<{ id: number }>(
          `insert into submissions (dispute_id, draft_hash, state) values ($1, $2, 'pending')
           on conflict (dispute_id) where state in ('pending', 'succeeded') do nothing
           returning id`,
          [disputeId, draftHash],
        );
        return rows[0] ? Number(rows[0].id) : undefined;
      });
    },

    async finishSubmission(
      id: number,
      result: { state: "succeeded"; paypalStatusAfter: string; paypalDebugId?: string } | { state: "failed"; error: string; paypalDebugId?: string },
    ): Promise<void> {
      await sql.query(
        `update submissions set state = $2, finished_at = now(), paypal_status_after = $3, paypal_debug_id = $4, error = $5
         where id = $1 and state = 'pending'`,
        [
          id,
          result.state,
          result.state === "succeeded" ? result.paypalStatusAfter : null,
          result.paypalDebugId ?? null,
          result.state === "failed" ? result.error : null,
        ],
      );
    },

    /**
     * Merges a freshly built case into the stored one, in ONE transaction under
     * the case lock, so the slot and the case file can't disagree:
     *
     *  1. Reconcile: if PayPal now shows `acceptedStatus` and a submission has
     *     sat 'pending' longer than `reconcileAfterMs` (an ambiguous send we
     *     couldn't confirm), our evidence landed: mark it succeeded and put it
     *     on the case before merging.
     *  2. `merge(prev)` returns the case to store and whether this is a new
     *     evidence round.
     *  3. New round: succeeded submissions become 'superseded', freeing the slot
     *     in the same commit that drops the old approval. Nothing in between
     *     can submit the old round's draft.
     */
    async applyRebuild(
      disputeId: string,
      nextStatus: string,
      merge: (prev: CaseFile | undefined) => { caseFile: CaseFile; newRound: boolean },
      opts: { acceptedStatus: string; reconcileAfterMs: number },
    ): Promise<{ caseFile: CaseFile; newRound: boolean; reconciled: boolean }> {
      return sql.transaction(async (tx) => {
        let reconciled = false;
        let newRound = false;
        const caseFile = await updateCaseIn(tx, disputeId, async (stored) => {
          let prev = stored;
          if (nextStatus === opts.acceptedStatus) {
            const { rows } = await tx.query<{ started_at: unknown }>(
              `update submissions set state = 'succeeded', finished_at = now(), paypal_status_after = $2
               where dispute_id = $1 and state = 'pending' and started_at < now() - ($3 || ' milliseconds')::interval
               returning started_at`,
              [disputeId, opts.acceptedStatus, String(opts.reconcileAfterMs)],
            );
            if (rows[0] && prev) {
              reconciled = true;
              prev = { ...prev, submission: { submittedAt: iso(rows[0].started_at), paypalStatusAfter: opts.acceptedStatus } };
            }
          }
          const merged = merge(prev);
          newRound = merged.newRound;
          if (newRound) await tx.query(`update submissions set state = 'superseded' where dispute_id = $1 and state = 'succeeded'`, [disputeId]);
          return merged.caseFile;
        });
        return { caseFile, newRound, reconciled };
      });
    },

    /**
     * Operator resolution of a submission left 'pending' (OUTCOME_UNKNOWN or
     * SUBMITTED_NOT_RECORDED), after checking the dispute in PayPal:
     *   received     → succeeded, written onto the case (blocks a resend);
     *   not_received → failed, which frees the slot for a fresh submit.
     * Returns false if there's no pending submission.
     */
    async resolvePendingSubmission(disputeId: string, outcome: "received" | "not_received", paypalStatus: string): Promise<boolean> {
      return sql.transaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [disputeId]);
        const { rows } = await tx.query<{ started_at: unknown }>(
          outcome === "received"
            ? `update submissions set state = 'succeeded', finished_at = now(), paypal_status_after = $2, error = null
               where dispute_id = $1 and state = 'pending' returning started_at`
            : `update submissions set state = 'failed', finished_at = now(), error = 'operator: PayPal did not receive it (status ' || $2 || ')'
               where dispute_id = $1 and state = 'pending' returning started_at`,
          [disputeId, paypalStatus],
        );
        const row = rows[0];
        if (!row) return false;
        if (outcome === "received") {
          await updateCaseIn(tx, disputeId, (prev) => {
            if (!prev) throw new Error(`no case for ${disputeId}`);
            return { ...prev, submission: { submittedAt: iso(row.started_at), paypalStatusAfter: paypalStatus } };
          });
        }
        return true;
      });
    },

    async listSubmissions(disputeId: string): Promise<SubmissionRow[]> {
      const { rows } = await sql.query<Record<string, unknown>>(`select * from submissions where dispute_id = $1 order by id`, [disputeId]);
      return rows.map((r) => ({
        id: Number(r.id),
        disputeId: String(r.dispute_id),
        draftHash: String(r.draft_hash),
        state: r.state as SubmissionRow["state"],
        startedAt: iso(r.started_at),
        finishedAt: isoOrNull(r.finished_at),
        paypalStatusAfter: (r.paypal_status_after as string | null) ?? null,
        paypalDebugId: (r.paypal_debug_id as string | null) ?? null,
        error: (r.error as string | null) ?? null,
      }));
    },

    /**
     * True if this event id is new; false if PayPal is retrying one we've seen.
     * With `queueDisputeId`, the rebuild is queued in the SAME transaction, so
     * a crash can never leave an event marked processed with nothing queued.
     */
    async recordWebhookEvent(eventId: string, eventType: string, payload: unknown, queueDisputeId?: string): Promise<boolean> {
      return sql.transaction(async (tx) => {
        const { rows } = await tx.query(
          `insert into webhook_events (event_id, event_type, payload) values ($1, $2, $3) on conflict (event_id) do nothing returning event_id`,
          [eventId, eventType, JSON.stringify(payload)],
        );
        if (rows.length === 1 && queueDisputeId) await queueRebuildIn(tx, queueDisputeId);
        return rows.length === 1;
      });
    },

    /** Queue (or re-queue) a rebuild. A newer queueing resets the backoff. */
    async queueRebuild(disputeId: string): Promise<void> {
      await queueRebuildIn(sql, disputeId);
    },

    async dueRebuilds(limit = 10): Promise<{ disputeId: string; version: number; attempts: number }[]> {
      const { rows } = await sql.query<{ dispute_id: string; version: number; attempts: number }>(
        `select dispute_id, version, attempts from pending_rebuilds where next_attempt_at <= now() order by next_attempt_at limit $1`,
        [limit],
      );
      return rows.map((r) => ({ disputeId: r.dispute_id, version: Number(r.version), attempts: Number(r.attempts) }));
    },

    /** Done, unless it was queued again while we worked (then the newer request still runs). */
    async rebuildDone(disputeId: string, version: number): Promise<void> {
      await sql.query(`delete from pending_rebuilds where dispute_id = $1 and version = $2`, [disputeId, version]);
    },

    /** Back off this queueing. A newer queueing (higher version) keeps its own fresh schedule. */
    async rebuildFailed(disputeId: string, version: number, error: string, retryInMs: number): Promise<void> {
      await sql.query(
        `update pending_rebuilds set attempts = attempts + 1, last_error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval
         where dispute_id = $1 and version = $2`,
        [disputeId, version, error, String(Math.round(retryInMs))],
      );
    },

    async logActivity(disputeId: string | null, step: string, detail: Record<string, unknown> = {}): Promise<void> {
      await sql.query(`insert into activity (dispute_id, step, detail) values ($1, $2, $3)`, [disputeId, step, JSON.stringify(detail)]);
    },

    async listActivity(disputeId?: string, limit = 100): Promise<ActivityEntry[]> {
      const { rows } = await sql.query<Record<string, unknown>>(
        disputeId
          ? `select * from activity where dispute_id = $1 order by id desc limit $2`
          : `select * from activity order by id desc limit $1`,
        disputeId ? [disputeId, limit] : [limit],
      );
      return rows.map((r) => ({
        id: Number(r.id),
        disputeId: (r.dispute_id as string | null) ?? null,
        at: iso(r.at),
        step: String(r.step),
        detail: r.detail as Record<string, unknown>,
      }));
    },

    /** Links a scenario to a transaction. A transaction belongs to one scenario, so re-linking it moves it. */
    async setDemoLink(scenario: string, transactionId: string): Promise<void> {
      await sql.transaction(async (tx) => {
        await tx.query(`delete from demo_links where transaction_id = $1 and scenario <> $2`, [transactionId, scenario]);
        await tx.query(
          `insert into demo_links (scenario, transaction_id) values ($1, $2)
           on conflict (scenario) do update set transaction_id = excluded.transaction_id, linked_at = now()`,
          [scenario, transactionId],
        );
      });
    },

    async listDemoLinks(): Promise<{ scenario: string; transactionId: string }[]> {
      const { rows } = await sql.query<{ scenario: string; transaction_id: string }>(`select scenario, transaction_id from demo_links order by scenario`);
      return rows.map((r) => ({ scenario: r.scenario, transactionId: r.transaction_id }));
    },

    /** Demo reset: forget local submissions/approvals for these disputes so they can be re-run. */
    async resetDisputes(disputeIds: string[]): Promise<void> {
      await sql.transaction(async (tx) => {
        await tx.query(`delete from submissions where dispute_id = any($1)`, [disputeIds]);
        await tx.query(`delete from approvals where dispute_id = any($1)`, [disputeIds]);
        await tx.query(`delete from cases where dispute_id = any($1)`, [disputeIds]);
        await tx.query(`delete from activity where dispute_id = any($1)`, [disputeIds]);
        await tx.query(`delete from pending_rebuilds where dispute_id = any($1)`, [disputeIds]);
      });
    },
  };
}
export type Repo = ReturnType<typeof createRepo>;
