// Deadline math (SPEC §5.3 step 4).
//
// PayPal due dates are ISO 8601 instants. We only accept strings with an
// explicit zone ("Z" or ±hh:mm): a bare "2026-10-20T23:59:59" could mean any
// of 38 offsets, and a wrong guess shows the merchant the wrong countdown.
//
// Worked example:
//   dueAt = "2026-10-20T23:59:59-07:00"  (= 2026-10-21T06:59:59Z)
//   now   = "2026-10-20T08:00:00Z"
//   hoursLeft = (06:59:59 next day − 08:00:00) = 22h 59m 59s ≈ 22.9997
//   warnHours = 72 → state "urgent".

export type DeadlineState =
  | { kind: "unknown"; reason: string }
  | { kind: "overdue"; hoursLeft: number }
  | { kind: "urgent"; hoursLeft: number }
  | { kind: "ok"; hoursLeft: number };

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

export function parseInstant(iso: string): number | undefined {
  if (!ISO_WITH_ZONE.test(iso.trim())) return undefined;
  const t = Date.parse(iso.trim());
  return Number.isNaN(t) ? undefined : t;
}

export function hoursLeft(dueAt: string, now: Date): number | undefined {
  const due = parseInstant(dueAt);
  return due === undefined ? undefined : (due - now.getTime()) / 3_600_000;
}

export function deadlineState(dueAt: string | undefined, now: Date, warnHours: number): DeadlineState {
  if (!dueAt) return { kind: "unknown", reason: "PayPal did not return a response due date." };
  const h = hoursLeft(dueAt, now);
  if (h === undefined) return { kind: "unknown", reason: `Unrecognised due date "${dueAt}" (needs a time zone).` };
  if (h <= 0) return { kind: "overdue", hoursLeft: h };
  if (h < warnHours) return { kind: "urgent", hoursLeft: h };
  return { kind: "ok", hoursLeft: h };
}
