/**
 * Pure schedule computation. No DB, no side effects — fed maps + arrays,
 * returns placements + bottlenecks. Reused by the HTTP "Generate suggestion"
 * route and the periodic refresh handler.
 *
 * Working calendar is hard-coded Monday–Friday (Mon-Fri). Holidays and
 * per-team calendars are managed by the calendar_exceptions subsystem
 * (ADR 0044) but not yet wired into this scheduler (Phase 2).
 *
 * Calendar exceptions are integrated via `ScheduleInput.nonWorkingDates`
 * (a pre-queried Set<string> of ISO dates). The caller pre-queries via
 * buildNonWorkingDateSet(db, from, to, ctx) — keeps this function DB-free.
 *
 * Design choices:
 *   - All dates are ISO YYYY-MM-DD strings. We work in UTC-naive day numbers
 *     internally to dodge timezone DST surprises. The conversion helpers
 *     `parseDate` / `formatDate` are pure.
 *   - Cycles in `depends_on_wishes` are detected via Kahn's algorithm. Nodes
 *     left in the cycle are emitted as `cycle` bottlenecks and skipped from
 *     placement.
 *   - Tag dependencies (`depends_on_tags`) require *every* wish carrying any
 *     of the listed tag names to finish first. If a tag-prereq wish hasn't
 *     been placed yet (e.g. because of a separate cycle), the dependent wish
 *     is deferred; if it can never be satisfied, we emit `tag_unmet`.
 *   - Per-team timeline tracked as a sorted list of [start, end] intervals.
 *     `findTeamSlot(team, earliest, durationDays)` walks forward looking for
 *     the first window where active intervals < team.maxParallel.
 *   - Wishes without a team are placed against a synthetic unbounded team.
 */

export interface ScheduleWish {
  id: number;
  durationDays: number;
  teamId: number | null;
  deadlineId: number | null;
  dependsOnWishes: number[];
  dependsOnTags: string[];
  tagIds: number[];
  /** User-pinned start; v1 ignores manual locks during auto-suggestion. */
  manualStartDate?: string | null;
}

export interface ScheduleTeam {
  id: number;
  maxParallel: number;
}

export interface ScheduleDeadline {
  id: number;
  dueDate: string; // ISO YYYY-MM-DD
}

export interface ScheduleTag {
  id: number;
  name: string;
}

export interface ScheduleInput {
  startDate: string; // ISO YYYY-MM-DD
  wishes: ScheduleWish[];
  teams: ScheduleTeam[];
  deadlines: ScheduleDeadline[];
  tags: ScheduleTag[];
  /** Pre-queried non-working dates (holidays + calendar exceptions). When
   *  provided, these dates are treated as non-working in addition to weekends. */
  nonWorkingDates?: Set<string>;
}

export interface SchedulePlacement {
  wishId: number;
  start: string;
  end: string;
  reason: PlacementReason;
}

export type BottleneckKind =
  | "deadline_overrun"
  | "cycle"
  | "tag_unmet"
  | "missing_team";

export interface ScheduleBottleneck {
  wishId: number;
  kind: BottleneckKind;
  message: string;
}

export type PlacementReasonKind =
  | "project_start"      // no deps or team constraint — placed at the project start date
  | "dependency"         // dependency on other wish(es) or tag(s) pushed the start forward
  | "team_capacity"      // team slot search had to skip forward past busy periods
  | "dependency_and_team"; // both dependency and team capacity contributed

export interface PlacementReason {
  kind: PlacementReasonKind;
  /** IDs of explicit wish dependencies that drove the earliest-start constraint. */
  blockingWishIds: number[];
  /** Tag names whose dependent wishes drove the earliest-start constraint. */
  blockingTagNames: string[];
}

export interface ScheduleOutput {
  placements: SchedulePlacement[];
  bottlenecks: ScheduleBottleneck[];
}

// ── Date helpers ───────────────────────────────────────────────────────────
// Parse "YYYY-MM-DD" into a Date at UTC midnight; format Date back. Working
// in UTC sidesteps timezone offsets that flip a day around DST boundaries.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(iso: string): Date {
  if (!ISO_DATE_RE.test(iso))
    throw new Error(`invalid ISO date '${iso}' (expected YYYY-MM-DD)`);
  const parts = iso.split("-").map((s) => parseInt(s, 10));
  const y = parts[0]!;
  const m = parts[1]!;
  const d = parts[2]!;
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

function isNonWorkingDay(d: Date, nwd?: Set<string>): boolean {
  if (nwd?.has(formatDate(d))) return true;
  return isWeekend(d);
}

/**
 * Round forward to the next working day if `d` falls on a weekend or is in
 * `nwd`. Returns a new Date — does not mutate.
 */
export function nextBusinessDay(d: Date, nwd?: Set<string>): Date {
  const out = new Date(d.getTime());
  while (isNonWorkingDay(out, nwd)) out.setUTCDate(out.getUTCDate() + 1);
  return out;
}

