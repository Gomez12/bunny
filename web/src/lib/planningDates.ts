/**
 * Working-day arithmetic for the Planning Gantt. Mirrors the server-side
 * helpers in `src/planning/scheduler.ts`. All functions accept an optional
 * `nonWorkingDates` Set of ISO date strings (pre-fetched calendar exceptions)
 * so the Gantt respects holidays in addition to weekends.
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

function isNonWorkingDay(d: Date, nwd?: Set<string>): boolean {
  if (nwd?.has(formatISODate(d))) return true;
  return isWeekend(d);
}

export function nextBusinessDay(d: Date, nwd?: Set<string>): Date {
  const out = new Date(d.getTime());
  while (isNonWorkingDay(out, nwd)) out.setUTCDate(out.getUTCDate() + 1);
  return out;
}

export function prevBusinessDay(d: Date, nwd?: Set<string>): Date {
  const out = new Date(d.getTime());
  while (isNonWorkingDay(out, nwd)) out.setUTCDate(out.getUTCDate() - 1);
  return out;
}

export function addBusinessDays(d: Date, n: number, nwd?: Set<string>): Date {
  const out = nextBusinessDay(new Date(d.getTime()), nwd);
  let remaining = n;
  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    if (!isNonWorkingDay(out, nwd)) remaining -= 1;
  }
  return out;
}

/**
 * Inclusive count of working days between `from` (rounded forward) and `to`
 * (rounded backward). `to <= from` returns 0.
 */
export function businessDaysBetween(
  from: Date,
  to: Date,
  nwd?: Set<string>,
): number {
  if (to.getTime() < from.getTime()) return 0;
  const start = nextBusinessDay(from, nwd);
  const end = prevBusinessDay(to, nwd);
  if (end.getTime() < start.getTime()) return 0;
  let count = 0;
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    if (!isNonWorkingDay(cursor, nwd)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/**
 * Generate the contiguous list of working days starting at `start` (rounded
 * forward) up to and including a date that is `count` working days later.
 * Calendar exceptions in `nwd` are skipped in addition to weekends.
 */
export function workingDayRange(
  start: Date,
  count: number,
  nwd?: Set<string>,
): Date[] {
  const out: Date[] = [];
  const cursor = nextBusinessDay(new Date(start.getTime()), nwd);
  while (out.length < count) {
    out.push(new Date(cursor.getTime()));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    while (isNonWorkingDay(cursor, nwd)) cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Descriptor for a single day in the Gantt all-calendar-day timeline. */
export interface DayInfo {
  date: Date;
  iso: string;
  isWorkingDay: boolean;
}

/**
 * Generate an array covering ALL calendar days from `start` through the date
 * that is `workingDayCount` working days after `start` (inclusive). Non-working
 * days (weekends + `nwd` exceptions) are included in the array but flagged with
 * `isWorkingDay: false`. This is the Gantt all-calendar timeline.
 */
export function calendarDayRange(
  start: Date,
  workingDayCount: number,
  nwd?: Set<string>,
): DayInfo[] {
  if (workingDayCount <= 0) return [];
  // The range ends on the workingDayCount-th working day from start (inclusive).
  const firstWorkingDay = nextBusinessDay(start, nwd);
  const lastWorkingDay = addBusinessDays(firstWorkingDay, workingDayCount - 1, nwd);
  const out: DayInfo[] = [];
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= lastWorkingDay.getTime()) {
    const date = new Date(cursor.getTime());
    const iso = formatISODate(date);
    out.push({ date, iso, isWorkingDay: !isNonWorkingDay(date, nwd) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Return true when the gap between `prev` and `curr` (both working days)
 * contains at least one extra non-working day beyond a plain weekend.
 *
 * Normal gaps: 1 day (Mon-Fri consecutive), 3 days (Fri→Mon weekend).
 * Any other gap, or a 3-day gap where `prev` is NOT a Friday, means a holiday.
 */
export function hasHolidayGap(prev: Date, curr: Date): boolean {
  const gapDays =
    (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);
  if (gapDays <= 1) return false;
  if (gapDays === 3 && prev.getUTCDay() === 5) return false; // Fri→Mon weekend
  return true;
}
