/**
 * Working-day (Mon-Fri) arithmetic for the Planning Gantt. Mirrors the
 * server-side helpers in `src/planning/scheduler.ts`.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseISODate(iso: string): Date {
  if (!ISO_DATE_RE.test(iso)) throw new Error(`invalid ISO date '${iso}'`);
  const parts = iso.split("-").map((s) => parseInt(s, 10));
  return new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!));
}

export function formatISODate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

export function nextBusinessDay(d: Date): Date {
  const out = new Date(d.getTime());
  while (isWeekend(out)) out.setUTCDate(out.getUTCDate() + 1);
  return out;
}

export function prevBusinessDay(d: Date): Date {
  const out = new Date(d.getTime());
  while (isWeekend(out)) out.setUTCDate(out.getUTCDate() - 1);
  return out;
}

export function addBusinessDays(d: Date, n: number): Date {
  const out = nextBusinessDay(new Date(d.getTime()));
  let remaining = n;
  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    if (!isWeekend(out)) remaining -= 1;
  }
  return out;
}

/**
 * Inclusive count of business days between `from` (rounded forward) and `to`
 * (rounded backward). `to <= from` returns 0.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  if (to.getTime() < from.getTime()) return 0;
  const start = nextBusinessDay(from);
  const end = prevBusinessDay(to);
  if (end.getTime() < start.getTime()) return 0;
  let count = 0;
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    if (!isWeekend(cursor)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/**
 * Generate the contiguous list of working days starting at `start` (rounded
 * forward) up to and including a date that is `count` working days later.
 */
export function workingDayRange(start: Date, count: number): Date[] {
  const out: Date[] = [];
  const cursor = nextBusinessDay(new Date(start.getTime()));
  while (out.length < count) {
    out.push(new Date(cursor.getTime()));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    while (isWeekend(cursor)) cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