/**
 * Add `n` working days to `d`. n=0 returns the same day (after rounding to
 * a working day). n=1 returns the next working day. `nwd` extends the
 * non-working set beyond weekends (calendar exceptions). Used to compute
 * end = start + (durationDays - 1).
 */
export function addBusinessDays(d: Date, n: number, nwd?: Set<string>): Date {
  let out = nextBusinessDay(d, nwd);
  let remaining = n;
  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    if (!isNonWorkingDay(out, nwd)) remaining -= 1;
  }
  return out;
}

/** Strict greater-than for ISO date strings (lexicographic = chronological). */
function isAfter(a: string, b: string): boolean {
  return a > b;
}

// ── Team timeline ──────────────────────────────────────────────────────────

interface Interval {
  start: Date;
  end: Date;
}

/**
 * For a given team, find the earliest start date `>= earliest` such that the
 * count of active intervals never exceeds `maxParallel` for the entire run
 * `[start, addBusinessDays(start, durationDays - 1)]`.
 *
 * Strategy: scan candidate start days in working-day increments. For each,
 * count overlaps; if < maxParallel for every working day in the run, accept.
 * For typical project sizes (≤ a few hundred wishes) this is fine.
 */
function findTeamSlot(
  intervals: Interval[],
  earliest: Date,
  durationDays: number,
  maxParallel: number,
  nwd?: Set<string>,
): { start: Date; end: Date } {
  let candidateStart = nextBusinessDay(earliest, nwd);
  while (true) {
    const candidateEnd = addBusinessDays(candidateStart, durationDays - 1, nwd);
    if (overlapWithinCap(intervals, candidateStart, candidateEnd, maxParallel, nwd)) {
      return { start: candidateStart, end: candidateEnd };
    }
    // Advance one working day and try again.
    let next = new Date(candidateStart.getTime());
    next.setUTCDate(next.getUTCDate() + 1);
    candidateStart = nextBusinessDay(next, nwd);
  }
}

