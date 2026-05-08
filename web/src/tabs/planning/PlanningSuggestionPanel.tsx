import { useMemo, useState } from "react";
import {
  type PlanningBottleneck,
  type PlanningSuggestion,
  type PlanningSuggestionPlacement,
  type PlanningWish,
  applyPlanningSuggestion,
  clearPlanningWishAdviceHide,
  patchPlanningWish,
  rejectPlanningSuggestion,
  setPlanningWishAdviceHide,
} from "../../api";
import {
  AlertCircle,
  Check,
  Eye,
  EyeOff,
  RefreshCw,
  X,
} from "../../lib/icons";
import { PLANNING_STORAGE } from "../../lib/planningStorage";

interface Props {
  planningProjectId: number;
  suggestion: PlanningSuggestion | null;
  wishes: PlanningWish[];
  busy: boolean;
  onGenerate: () => void | Promise<void>;
  onApplied: () => void | Promise<void>;
  onRejected: () => void | Promise<void>;
}

export type SuggestionMode = "all" | "conflicts_only";

type ItemRow = {
  placement: PlanningSuggestionPlacement;
  wish: PlanningWish;
  /** true when the wish appears in any bottleneck — used for conflicts-only mode. */
  isConflict: boolean;
  /** Bottleneck explanations attached to this wish. */
  bottlenecks: PlanningBottleneck[];
};

function readMode(): SuggestionMode {
  const raw = localStorage.getItem(PLANNING_STORAGE.suggestionMode);
  return raw === "conflicts_only" ? "conflicts_only" : "all";
}

function readShowHidden(): boolean {
  return localStorage.getItem(PLANNING_STORAGE.suggestionShowHidden) === "1";
}

