/**
 * Minimal 5-field cron parser + next-fire computation.
 *
 * Supports standard POSIX cron syntax: `minute hour dayOfMonth month dayOfWeek`.
 * Each field accepts:
 *   - `*`           — any value in range
 *   - `*​/N`         — every N units starting at the low bound
 *   - `a`           — exact value
 *   - `a-b`         — range
 *   - `a-b/N`       — stepped range
 *   - `a,b,c`       — comma-separated list of any of the above
 *
 * Day-of-month and day-of-week follow classic cron OR-semantics: when either
 * field is restricted (not `*`), a day matches if it matches either field.
 *
 * The resolution is per-minute, matching the scheduler ticker's cadence.
 */

const FIELDS = ["minute", "hour", "dom", "month", "dow"] as const;
const RANGES: Record<(typeof FIELDS)[number], [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
};

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when dom was explicitly restricted in the expression. */
  domRestricted: boolean;
  /** True when dow was explicitly restricted in the expression. */
  dowRestricted: boolean;
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${parts.length}: '${expr}'`);
  }
  const [mn, hr, dm, mo, dw] = parts as [string, string, string, string, string];
  return {
    minute: parseField("minute", mn),
    hour: parseField("hour", hr),
    dom: parseField("dom", dm),
    month: parseField("month", mo),
    dow: parseField("dow", dw),
    domRestricted: dm.trim() !== "*",
    dowRestricted: dw.trim() !== "*",
  };
}

function parseField(name: (typeof FIELDS)[number], raw: string): Set<number> {
  const [lo, hi] = RANGES[name];
  const values = new Set<number>();
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) throw new Error(`empty ${name} field segment`);

    let range = trimmed;
    let step = 1;
    const slash = trimmed.indexOf("/");
    if (slash !== -1) {
      range = trimmed.slice(0, slash);
      step = Number(trimmed.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`invalid step in ${name}: '${trimmed}'`);
      }
    }

    let start: number;
    let end: number;
    if (range === "*") {
      start = lo;
      end = hi;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(range);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`non-integer value in ${name}: '${trimmed}'`);
    }
    if (start < lo || end > hi || start > end) {
      throw new Error(`${name} value out of range [${lo},${hi}]: '${trimmed}'`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

/**
 * Return the next timestamp (ms since epoch) strictly greater than `fromMs`
 * at which the cron expression matches. Iterates minute-by-minute; capped at
 * four years to surface pathological expressions rather than spin.
 */
export function computeNextRun(expr: string, fromMs: number): number {
  const cron = parseCron(expr);
  // Start at the next minute boundary strictly after `fromMs`.
  const start = new Date(fromMs);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  const maxMinutes = 60 * 24 * 366 * 4;
  const cursor = new Date(start.getTime());
  for (let i = 0; i < maxMinutes; i++) {
    if (matches(cron, cursor)) return cursor.getTime();
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error(`cron expression '${expr}' has no match within 4 years`);
}

function matches(cron: ParsedCron, d: Date): boolean {
  if (!cron.minute.has(d.getUTCMinutes())) return false;
  if (!cron.hour.has(d.getUTCHours())) return false;
  if (!cron.month.has(d.getUTCMonth() + 1)) return false;
  const dom = d.getUTCDate();
  const dow = d.getUTCDay();
  const domMatch = cron.dom.has(dom);
  const dowMatch = cron.dow.has(dow);
  if (cron.domRestricted && cron.dowRestricted) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}