function overlapWithinCap(
  intervals: Interval[],
  start: Date,
  end: Date,
  cap: number,
  nwd?: Set<string>,
): boolean {
  // Walk every working day in [start, end] and count overlapping intervals.
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    if (!isNonWorkingDay(cursor, nwd)) {
      let count = 0;
      for (const iv of intervals) {
        if (cursor.getTime() >= iv.start.getTime() && cursor.getTime() <= iv.end.getTime())
          count += 1;
      }
      if (count >= cap) return false;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return true;
}

function reserveInterval(
  intervals: Interval[],
  start: Date,
  end: Date,
): void {
  intervals.push({ start, end });
  intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// ── Topological sort + cycle detection (Kahn) ──────────────────────────────

interface TopoResult {
  order: number[];
  cycleNodes: number[]; // wish ids that participate in or descend into a cycle
}

function topologicalSort(wishes: ScheduleWish[]): TopoResult {
  const wishById = new Map<number, ScheduleWish>();
  for (const w of wishes) wishById.set(w.id, w);

  const inDegree = new Map<number, number>();
  const successors = new Map<number, number[]>();
  for (const w of wishes) {
    inDegree.set(w.id, 0);
    successors.set(w.id, []);
  }
  for (const w of wishes) {
    for (const dep of w.dependsOnWishes) {
      if (!wishById.has(dep)) continue; // dangling dep — silently dropped
      inDegree.set(w.id, (inDegree.get(w.id) ?? 0) + 1);
      successors.get(dep)!.push(w.id);
    }
  }

  const queue: number[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  const order: number[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const succ of successors.get(id) ?? []) {
      inDegree.set(succ, (inDegree.get(succ) ?? 0) - 1);
      if (inDegree.get(succ) === 0) queue.push(succ);
    }
  }

  const cycleNodes: number[] = [];
  for (const w of wishes) if (!order.includes(w.id)) cycleNodes.push(w.id);

  return { order, cycleNodes };
}

// ── Main entry ─────────────────────────────────────────────────────────────

export function computeSchedule(input: ScheduleInput): ScheduleOutput {
  const nwd = input.nonWorkingDates;
  const projectStart = parseDate(input.startDate);

  const wishById = new Map<number, ScheduleWish>();
  for (const w of input.wishes) wishById.set(w.id, w);

  const teamById = new Map<number, ScheduleTeam>();
  for (const t of input.teams) teamById.set(t.id, t);

  const deadlineById = new Map<number, ScheduleDeadline>();
  for (const d of input.deadlines) deadlineById.set(d.id, d);

  const tagNameToWishIds = new Map<string, number[]>();
  const tagNameById = new Map<number, string>();
  for (const t of input.tags) tagNameById.set(t.id, t.name);
  for (const w of input.wishes) {
    for (const tagId of w.tagIds) {
      const name = tagNameById.get(tagId);
      if (!name) continue;
      const list = tagNameToWishIds.get(name);
      if (list) list.push(w.id);
      else tagNameToWishIds.set(name, [w.id]);
    }
  }

  const { order, cycleNodes } = topologicalSort(input.wishes);

  const placements = new Map<number, { start: Date; end: Date; reason: PlacementReason }>();
  const bottlenecks: ScheduleBottleneck[] = [];

  for (const id of cycleNodes) {
    bottlenecks.push({
      wishId: id,
      kind: "cycle",
      message: `Wish is part of a dependency cycle and was not placed.`,
    });
  }

  // Per-team interval list (key = team id; null-team uses sentinel -1).
  const NULL_TEAM = -1;
  const teamIntervals = new Map<number, Interval[]>();
  function getIntervals(teamId: number | null): Interval[] {
    const key = teamId ?? NULL_TEAM;
    let list = teamIntervals.get(key);
    if (!list) {
      list = [];
      teamIntervals.set(key, list);
    }
    return list;
  }

  for (const wishId of order) {
    const wish = wishById.get(wishId)!;

    // Collect dep end-dates: explicit wishes + tag-implied wishes.
    const depEnds: Date[] = [];
    let depMissing = false;
    const explicitDepWishIds: number[] = [];
    for (const depId of wish.dependsOnWishes) {
      const dep = placements.get(depId);
      if (!dep) {
        depMissing = true; // may be a cycle node — defer; fallback to projectStart
        continue;
      }
      depEnds.push(dep.end);
      explicitDepWishIds.push(depId);
    }
    let tagUnmet: string | null = null;
    const depTagNames: string[] = [];
    for (const tagName of wish.dependsOnTags) {
      const tagWishes = tagNameToWishIds.get(tagName);
      if (!tagWishes || tagWishes.length === 0) {
        tagUnmet = tagName;
        continue;
      }
      let allPlaced = true;
      let tagHasDep = false;
      for (const tWishId of tagWishes) {
        if (tWishId === wish.id) continue; // self-tag never blocks itself
        const tDep = placements.get(tWishId);
        if (!tDep) {
          allPlaced = false;
          continue;
        }
        depEnds.push(tDep.end);
        tagHasDep = true;
      }
      if (!allPlaced) tagUnmet = tagUnmet ?? tagName;
      if (tagHasDep) depTagNames.push(tagName);
    }
    if (tagUnmet !== null) {
      bottlenecks.push({
        wishId: wish.id,
        kind: "tag_unmet",
        message: `No placeable wish carries tag '${tagUnmet}' — tag-dependency cannot be satisfied.`,
      });
    }

    // earliestFromDeps = max(depEnds) + 1 working day; or projectStart.
    let earliest = projectStart;
    for (const e of depEnds) {
      const next = new Date(e.getTime());
      next.setUTCDate(next.getUTCDate() + 1);
      const nb = nextBusinessDay(next, nwd);
      if (nb.getTime() > earliest.getTime()) earliest = nb;
    }

    // Honour wish.manualStartDate when set (v1 keeps user's manual lock).
    if (wish.manualStartDate) {
      const manual = parseDate(wish.manualStartDate);
      if (manual.getTime() > earliest.getTime()) earliest = manual;
    }

    const team = wish.teamId !== null ? teamById.get(wish.teamId) : null;
    if (wish.teamId !== null && !team) {
      bottlenecks.push({
        wishId: wish.id,
        kind: "missing_team",
        message: `Wish references team ${wish.teamId}, which no longer exists.`,
      });
    }
    const cap = team ? team.maxParallel : 99999; // null team = unlimited
    const intervals = getIntervals(wish.teamId);
    const slot = findTeamSlot(intervals, earliest, wish.durationDays, cap, nwd);
    reserveInterval(intervals, slot.start, slot.end);

    const depWasBinding = explicitDepWishIds.length > 0 || depTagNames.length > 0;
    const teamWasBinding = slot.start.getTime() > earliest.getTime();
    let reasonKind: PlacementReasonKind;
    if (depWasBinding && teamWasBinding) reasonKind = "dependency_and_team";
    else if (depWasBinding) reasonKind = "dependency";
    else if (teamWasBinding) reasonKind = "team_capacity";
    else reasonKind = "project_start";
    const reason: PlacementReason = {
      kind: reasonKind,
      blockingWishIds: explicitDepWishIds,
      blockingTagNames: depTagNames,
    };

    placements.set(wish.id, { start: slot.start, end: slot.end, reason });

    if (wish.deadlineId !== null) {
      const dl = deadlineById.get(wish.deadlineId);
      if (dl) {
        const endIso = formatDate(slot.end);
        if (isAfter(endIso, dl.dueDate)) {
          bottlenecks.push({
            wishId: wish.id,
            kind: "deadline_overrun",
            message: `Planned end ${endIso} exceeds deadline ${dl.dueDate}.`,
          });
        }
      }
    }

    // depMissing logged but does not block — placement uses projectStart.
    if (depMissing) {
      bottlenecks.push({
        wishId: wish.id,
        kind: "cycle",
        message: `Some prerequisite wishes were unplaced (likely cycle); planning placed this wish at the project start.`,
      });
    }
  }

  return {
    placements: Array.from(placements.entries()).map(([wishId, p]) => ({
      wishId,
      start: formatDate(p.start),
      end: formatDate(p.end),
      reason: p.reason,
    })),
    bottlenecks,
  };
}