export default function PlanningSuggestionPanel({
  planningProjectId,
  suggestion,
  wishes,
  busy,
  onGenerate,
  onApplied,
  onRejected,
}: Props) {
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState<
    null | "apply-all" | "reject-all" | "item"
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setModeRaw] = useState<SuggestionMode>(readMode);
  const [showHidden, setShowHiddenRaw] = useState<boolean>(readShowHidden);

  const setMode = (m: SuggestionMode) => {
    localStorage.setItem(PLANNING_STORAGE.suggestionMode, m);
    setModeRaw(m);
  };
  const setShowHidden = (v: boolean) => {
    localStorage.setItem(PLANNING_STORAGE.suggestionShowHidden, v ? "1" : "0");
    setShowHiddenRaw(v);
  };

  const wishById = useMemo(
    () => new Map(wishes.map((w) => [w.id, w])),
    [wishes],
  );

  const conflictWishIds = useMemo(() => {
    const s = new Set<number>();
    for (const b of suggestion?.payload.bottlenecks ?? []) s.add(b.wishId);
    return s;
  }, [suggestion]);

  const bottlenecksByWish = useMemo(() => {
    const m = new Map<number, PlanningBottleneck[]>();
    for (const b of suggestion?.payload.bottlenecks ?? []) {
      const list = m.get(b.wishId);
      if (list) list.push(b);
      else m.set(b.wishId, [b]);
    }
    return m;
  }, [suggestion]);

  // Build visible + hidden item rows. The visible rows are filtered by mode;
  // bottlenecks without an associated placement (e.g., cycle nodes that
  // were not placed) are surfaced separately so they don't disappear.
  const allItemRows = useMemo<ItemRow[]>(() => {
    if (!suggestion) return [];
    return suggestion.payload.placements
      .map((p): ItemRow | null => {
        const w = wishById.get(p.wishId);
        if (!w) return null;
        return {
          placement: p,
          wish: w,
          isConflict: conflictWishIds.has(p.wishId),
          bottlenecks: bottlenecksByWish.get(p.wishId) ?? [],
        };
      })
      .filter((x): x is ItemRow => x !== null);
  }, [suggestion, wishById, conflictWishIds, bottlenecksByWish]);

  const hiddenItemRows = useMemo<ItemRow[]>(() => {
    if (!suggestion) return [];
    const hidden = suggestion.payload.hiddenPlacements ?? [];
    return hidden
      .map((p): ItemRow | null => {
        const w = wishById.get(p.wishId);
        if (!w) return null;
        return {
          placement: p,
          wish: w,
          isConflict: conflictWishIds.has(p.wishId),
          bottlenecks: bottlenecksByWish.get(p.wishId) ?? [],
        };
      })
      .filter((x): x is ItemRow => x !== null);
  }, [suggestion, wishById, conflictWishIds, bottlenecksByWish]);

  // Items that would actually change the wish (start/end different from
  // current). Items where the placement equals the current dates are
  // suppressed from the panel — there's nothing to apply.
  const changedItems = useMemo(
    () =>
      allItemRows.filter(
        (it) =>
          it.placement.start !== it.wish.plannedStartDate ||
          it.placement.end !== it.wish.plannedEndDate,
      ),
    [allItemRows],
  );

  const visibleItems = useMemo(
    () =>
      mode === "conflicts_only"
        ? changedItems.filter((it) => it.isConflict)
        : changedItems,
    [mode, changedItems],
  );

  // Bottlenecks whose wish is NOT in the visible list — surface them so
  // cycles / unmet-tag warnings remain visible regardless of mode.
  const orphanBottlenecks = useMemo(() => {
    const handled = new Set(visibleItems.map((it) => it.wish.id));
    return (suggestion?.payload.bottlenecks ?? []).filter(
      (b) => !handled.has(b.wishId),
    );
  }, [suggestion, visibleItems]);

  const handleApplyItem = async (item: ItemRow) => {
    setSubmitting("item");
    setError(null);
    try {
      await patchPlanningWish(item.wish.id, {
        plannedStartDate: item.placement.start,
        plannedEndDate: item.placement.end,
      });
      // If a hide tuple was pinned to this item, clear it — the user
      // accepted, the hide no longer applies.
      if (
        item.wish.adviceHide.start === item.placement.start &&
        item.wish.adviceHide.end === item.placement.end
      ) {
        await clearPlanningWishAdviceHide(item.wish.id);
      }
      await onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(null);
    }
  };

  const handleHideItem = async (item: ItemRow) => {
    setSubmitting("item");
    setError(null);
    try {
      await setPlanningWishAdviceHide(item.wish.id, {
        start: item.placement.start,
        end: item.placement.end,
        teamId: item.wish.teamId,
      });
      await onApplied(); // reload to reflect the moved item to "hidden" list
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(null);
    }
  };

  const handleUnhideItem = async (item: ItemRow) => {
    setSubmitting("item");
    setError(null);
    try {
      await clearPlanningWishAdviceHide(item.wish.id);
      await onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(null);
    }
  };

  const handleApplyAll = async () => {
    setSubmitting("apply-all");
    setError(null);
    try {
      await applyPlanningSuggestion(planningProjectId, comment);
      setComment("");
      await onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(null);
    }
  };

  const handleRejectAll = async () => {
    setSubmitting("reject-all");
    setError(null);
    try {
      await rejectPlanningSuggestion(planningProjectId, comment);
      setComment("");
      await onRejected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(null);
    }
  };

  const itemDisabled = busy || submitting !== null;

  return (
    <section className="planning-suggestion">
      <header className="planning-suggestion__header">
        <h3>Schedule advice</h3>
        <div className="planning-suggestion__toolbar">
          <ModePicker mode={mode} onPick={setMode} />
          <label className="planning-suggestion__check">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Show hidden ({hiddenItemRows.length})
          </label>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void onGenerate()}
            disabled={busy}
          >
            <RefreshCw size={14} /> {busy ? "Computing…" : "Generate now"}
          </button>
        </div>
      </header>

      {!suggestion && !busy && (
        <p className="planning-suggestion__empty">
          No advice available yet. Click <em>Generate now</em> to compute one,
          or wait for the next periodic refresh.
        </p>
      )}

      {suggestion && (
        <>
          <p className="planning-suggestion__meta">
            Computed at {new Date(suggestion.generatedAt).toLocaleString()}.
            {visibleItems.length === 0
              ? " No advice items in this view."
              : ` ${visibleItems.length} item${visibleItems.length === 1 ? "" : "s"} to review.`}
            {hiddenItemRows.length > 0 && !showHidden
              ? ` ${hiddenItemRows.length} hidden — toggle "Show hidden" to view.`
              : ""}
          </p>

          {orphanBottlenecks.length > 0 && (
            <ul className="planning-suggestion__bottlenecks">
              {orphanBottlenecks.map((b, i) => (
                <li key={`ob-${i}`}>
                  <AlertCircle size={14} />
                  {wishById.get(b.wishId)?.title ?? `Wish #${b.wishId}`} —{" "}
                  {b.message}
                </li>
              ))}
            </ul>
          )}

          {visibleItems.length > 0 && (
            <ul className="planning-suggestion__items">
              {visibleItems.map((it) => (
                <ItemRowView
                  key={`v-${it.wish.id}`}
                  item={it}
                  disabled={itemDisabled}
                  onApply={() => void handleApplyItem(it)}
                  onHide={() => void handleHideItem(it)}
                />
              ))}
            </ul>
          )}

          {showHidden && hiddenItemRows.length > 0 && (
            <details className="planning-suggestion__hidden" open>
              <summary>
                Hidden items ({hiddenItemRows.length})
              </summary>
              <ul className="planning-suggestion__items">
                {hiddenItemRows.map((it) => (
                  <ItemRowView
                    key={`h-${it.wish.id}`}
                    item={it}
                    disabled={itemDisabled}
                    isHidden
                    onApply={() => void handleApplyItem(it)}
                    onUnhide={() => void handleUnhideItem(it)}
                  />
                ))}
              </ul>
            </details>
          )}

          <div className="planning-suggestion__bulk">
            <textarea
              className="planning-suggestion__comment"
              placeholder="Optional comment for next round (saved with the bulk decision)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
            />
            {error && <div className="planning-tab__error">{error}</div>}
            <div className="planning-suggestion__actions">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={itemDisabled || visibleItems.length === 0}
                onClick={() => void handleRejectAll()}
              >
                <X size={14} />{" "}
                {submitting === "reject-all" ? "Rejecting…" : "Reject all"}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={itemDisabled || visibleItems.length === 0}
                onClick={() => void handleApplyAll()}
              >
                <Check size={14} />{" "}
                {submitting === "apply-all" ? "Applying…" : "Apply all"}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function ModePicker({
  mode,
  onPick,
}: {
  mode: SuggestionMode;
  onPick: (m: SuggestionMode) => void;
}) {
  return (
    <div className="planning-suggestion__mode" role="radiogroup">
      <button
        type="button"
        className={`planning-suggestion__mode-btn ${mode === "all" ? "planning-suggestion__mode-btn--on" : ""}`}
        onClick={() => onPick("all")}
        role="radio"
        aria-checked={mode === "all"}
        title="Show every advised change"
      >
        All
      </button>
      <button
        type="button"
        className={`planning-suggestion__mode-btn ${mode === "conflicts_only" ? "planning-suggestion__mode-btn--on" : ""}`}
        onClick={() => onPick("conflicts_only")}
        role="radio"
        aria-checked={mode === "conflicts_only"}
        title="Only show items resolving a current conflict (deadline overrun, cycle, etc.)"
      >
        Conflicts only
      </button>
    </div>
  );
}

function ItemRowView({
  item,
  disabled,
  isHidden = false,
  onApply,
  onHide,
  onUnhide,
}: {
  item: ItemRow;
  disabled: boolean;
  isHidden?: boolean;
  onApply: () => void;
  onHide?: () => void;
  onUnhide?: () => void;
}) {
  const { wish, placement, isConflict, bottlenecks } = item;
  const startChanged = wish.plannedStartDate !== placement.start;
  const endChanged = wish.plannedEndDate !== placement.end;
  return (
    <li
      className={`planning-suggestion__item ${isConflict ? "planning-suggestion__item--conflict" : ""}`}
    >
      <div className="planning-suggestion__item-head">
        <span className="planning-suggestion__item-title">{wish.title}</span>
        {isConflict && (
          <span className="planning-suggestion__item-badge">Conflict</span>
        )}
      </div>
      <div className="planning-suggestion__item-detail">
        <span className="planning-suggestion__item-from">
          {wish.plannedStartDate && wish.plannedEndDate
            ? `${wish.plannedStartDate} → ${wish.plannedEndDate}`
            : "unscheduled"}
        </span>
        <span className="planning-suggestion__item-arrow">→</span>
        <span className="planning-suggestion__item-to">
          {placement.start} → {placement.end}
        </span>
        <span className="planning-suggestion__item-meta">
          {wish.durationDays}d
          {startChanged && endChanged ? " · moved" : startChanged ? " · start changed" : endChanged ? " · end changed" : ""}
        </span>
      </div>
      {bottlenecks.length > 0 && (
        <ul className="planning-suggestion__item-bottlenecks">
          {bottlenecks.map((b, i) => (
            <li key={`bn-${i}`}>
              <AlertCircle size={12} /> {b.message}
            </li>
          ))}
        </ul>
      )}
      <div className="planning-suggestion__item-actions">
        {!isHidden && onHide && (
          <button
            type="button"
            className="btn btn--ghost btn--xs"
            onClick={onHide}
            disabled={disabled}
            title="Hide this advice while these settings are unchanged"
          >
            <EyeOff size={12} /> Hide
          </button>
        )}
        {isHidden && onUnhide && (
          <button
            type="button"
            className="btn btn--ghost btn--xs"
            onClick={onUnhide}
            disabled={disabled}
            title="Show this advice again"
          >
            <Eye size={12} /> Unhide
          </button>
        )}
        <button
          type="button"
          className="btn btn--primary btn--xs"
          onClick={onApply}
          disabled={disabled}
        >
          <Check size={12} /> Apply
        </button>
      </div>
    </li>
  );
}
