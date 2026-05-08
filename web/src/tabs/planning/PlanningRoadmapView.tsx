import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type PlanningDeadline,
  type PlanningProject,
  type PlanningSuggestion,
  type PlanningTag,
  type PlanningTeam,
  type PlanningWish,
  createPlanningWish,
  fetchPlanningSuggestion,
  fetchPlanningNonWorkingDates,
  generatePlanningSuggestion,
  listPlanningDeadlines,
  listPlanningTags,
  listPlanningTeams,
  listPlanningWishes,
  patchPlanningWish,
} from "../../api";
import { PLANNING_STORAGE, isoWeek } from "../../lib/planningStorage";
import {
  AlertCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "../../lib/icons";
import {
  addBusinessDays,
  businessDaysBetween,
  calendarDayRange,
  formatISODate,
  nextBusinessDay,
  parseISODate,
} from "../../lib/planningDates";
import PlanningSuggestionPanel from "./PlanningSuggestionPanel";
import PlanningWishForm from "./PlanningWishForm";
import ConfirmDialog from "../../components/ConfirmDialog";
import Modal from "../../components/Modal";

interface Props {
  planningProject: PlanningProject;
  onEditProject: () => void;
  onDeleteProject: () => void;
}

const ROW_HEIGHT_PX = 44;
const HEADER_ROW_LABEL_WIDTH = 140;

const UNASSIGNED_TEAM_ID = -1;

/**
 * Zoom levels — each maps to a `dayWidthPx`. Day numbers are shown only at
 * `week` zoom; smaller zooms hide them to keep the axis readable.
 */
type ZoomLevel = "week" | "month" | "quarter";
const ZOOM_LEVELS: Array<{ id: ZoomLevel; label: string; dayWidthPx: number }> = [
  { id: "week", label: "Week", dayWidthPx: 32 },
  { id: "month", label: "Month", dayWidthPx: 14 },
  { id: "quarter", label: "Quarter", dayWidthPx: 6 },
];

function readStoredZoom(): ZoomLevel {
  const raw = localStorage.getItem(PLANNING_STORAGE.roadmapZoom);
  return raw === "month" || raw === "quarter" || raw === "week"
    ? (raw as ZoomLevel)
    : "week";
}

const TIMELINE_BUFFER_DAYS = 14; // calendar days padding on each side of derived range
const MIN_TIMELINE_DAYS = 60; // working-day floor — small projects still get a roomy axis

interface BarLayout {
  startIdx: number;   // calendar-day index of planned start
  endIdx: number;     // calendar-day index of planned end
  durationDays: number; // working days (for label + resize delta computation)
}

export default function PlanningRoadmapView({
  planningProject,
  onEditProject,
  onDeleteProject,
}: Props) {
  const [wishes, setWishes] = useState<PlanningWish[]>([]);
  const [teams, setTeams] = useState<PlanningTeam[]>([]);
  const [deadlines, setDeadlines] = useState<PlanningDeadline[]>([]);
  const [suggestion, setSuggestion] = useState<PlanningSuggestion | null>(null);
  const [nonWorkingDates, setNonWorkingDates] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Confirm-before-apply toggle. Default ON so the user is in lead by default;
  // power-users can flip it off to drag-and-drop without dialogs.
  const [confirmEnabled, setConfirmEnabledRaw] = useState<boolean>(() => {
    const raw = localStorage.getItem(PLANNING_STORAGE.confirmDrag);
    return raw === null ? true : raw === "1";
  });
  const setConfirmEnabled = useCallback((v: boolean) => {
    localStorage.setItem(PLANNING_STORAGE.confirmDrag, v ? "1" : "0");
    setConfirmEnabledRaw(v);
  }, []);

  // Zoom level. Persisted globally — the Gantt UX expects the same density
  // when switching between planning projects.
  const [zoom, setZoomRaw] = useState<ZoomLevel>(readStoredZoom);
  const setZoom = useCallback((z: ZoomLevel) => {
    localStorage.setItem(PLANNING_STORAGE.roadmapZoom, z);
    setZoomRaw(z);
  }, []);
  const dayWidthPx = useMemo(() => {
    const found = ZOOM_LEVELS.find((z) => z.id === zoom);
    return found?.dayWidthPx ?? 32;
  }, [zoom]);

  // Wheel-to-zoom over the Gantt grid. Plain wheel cycles zoom levels with
  // a ~150 ms throttle; Shift / Ctrl bypass so the user can still scroll
  // horizontally / vertically. We use a native listener (not React onWheel)
  // because we need passive:false to call preventDefault — the synthetic
  // listener is passive by default in React 17+.
  //
  // The listener reads the current zoom via a ref so the effect attaches once
  // (mount only). Re-attaching on every zoom change would needlessly churn
  // the DOM listener.
  const ganttRef = useRef<HTMLDivElement | null>(null);
  const lastWheelZoomAt = useRef<number>(0);
  const zoomRef = useRef<ZoomLevel>(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const el = ganttRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.shiftKey) return; // let the browser handle scroll
      if (e.deltaY === 0) return;
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheelZoomAt.current < 150) return;
      lastWheelZoomAt.current = now;
      const current = zoomRef.current;
      const idx = ZOOM_LEVELS.findIndex((z) => z.id === current);
      const dir = e.deltaY > 0 ? 1 : -1; // scroll down = zoom out
      const next = Math.max(
        0,
        Math.min(ZOOM_LEVELS.length - 1, idx + dir),
      );
      const target = ZOOM_LEVELS[next];
      if (target && target.id !== current) setZoom(target.id);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoom]);

  // Wish modal — both for adding new wishes ("+ New wish" button) and for
  // editing existing wishes (double-click a bar). One state tree, one modal
  // render block, two onSubmit branches.
  type WishModalState =
    | { kind: "new" }
    | { kind: "edit"; wish: PlanningWish }
    | null;
  const [wishModal, setWishModal] = useState<WishModalState>(null);
  const [tags, setTags] = useState<PlanningTag[]>([]);

  const reload = useCallback(async () => {
    try {
      const [w, t, d, s, g] = await Promise.all([
        listPlanningWishes(planningProject.id),
        listPlanningTeams(planningProject.id),
        listPlanningDeadlines(planningProject.id),
        fetchPlanningSuggestion(planningProject.id),
        listPlanningTags(planningProject.id),
      ]);
      setWishes(w);
      setTeams(t);
      setDeadlines(d);
      setSuggestion(s);
      setTags(g);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [planningProject.id]);

  // Fetch non-working dates for the visible timeline window. Re-fetched when
  // the planning project changes; the window is derived from the project start
  // + a generous horizon (10 years) so we cover all possible wish placements.
  useEffect(() => {
    const projectStart = planningProject.startDate ?? formatISODate(new Date());
    const from = projectStart;
    const toDate = new Date(parseISODate(projectStart).getTime());
    toDate.setUTCFullYear(toDate.getUTCFullYear() + 10);
    const to = formatISODate(toDate);
    fetchPlanningNonWorkingDates(planningProject.id, from, to)
      .then(setNonWorkingDates)
      .catch(() => setNonWorkingDates(new Set())); // non-fatal: degrade to weekends-only
  }, [planningProject.id, planningProject.startDate]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Timeline auto-extends to cover every relevant date — project start,
  // every deadline, every wish's planned start/end. Add a calendar-day buffer
  // on each side so things near the edge stay visible. Floor at
  // MIN_TIMELINE_DAYS working days so empty plans still get a usable axis.
  const { days, timelineStart } = useMemo(() => {
    const projectStartIso =
      planningProject.startDate ?? formatISODate(new Date());
    const candidates: string[] = [projectStartIso];
    for (const d of deadlines) candidates.push(d.dueDate);
    for (const w of wishes) {
      if (w.plannedStartDate) candidates.push(w.plannedStartDate);
      if (w.plannedEndDate) candidates.push(w.plannedEndDate);
    }
    let minIso = candidates[0]!;
    let maxIso = candidates[0]!;
    for (const c of candidates) {
      if (c < minIso) minIso = c;
      if (c > maxIso) maxIso = c;
    }
    // Apply calendar-day buffer.
    const minDate = new Date(parseISODate(minIso).getTime());
    minDate.setUTCDate(minDate.getUTCDate() - TIMELINE_BUFFER_DAYS);
    const maxDate = new Date(parseISODate(maxIso).getTime());
    maxDate.setUTCDate(maxDate.getUTCDate() + TIMELINE_BUFFER_DAYS);

    const start = parseISODate(formatISODate(minDate));
    // Working-day count between start and maxDate, with a floor.
    const span = businessDaysBetween(start, maxDate, nonWorkingDates);
    const count = Math.max(span, MIN_TIMELINE_DAYS);
    // calendarDayRange returns ALL days (Mon–Sun) so weekends are visible.
    return {
      timelineStart: start,
      days: calendarDayRange(start, count, nonWorkingDates),
    };
  }, [planningProject.startDate, deadlines, wishes, nonWorkingDates]);

  const dayKeyToIdx = useMemo(() => {
    const m = new Map<string, number>();
    days.forEach((d, i) => m.set(d.iso, i));
    return m;
  }, [days]);
  const timelineLastIso = days.length > 0 ? days[days.length - 1]!.iso : "";

  // Group wishes by team for row dispatch.
  const teamRows: Array<{ id: number; name: string; team: PlanningTeam | null }> =
    useMemo(() => {
      return [
        { id: UNASSIGNED_TEAM_ID, name: "Unassigned", team: null },
        ...teams.map((t) => ({ id: t.id, name: t.name, team: t })),
      ];
    }, [teams]);

  const wishesByTeam = useMemo(() => {
    const m = new Map<number, PlanningWish[]>();
    for (const w of wishes) {
      const key = w.teamId ?? UNASSIGNED_TEAM_ID;
      const list = m.get(key);
      if (list) list.push(w);
      else m.set(key, [w]);
    }
    return m;
  }, [wishes]);

  const wishLayout = useCallback(
    (wish: PlanningWish): BarLayout | null => {
      if (!wish.plannedStartDate) return null;
      const startDate = parseISODate(wish.plannedStartDate);
      const startIdx = dayKeyToIdx.get(wish.plannedStartDate) ?? -1;
      if (startIdx < 0) {
        // Out of timeline — clamp left.
        const before = businessDaysBetween(startDate, timelineStart);
        if (before > 0) return null;
      }
      // Always derive end from durationDays — it is the source of truth.
      // plannedEndDate stored in the DB may lag behind if durationDays was
      // patched without a corresponding end-date update.
      const endDate = addBusinessDays(startDate, wish.durationDays - 1, nonWorkingDates);
      const endIdx = dayKeyToIdx.get(formatISODate(endDate)) ?? (Math.max(0, startIdx) + wish.durationDays - 1);
      return {
        startIdx: Math.max(0, startIdx),
        endIdx: Math.max(Math.max(0, startIdx), endIdx),
        durationDays: wish.durationDays,
      };
    },
    [dayKeyToIdx, timelineStart, nonWorkingDates],
  );

  // Move-drag state. Tracks both X (start-date) and Y (team-row reassignment).
  const dragRef = useRef<{
    wishId: number;
    startX: number;
    startY: number;
    initialIdx: number;
    initialRowIndex: number;
    initialTeamId: number | null;
  } | null>(null);
  const [dragDelta, setDragDelta] = useState<{
    wishId: number;
    deltaDays: number;
    deltaRows: number;
    targetTeamId: number | null;
  } | null>(null);
  const [confirmDrag, setConfirmDrag] = useState<{
    wish: PlanningWish;
    oldStart: string | null;
    newStart: string;
    newEnd: string;
    oldTeamId: number | null;
    oldTeamName: string;
    newTeamId: number | null;
    newTeamName: string;
  } | null>(null);

  // Resize-drag state. Tracks rightward drag of the bar's right-edge handle.
  const resizeRef = useRef<{
    wishId: number;
    startX: number;
    initialDuration: number;
  } | null>(null);
  const [resizeDelta, setResizeDelta] = useState<{
    wishId: number;
    deltaDays: number;
  } | null>(null);
  const [confirmResize, setConfirmResize] = useState<{
    wish: PlanningWish;
    newDuration: number;
  } | null>(null);

  function teamRowIndexFor(teamId: number | null): number {
    const id = teamId ?? UNASSIGNED_TEAM_ID;
    const idx = teamRows.findIndex((r) => r.id === id);
    return idx < 0 ? 0 : idx;
  }

  const onBarPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    wish: PlanningWish,
    layout: BarLayout,
  ) => {
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    const initialRowIndex = teamRowIndexFor(wish.teamId);
    dragRef.current = {
      wishId: wish.id,
      startX: e.clientX,
      startY: e.clientY,
      initialIdx: layout.startIdx,
      initialRowIndex,
      initialTeamId: wish.teamId,
    };
    setDragDelta({
      wishId: wish.id,
      deltaDays: 0,
      deltaRows: 0,
      targetTeamId: wish.teamId,
    });
  };

  const onBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const deltaDays = Math.round(dx / dayWidthPx);
    const deltaRowsRaw = Math.round(dy / ROW_HEIGHT_PX);
    const targetRowIndex = Math.max(
      0,
      Math.min(teamRows.length - 1, drag.initialRowIndex + deltaRowsRaw),
    );
    const targetRow = teamRows[targetRowIndex]!;
    const targetTeamId =
      targetRow.id === UNASSIGNED_TEAM_ID ? null : targetRow.id;
    setDragDelta({
      wishId: drag.wishId,
      deltaDays,
      deltaRows: targetRowIndex - drag.initialRowIndex,
      targetTeamId,
    });
  };

  const onBarPointerUp = (
    e: React.PointerEvent<HTMLDivElement>,
    wish: PlanningWish,
  ) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const finalDelta = dragDelta;
    setDragDelta(null);
    if (!drag) return;
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    const dx = e.clientX - drag.startX;
    const deltaDays = Math.round(dx / dayWidthPx);
    const targetTeamId =
      finalDelta?.targetTeamId !== undefined
        ? finalDelta.targetTeamId
        : drag.initialTeamId;
    const newIdx = Math.max(0, drag.initialIdx + deltaDays);
    if (newIdx >= days.length) return; // dropped past visible window — ignore
    const rawDay = days[newIdx];
    if (!rawDay) return;
    // Snap to next working day when dropping on a weekend/holiday.
    const snappedStart = nextBusinessDay(rawDay.date, nonWorkingDates);
    const snappedIdx = dayKeyToIdx.get(formatISODate(snappedStart)) ?? newIdx;
    const newStartIso = formatISODate(snappedStart);
    const newEndIso = formatISODate(
      addBusinessDays(snappedStart, wish.durationDays - 1, nonWorkingDates),
    );
    // Use snapped index to detect whether start actually changed.
    const startChanged = snappedIdx !== drag.initialIdx;
    const teamChanged = targetTeamId !== drag.initialTeamId;
    if (!startChanged && !teamChanged) return;

    if (confirmEnabled) {
      const oldRow = teamRows[drag.initialRowIndex]!;
      const newRowIdx = teamRowIndexFor(targetTeamId);
      const newRow = teamRows[newRowIdx]!;
      setConfirmDrag({
        wish,
        oldStart: wish.plannedStartDate,
        newStart: newStartIso,
        newEnd: newEndIso,
        oldTeamId: drag.initialTeamId,
        oldTeamName: oldRow.name,
        newTeamId: targetTeamId,
        newTeamName: newRow.name,
      });
    } else {
      void applyDrag({
        wishId: wish.id,
        newStart: startChanged ? newStartIso : undefined,
        newEnd: startChanged ? newEndIso : undefined,
        newTeamId: teamChanged ? targetTeamId : undefined,
      });
    }
  };

  const applyDrag = async (opts: {
    wishId: number;
    newStart?: string;
    newEnd?: string;
    newTeamId?: number | null;
  }) => {
    setBusy(true);
    try {
      await patchPlanningWish(opts.wishId, {
        ...(opts.newStart ? { plannedStartDate: opts.newStart } : {}),
        ...(opts.newEnd ? { plannedEndDate: opts.newEnd } : {}),
        ...(opts.newTeamId !== undefined ? { teamId: opts.newTeamId } : {}),
      });
      // Reload first so the bar moves immediately, even if suggestion generation fails.
      await reload();
      // Best-effort: refresh schedule advice. Failure must not block the UI update.
      try {
        await generatePlanningSuggestion(planningProject.id);
        await reload();
      } catch {
        // suggestion failure is non-fatal
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await reload(); // always refresh so stale visual state is corrected
    } finally {
      setBusy(false);
    }
  };

  const onResizePointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    wish: PlanningWish,
  ) => {
    e.stopPropagation(); // do not also trigger move-drag on the parent bar
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    resizeRef.current = {
      wishId: wish.id,
      startX: e.clientX,
      initialDuration: wish.durationDays,
    };
    setResizeDelta({ wishId: wish.id, deltaDays: 0 });
  };

  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const r = resizeRef.current;
    if (!r) return;
    const dx = e.clientX - r.startX;
    const deltaDays = Math.round(dx / dayWidthPx);
    setResizeDelta({ wishId: r.wishId, deltaDays });
  };

  const onResizePointerUp = (
    e: React.PointerEvent<HTMLDivElement>,
    wish: PlanningWish,
  ) => {
    e.stopPropagation();
    const r = resizeRef.current;
    resizeRef.current = null;
    setResizeDelta(null);
    if (!r) return;
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    const dx = e.clientX - r.startX;
    const calDelta = Math.round(dx / dayWidthPx);
    if (calDelta === 0) return;
    // Add calendar columns as working days — applyResize uses addBusinessDays
    // (with nonWorkingDates) to compute the real end date, so any non-working
    // days within the new span are automatically skipped.
    const newDuration = Math.max(1, Math.min(9999, r.initialDuration + calDelta));
    if (newDuration === r.initialDuration) return;
    if (confirmEnabled) {
      setConfirmResize({ wish, newDuration });
    } else {
      void applyResize(wish, newDuration);
    }
  };

  const applyResize = async (wish: PlanningWish, newDuration: number) => {
    setBusy(true);
    try {
      const newEnd = wish.plannedStartDate
        ? formatISODate(
            addBusinessDays(parseISODate(wish.plannedStartDate), newDuration - 1, nonWorkingDates),
          )
        : undefined;
      await patchPlanningWish(wish.id, {
        durationDays: newDuration,
        ...(newEnd ? { plannedEndDate: newEnd } : {}),
      });
      await reload();
      try {
        await generatePlanningSuggestion(planningProject.id);
        await reload();
      } catch {
        // suggestion failure is non-fatal
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const handleScheduleAtStart = async (wish: PlanningWish) => {
    const snappedStart = nextBusinessDay(timelineStart, nonWorkingDates);
    const startIso = formatISODate(snappedStart);
    const endIso = formatISODate(
      addBusinessDays(snappedStart, wish.durationDays - 1, nonWorkingDates),
    );
    try {
      await patchPlanningWish(wish.id, {
        plannedStartDate: startIso,
        plannedEndDate: endIso,
      });
      void reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleGenerate = async () => {
    setBusy(true);
    try {
      await generatePlanningSuggestion(planningProject.id);
      const next = await fetchPlanningSuggestion(planningProject.id);
      setSuggestion(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Group day indices by week for the header.
  const weekHeaders = useMemo(() => {
    const headers: { idx: number; label: string; span: number }[] = [];
    let currentWeek: { idx: number; span: number; label: string } | null = null;
    for (let i = 0; i < days.length; i++) {
      const d = days[i]!;
      const isoYearWeek = isoWeek(d.date);
      if (!currentWeek || currentWeek.label !== isoYearWeek) {
        if (currentWeek) headers.push(currentWeek);
        currentWeek = { idx: i, span: 1, label: isoYearWeek };
      } else {
        currentWeek.span += 1;
      }
    }
    if (currentWeek) headers.push(currentWeek);
    return headers;
  }, [days]);

  // Wishes in this timeline range with deadlines that fall inside it.
  const deadlineLines = useMemo(() => {
    return deadlines
      .map((d) => {
        const idx = dayKeyToIdx.get(d.dueDate);
        if (idx === undefined) return null;
        return { deadline: d, idx };
      })
      .filter((x): x is { deadline: PlanningDeadline; idx: number } => x !== null);
  }, [deadlines, dayKeyToIdx]);

  // Sprint boundaries — visible only when sprint_duration_days is set.
  // Sprints are aligned to the project's start_date (not the timeline buffer
  // start), so the buffer area before the project start has no sprint band.
  const sprints = useMemo<{ idx: number; spanDays: number; label: string }[]>(
    () => {
      const dur = planningProject.sprintDurationDays;
      if (!dur || dur <= 0) return [];
      const startIso = planningProject.startDate ?? formatISODate(timelineStart);
      const startDate = parseISODate(startIso);
      const result: { idx: number; spanDays: number; label: string }[] = [];
      let n = 1;
      let sprintStart = nextBusinessDay(startDate, nonWorkingDates);
      while (true) {
        const sprintStartIdx = dayKeyToIdx.get(formatISODate(sprintStart));
        if (sprintStartIdx === undefined || sprintStartIdx >= days.length) break;
        const sprintEnd = addBusinessDays(sprintStart, dur - 1, nonWorkingDates);
        const sprintEndIdx = dayKeyToIdx.get(formatISODate(sprintEnd));
        const span =
          sprintEndIdx !== undefined
            ? sprintEndIdx - sprintStartIdx + 1
            : days.length - sprintStartIdx;
        result.push({ idx: sprintStartIdx, spanDays: span, label: `S${n}` });
        n += 1;
        sprintStart = nextBusinessDay(
          addBusinessDays(sprintEnd, 1, nonWorkingDates),
          nonWorkingDates,
        );
      }
      return result;
    },
    [
      planningProject.sprintDurationDays,
      planningProject.startDate,
      timelineStart,
      dayKeyToIdx,
      days,
      nonWorkingDates,
    ],
  );

  const totalWidth =
    HEADER_ROW_LABEL_WIDTH + days.length * dayWidthPx;

  return (
    <div className="planning-roadmap">
      <header className="planning-view__header planning-view__header--roadmap">
        <div>
          <h2>{planningProject.name}</h2>
          {planningProject.description && (
            <p className="planning-view__desc">
              {planningProject.description}
            </p>
          )}
        </div>
        <div className="planning-view__header-actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void reload()}
          >
            <RefreshCw size={14} /> Reload
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onEditProject}
          >
            <Pencil size={14} /> Edit
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onDeleteProject}
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </header>
      {error && <div className="planning-tab__error">{error}</div>}
      <div className="planning-gantt-toolbar">
        <label className="planning-gantt-toolbar__check">
          <input
            type="checkbox"
            checked={confirmEnabled}
            onChange={(e) => setConfirmEnabled(e.target.checked)}
          />
          <span>Confirm before applying drag changes</span>
        </label>
        <span className="planning-gantt-toolbar__hint">
          {confirmEnabled
            ? "Each drag opens a confirmation dialog."
            : "Drag-and-drop applies immediately — no confirmation."}
        </span>
        <span className="planning-gantt-toolbar__spacer" />
        <div
          className="planning-gantt-toolbar__zoom"
          role="radiogroup"
          aria-label="Zoom level"
          title="Mouse wheel over the Gantt zooms; Shift+wheel scrolls horizontally"
        >
          <ZoomOut size={12} />
          {ZOOM_LEVELS.map((z) => (
            <button
              key={z.id}
              type="button"
              className={`planning-gantt-toolbar__zoom-btn ${zoom === z.id ? "planning-gantt-toolbar__zoom-btn--on" : ""}`}
              onClick={() => setZoom(z.id)}
              role="radio"
              aria-checked={zoom === z.id}
              title={`Zoom to ${z.label.toLowerCase()} density`}
            >
              {z.label}
            </button>
          ))}
          <ZoomIn size={12} />
        </div>
        <button
          type="button"
          className="btn btn--primary btn--xs"
          onClick={() => setWishModal({ kind: "new" })}
          title="Add a new wish"
        >
          <Plus size={12} /> New wish
        </button>
      </div>
      <div
        ref={ganttRef}
        className="planning-gantt"
        style={{ width: totalWidth, minWidth: "100%" }}
      >
        {/* Header */}
        <div
          className="planning-gantt__header"
          style={{ width: totalWidth }}
        >
          <div
            className="planning-gantt__corner"
            style={{ width: HEADER_ROW_LABEL_WIDTH }}
          />
          <div className="planning-gantt__weeks">
            {weekHeaders.map((wh, i) => (
              <div
                key={i}
                className="planning-gantt__week"
                style={{ width: wh.span * dayWidthPx }}
              >
                {wh.label}
              </div>
            ))}
          </div>
        </div>
        {sprints.length > 0 && (
          <div className="planning-gantt__sprints" style={{ width: totalWidth }}>
            <div
              className="planning-gantt__row-label planning-gantt__row-label--sprint"
              style={{ width: HEADER_ROW_LABEL_WIDTH }}
            >
              Sprints
            </div>
            <div
              className="planning-gantt__sprint-track"
              style={{ width: days.length * dayWidthPx }}
            >
              {sprints.map((s, i) => (
                <div
                  key={`sp-${i}`}
                  className={`planning-gantt__sprint planning-gantt__sprint--${i % 2 === 0 ? "a" : "b"}`}
                  style={{
                    left: s.idx * dayWidthPx,
                    width: s.spanDays * dayWidthPx,
                  }}
                  title={`${s.label} — ${s.spanDays} working days`}
                >
                  {s.label}
                </div>
              ))}
            </div>
          </div>
        )}
        <div
          className="planning-gantt__days"
          style={{ width: totalWidth }}
        >
          <div
            className="planning-gantt__row-label"
            style={{ width: HEADER_ROW_LABEL_WIDTH }}
          />
          {days.map((d, i) => (
            <div
              key={i}
              className={`planning-gantt__day${d.isWorkingDay ? "" : " planning-gantt__day--nonworking"}`}
              style={{ width: dayWidthPx }}
              title={d.isWorkingDay ? undefined : d.iso}
            >
              {d.date.getUTCDate()}
            </div>
          ))}
        </div>
        {/* Body rows */}
        {teamRows.map((row) => {
          const rowWishes = wishesByTeam.get(row.id) ?? [];
          const placedWishes = rowWishes.filter((w) => w.plannedStartDate);
          // Per-day active count for this lane → conflict spans where the
          // simultaneous wish count exceeds the team's maxParallel. Null team
          // (Unassigned) treats the cap as 1 (any overlap = conflict).
          const cap = row.team?.maxParallel ?? 1;
          const overload = new Array<number>(days.length).fill(0);
          for (const w of placedWishes) {
            const layout = wishLayout(w);
            if (!layout) continue;
            const lo = Math.max(0, layout.startIdx);
            const hi = Math.min(days.length - 1, layout.endIdx);
            // Only count working days toward capacity overload.
            for (let i = lo; i <= hi; i++) {
              if (days[i]?.isWorkingDay) overload[i]! += 1;
            }
          }
          // Build contiguous spans of conflict (overload[i] > cap).
          const conflictSpans: Array<{ start: number; end: number }> = [];
          let spanStart: number | null = null;
          for (let i = 0; i < overload.length; i++) {
            const isConflict = overload[i]! > cap;
            if (isConflict && spanStart === null) spanStart = i;
            else if (!isConflict && spanStart !== null) {
              conflictSpans.push({ start: spanStart, end: i - 1 });
              spanStart = null;
            }
          }
          if (spanStart !== null)
            conflictSpans.push({ start: spanStart, end: overload.length - 1 });

          // Wishes whose footprint overlaps any conflict span are themselves
          // flagged → red outline + alert icon.
          const conflictWishIds = new Set<number>();
          if (conflictSpans.length > 0) {
            for (const w of placedWishes) {
              const layout = wishLayout(w);
              if (!layout) continue;
              const wLo = layout.startIdx;
              const wHi = layout.endIdx;
              for (const cs of conflictSpans) {
                if (wLo <= cs.end && wHi >= cs.start) {
                  conflictWishIds.add(w.id);
                  break;
                }
              }
            }
          }

          return (
            <div
              key={row.id}
              className="planning-gantt__row"
              style={{ height: ROW_HEIGHT_PX, width: totalWidth }}
            >
              <div
                className="planning-gantt__row-label"
                style={{ width: HEADER_ROW_LABEL_WIDTH, height: ROW_HEIGHT_PX }}
                title={
                  row.team
                    ? `${row.team.name} — max ${row.team.maxParallel} parallel`
                    : "Wishes without a team assignment"
                }
              >
                <span
                  className="planning-gantt__row-swatch"
                  style={
                    row.team?.color
                      ? { background: row.team.color }
                      : undefined
                  }
                />
                {row.name}
                {conflictSpans.length > 0 && (
                  <span
                    className="planning-gantt__row-warn"
                    title={`${conflictWishIds.size} wish(es) overlap beyond capacity (${cap}).`}
                  >
                    <AlertCircle size={12} />
                  </span>
                )}
              </div>
              <div
                className="planning-gantt__lane"
                style={{
                  width: days.length * dayWidthPx,
                  height: ROW_HEIGHT_PX,
                }}
              >
                {/* Day grid background — non-working columns get a gray tint */}
                {days.map((d, i) => (
                  <div
                    key={i}
                    className={`planning-gantt__lane-cell${d.isWorkingDay ? "" : " planning-gantt__lane-cell--nonworking"}`}
                    style={{
                      left: i * dayWidthPx,
                      width: dayWidthPx,
                      height: ROW_HEIGHT_PX,
                    }}
                  />
                ))}
                {/* Conflict overlay strips */}
                {conflictSpans.map((cs, i) => (
                  <div
                    key={`cf-${i}`}
                    className="planning-gantt__conflict"
                    style={{
                      left: cs.start * dayWidthPx,
                      width: (cs.end - cs.start + 1) * dayWidthPx,
                      height: ROW_HEIGHT_PX,
                    }}
                    title={`Overlap exceeds team capacity (${cap}). Move or resize one of the wishes.`}
                  />
                ))}
                {/* Sprint boundary lines (skip the very first which sits at
                    the project start and is implicit). */}
                {sprints.slice(1).map((s, i) => (
                  <div
                    key={`spl-${i}`}
                    className="planning-gantt__sprint-line"
                    style={{
                      left: s.idx * dayWidthPx,
                      height: ROW_HEIGHT_PX,
                    }}
                    aria-hidden="true"
                  />
                ))}
                {/* Deadline lines */}
                {deadlineLines.map(({ deadline, idx }) => (
                  <div
                    key={`dl-${deadline.id}`}
                    className="planning-gantt__deadline"
                    style={{
                      left: idx * dayWidthPx + dayWidthPx,
                      borderColor: deadline.color ?? undefined,
                      height: ROW_HEIGHT_PX,
                    }}
                    title={`${deadline.name} — ${deadline.dueDate}`}
                  />
                ))}
                {/* Wish bars */}
                {placedWishes.map((wish) => {
                  const layout = wishLayout(wish);
                  if (!layout) return null;
                  const drag = dragDelta?.wishId === wish.id ? dragDelta : null;
                  const resize =
                    resizeDelta?.wishId === wish.id ? resizeDelta : null;
                  // Bar start: shift by drag.deltaDays calendar columns.
                  const idx = drag
                    ? Math.max(0, layout.startIdx + drag.deltaDays)
                    : layout.startIdx;
                  // Bar end: shift endIdx by calendar-day resize delta.
                  const previewEndIdx = resize
                    ? Math.max(idx, layout.endIdx + resize.deltaDays)
                    : layout.endIdx;
                  const barWidthPx = Math.max(
                    dayWidthPx - 4,
                    (previewEndIdx - idx + 1) * dayWidthPx - 4,
                  );
                  const dragYPx = drag ? drag.deltaRows * ROW_HEIGHT_PX : 0;
                  const isConflict = conflictWishIds.has(wish.id);
                  return (
                    <div
                      key={wish.id}
                      className={`planning-gantt__bar ${drag ? "planning-gantt__bar--dragging" : ""} ${isConflict ? "planning-gantt__bar--conflict" : ""}`}
                      style={{
                        left: idx * dayWidthPx + 2,
                        width: barWidthPx,
                        background: row.team?.color ?? undefined,
                        transform: dragYPx ? `translateY(${dragYPx}px)` : undefined,
                        zIndex: drag || resize ? 5 : undefined,
                      }}
                      title={`${wish.jiraKey ? `[${wish.jiraKey}] ` : ""}${wish.title} (${layout.durationDays}d${resize ? " — drag right edge to resize" : ""}${isConflict ? " — overlaps another wish on this team" : ""}) — double-click to edit`}
                      onPointerDown={(e) => onBarPointerDown(e, wish, layout)}
                      onPointerMove={onBarPointerMove}
                      onPointerUp={(e) => onBarPointerUp(e, wish)}
                      onDoubleClick={() =>
                        setWishModal({ kind: "edit", wish })
                      }
                    >
                      {isConflict && (
                        <span className="planning-gantt__bar-warn" aria-hidden="true">
                          <AlertCircle size={12} />
                        </span>
                      )}
                      <span className="planning-gantt__bar-label">
                        {wish.jiraKey && (
                          <span className="planning-gantt__bar-jira">
                            {wish.jiraKey}
                          </span>
                        )}
                        {wish.title}
                        {resize && resize.deltaDays !== 0 ? ` (${layout.durationDays}d)` : ""}
                      </span>
                      <div
                        className="planning-gantt__bar-handle"
                        title="Drag to change duration"
                        onPointerDown={(e) => onResizePointerDown(e, wish)}
                        onPointerMove={onResizePointerMove}
                        onPointerUp={(e) => onResizePointerUp(e, wish)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {/* Unscheduled wishes pane */}
      <UnscheduledList
        wishes={wishes.filter((w) => !w.plannedStartDate)}
        teamsById={new Map(teams.map((t) => [t.id, t]))}
        onSchedule={handleScheduleAtStart}
      />

      <PlanningSuggestionPanel
        planningProjectId={planningProject.id}
        suggestion={suggestion}
        wishes={wishes}
        busy={busy}
        onGenerate={handleGenerate}
        onApplied={() => reload()}
        onRejected={() => reload()}
      />

      {/* Tail note: dates beyond visible window are clamped. */}
      {wishes.some(
        (w) =>
          w.plannedEndDate && timelineLastIso && w.plannedEndDate > timelineLastIso,
      ) && (
        <p className="planning-gantt__hint">
          Some wishes extend past the visible 12-week window — open Wishes to
          adjust their dates or duration.
        </p>
      )}

      <ConfirmDialog
        open={confirmResize !== null}
        title="Change wish duration"
        message={
          confirmResize ? (
            <>
              Change <strong>{confirmResize.wish.title}</strong> from{" "}
              <strong>{confirmResize.wish.durationDays}</strong> working day
              {confirmResize.wish.durationDays === 1 ? "" : "s"} to{" "}
              <strong>{confirmResize.newDuration}</strong> working day
              {confirmResize.newDuration === 1 ? "" : "s"}? A new schedule
              advice will be generated automatically.
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Change duration"
        cancelLabel="Cancel"
        onConfirm={() => {
          const c = confirmResize;
          setConfirmResize(null);
          if (c) void applyResize(c.wish, c.newDuration);
        }}
        onCancel={() => setConfirmResize(null)}
      />

      <ConfirmDialog
        open={confirmDrag !== null}
        title="Apply drag changes"
        message={
          confirmDrag ? (
            <>
              Apply the following change to{" "}
              <strong>{confirmDrag.wish.title}</strong>?
              <ul style={{ marginTop: 8, paddingLeft: 18 }}>
                {confirmDrag.oldStart !== confirmDrag.newStart && (
                  <li>
                    Start date:{" "}
                    <strong>{confirmDrag.oldStart ?? "unscheduled"}</strong>{" "}
                    → <strong>{confirmDrag.newStart}</strong>
                  </li>
                )}
                {confirmDrag.oldTeamId !== confirmDrag.newTeamId && (
                  <li>
                    Team: <strong>{confirmDrag.oldTeamName}</strong> →{" "}
                    <strong>{confirmDrag.newTeamName}</strong>
                  </li>
                )}
              </ul>
              A new schedule advice will be generated automatically.
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Apply"
        cancelLabel="Cancel"
        onConfirm={() => {
          const c = confirmDrag;
          setConfirmDrag(null);
          if (!c) return;
          const startChanged = c.oldStart !== c.newStart;
          const teamChanged = c.oldTeamId !== c.newTeamId;
          void applyDrag({
            wishId: c.wish.id,
            newStart: startChanged ? c.newStart : undefined,
            newEnd: startChanged ? c.newEnd : undefined,
            newTeamId: teamChanged ? c.newTeamId : undefined,
          });
        }}
        onCancel={() => setConfirmDrag(null)}
      />

      {wishModal && (
        <Modal onClose={() => setWishModal(null)} size="md">
          <Modal.Header
            title={
              wishModal.kind === "edit"
                ? `Edit wish "${wishModal.wish.title}"`
                : "New wish"
            }
          />
          <PlanningWishForm
            initial={wishModal.kind === "edit" ? wishModal.wish : null}
            teams={teams}
            deadlines={deadlines}
            tags={tags}
            allWishes={wishes}
            onCancel={() => setWishModal(null)}
            onSubmit={async (body) => {
              try {
                if (wishModal.kind === "edit") {
                  await patchPlanningWish(wishModal.wish.id, {
                    title: body.title,
                    description: body.description,
                    durationDays: body.durationDays,
                    teamId: body.teamId,
                    deadlineId: body.deadlineId,
                    plannedStartDate: body.plannedStartDate,
                    plannedEndDate: body.plannedEndDate,
                    status: body.status,
                    dependsOnWishes: body.dependsOnWishes,
                    dependsOnTags: body.dependsOnTags,
                    tagIds: body.tagIds,
                    jiraKey: body.jiraKey,
                  });
                } else {
                  await createPlanningWish(planningProject.id, {
                    title: body.title ?? "",
                    description: body.description,
                    durationDays: body.durationDays,
                    teamId: body.teamId,
                    deadlineId: body.deadlineId,
                    plannedStartDate: body.plannedStartDate,
                    plannedEndDate: body.plannedEndDate,
                    status: body.status,
                    dependsOnWishes: body.dependsOnWishes,
                    dependsOnTags: body.dependsOnTags,
                    tagIds: body.tagIds,
                    jiraKey: body.jiraKey,
                  });
                }
                setWishModal(null);
                await reload();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function UnscheduledList({
  wishes,
  teamsById,
  onSchedule,
}: {
  wishes: PlanningWish[];
  teamsById: Map<number, PlanningTeam>;
  onSchedule: (w: PlanningWish) => void | Promise<void>;
}) {
  if (wishes.length === 0) return null;
  return (
    <section className="planning-unscheduled">
      <h3>Unscheduled wishes</h3>
      <ul>
        {wishes.map((w) => {
          const team = w.teamId !== null ? teamsById.get(w.teamId) : null;
          return (
            <li key={w.id}>
              <span className="planning-unscheduled__title">{w.title}</span>
              <span className="planning-unscheduled__meta">
                {w.durationDays}d{team ? ` · ${team.name}` : ""}
              </span>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void onSchedule(w)}
              >
                Place at project start
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

