// Idempotent schema (SPEC §6.4). Applied at startup by migrate().
// The case file (evidence records, checklist, draft, removed-by-verifier) is one
// JSONB document per dispute; approvals, submissions, webhook events and
// activity are separate tables because they carry the safety guarantees.
export const SCHEMA = `
create table if not exists cases (
  dispute_id     text primary key,
  case_file      jsonb not null,
  paypal_status  text not null,
  updated_at     timestamptz not null default now()
);

-- Append-only audit of every approval. The live approval is case_file.approval.
create table if not exists approvals (
  id           bigserial primary key,
  dispute_id   text not null,
  draft_hash   text not null,
  approved_at  timestamptz not null
);

create table if not exists submissions (
  id                   bigserial primary key,
  dispute_id           text not null,
  draft_hash           text not null,
  -- superseded: succeeded earlier, then PayPal asked for evidence again (a new round).
  state                text not null check (state in ('pending', 'succeeded', 'failed', 'superseded')),
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,
  paypal_status_after  text,
  paypal_debug_id      text,
  error                text
);
-- Databases created before 'superseded' existed: widen the state check, once.
-- Guarded by a catalog check so normal startups take no table lock.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'submissions_state_check' and pg_get_constraintdef(oid) like '%superseded%'
  ) then
    alter table submissions drop constraint if exists submissions_state_check;
    alter table submissions add constraint submissions_state_check check (state in ('pending', 'succeeded', 'failed', 'superseded'));
  end if;
end $$;

-- At most one in-flight or successful submission per dispute: a double click,
-- two tabs or a retried request can never send evidence twice.
create unique index if not exists submissions_one_live
  on submissions (dispute_id) where state in ('pending', 'succeeded');

-- PayPal retries webhooks; the primary key makes processing idempotent.
create table if not exists webhook_events (
  event_id     text primary key,
  event_type   text not null,
  received_at  timestamptz not null default now(),
  payload      jsonb not null
);

-- Durable case-rebuild queue. A webhook only has to get a row in here; the
-- worker retries with backoff, across restarts, and deletes the row only once
-- the rebuild for that queueing has succeeded.
create table if not exists pending_rebuilds (
  dispute_id       text primary key,
  queued_at        timestamptz not null default now(),
  version          integer not null default 1, -- bumped on every re-queue
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text
);

-- Small key/value state, e.g. when the last successful dispute poll started.
create table if not exists app_state (
  key    text primary key,
  value  text not null
);

-- "Generic AI reply" comparisons (SPEC §5.6), cached per case and input so the
-- public demo spends at most one LLM call per case, not one per page view.
create table if not exists comparisons (
  dispute_id  text not null,
  key         text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (dispute_id, key)
);

create table if not exists activity (
  id          bigserial primary key,
  dispute_id  text,
  at          timestamptz not null default now(),
  step        text not null,
  detail      jsonb not null default '{}'::jsonb
);
create index if not exists activity_by_dispute on activity (dispute_id, id);

-- Which synthetic demo-merchant scenario is linked to which real sandbox transaction.
create table if not exists demo_links (
  scenario        text primary key,
  transaction_id  text not null unique,
  linked_at       timestamptz not null default now()
);
`;
