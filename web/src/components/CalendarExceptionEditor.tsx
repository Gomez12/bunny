/**
 * Shared month-grid calendar component for managing non-working / workable
 * day exceptions across all five scopes (global, project, planning, team, user).
 *
 * Days with exceptions are highlighted:
 *   non_working  → red background
 *   workable     → green background (explicit override)
 * Clicking any day opens a small popover to add / edit / remove an exception.
 * If `onFetchHolidays` is provided an admin "Fetch holidays" button is shown.
 */

import { useCallback, useState } from "react";
import type { CalendarException, ExceptionKind } from "../api";
import { streamFetchHolidays } from "../api";
import { CalendarDays, CalendarOff, ChevronLeft, ChevronRight, ICON_DEFAULTS, Plus, RefreshCw, X } from "../lib/icons";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Props {
  exceptions: CalendarException[];
  canEdit: boolean;
  scope: string;
  scopeId?: string | number;
  onAdd: (date: string, kind: ExceptionKind, name: string) => Promise<void>;
  onUpdate: (id: number, patch: { kind?: ExceptionKind; name?: string }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onFetchHolidays?: (countryCode: string, year: number) => Promise<void>;
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function buildMonthGrid(year: number, month: number): Array<string | null> {
  const firstDay = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  // Week starts Monday (0=Mon…6=Sun), JS: 0=Sun…6=Sat
  const startDow = (firstDay.getUTCDay() + 6) % 7; // Mon=0
  const cells: Array<string | null> = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= lastDay.getUTCDate(); d++) {
    cells.push(isoDate(year, month, d));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function isWeekend(dateStr: string): boolean {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.getUTCDay() === 0 || d.getUTCDay() === 6;
}

export default function CalendarExceptionEditor({
  exceptions,
  canEdit,
  onAdd,
  onUpdate,
  onDelete,
  onFetchHolidays,
}: Props) {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth());
  const [selected, setSelected] = useState<string | null>(null);
  const [holidayOpen, setHolidayOpen] = useState(false);

  const exMap = new Map<string, CalendarException>();
  for (const e of exceptions) exMap.set(e.date, e);

  const cells = buildMonthGrid(year, month);

  function prevMonth() {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  }

  const exc = selected ? exMap.get(selected) : undefined;

  return (
    <div className="cal-editor">
      <div className="cal-editor__toolbar">
        <button type="button" className="btn btn--icon" onClick={prevMonth} aria-label="Previous month">
          <ChevronLeft {...ICON_DEFAULTS} />
        </button>
        <span className="cal-editor__month-label">
          {MONTH_NAMES[month]} {year}
        </span>
        <button type="button" className="btn btn--icon" onClick={nextMonth} aria-label="Next month">
          <ChevronRight {...ICON_DEFAULTS} />
        </button>
        {onFetchHolidays && canEdit && (
          <button
            type="button"
            className="btn btn--sm"
            style={{ marginLeft: "auto" }}
            onClick={() => setHolidayOpen(true)}
            title="Auto-fetch national holidays via agent"
          >
            <RefreshCw size={14} /> Fetch holidays
          </button>
        )}
      </div>

      <div className="cal-editor__grid">
        {DAY_NAMES.map((d) => (
          <div key={d} className="cal-editor__dow">{d}</div>
        ))}
        {cells.map((date, i) => {
          if (!date) return <div key={`empty-${i}`} className="cal-editor__cell cal-editor__cell--empty" />;
          const e = exMap.get(date);
          const weekend = isWeekend(date);
          return (
            <button
              key={date}
              type="button"
              className={[
                "cal-editor__cell",
                weekend && !e ? "cal-editor__cell--weekend" : "",
                e?.kind === "non_working" ? "cal-editor__cell--off" : "",
                e?.kind === "workable" ? "cal-editor__cell--work" : "",
                selected === date ? "cal-editor__cell--selected" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => setSelected(selected === date ? null : date)}
              title={e ? `${e.kind === "non_working" ? "Non-working" : "Workable"}: ${e.name || date}` : date}
            >
              <span className="cal-editor__day-num">{Number(date.slice(8))}</span>
              {e?.name && (
                <span className="cal-editor__dot" aria-hidden="true" title={e.name}>
                  {e.name.slice(0, 5)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selected && (
        <DayPopover
          date={selected}
          exception={exc}
          canEdit={canEdit}
          onClose={() => setSelected(null)}
          onAdd={async (kind, name) => {
            await onAdd(selected, kind, name);
            setSelected(null);
          }}
          onUpdate={async (patch) => {
            if (exc) await onUpdate(exc.id, patch);
            setSelected(null);
          }}
          onDelete={async () => {
            if (exc) await onDelete(exc.id);
            setSelected(null);
          }}
        />
      )}

      <div className="cal-editor__legend">
        <span className="cal-editor__legend-item">
          <span className="cal-editor__legend-swatch cal-editor__legend-swatch--off" /> Non-working
        </span>
        <span className="cal-editor__legend-item">
          <span className="cal-editor__legend-swatch cal-editor__legend-swatch--work" /> Workable override
        </span>
        <span className="cal-editor__legend-item">
          <span className="cal-editor__legend-swatch cal-editor__legend-swatch--weekend" /> Weekend (default)
        </span>
      </div>

      {holidayOpen && onFetchHolidays && (
        <HolidayFetchDialog
          onClose={() => setHolidayOpen(false)}
          onFetch={async (cc, y) => {
            await onFetchHolidays(cc, y);
            setHolidayOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ── DayPopover ──────────────────────────────────────────────────────────────

function DayPopover({
  date,
  exception,
  canEdit,
  onClose,
  onAdd,
  onUpdate,
  onDelete,
}: {
  date: string;
  exception?: CalendarException;
  canEdit: boolean;
  onClose: () => void;
  onAdd: (kind: ExceptionKind, name: string) => Promise<void>;
  onUpdate: (patch: { kind?: ExceptionKind; name?: string }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [kind, setKind] = useState<ExceptionKind>(exception?.kind ?? "non_working");
  const [name, setName] = useState(exception?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (exception) {
        await onUpdate({ kind, name: name.trim() });
      } else {
        await onAdd(kind, name.trim());
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
      setBusy(false);
    }
  };

  return (
    <div className="cal-editor__popover">
      <div className="cal-editor__popover-head">
        <span className="cal-editor__popover-date">{date}</span>
        <button type="button" className="btn btn--icon btn--sm" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>
      {exception && !canEdit && (
        <div className="cal-editor__popover-body">
          <p>
            <strong>{exception.kind === "non_working" ? "Non-working" : "Workable override"}</strong>
            {exception.name ? ` — ${exception.name}` : ""}
          </p>
          {exception.source === "auto_holiday" && (
            <span className="muted" style={{ fontSize: 12 }}>Auto-imported holiday</span>
          )}
        </div>
      )}
      {canEdit && (
        <form className="cal-editor__popover-form" onSubmit={(e) => void handleSubmit(e)}>
          <div className="cal-editor__kind-row">
            <label className="cal-editor__kind-opt">
              <input
                type="radio"
                name="kind"
                value="non_working"
                checked={kind === "non_working"}
                onChange={() => setKind("non_working")}
                disabled={busy}
              />
              <CalendarOff size={14} /> Non-working
            </label>
            <label className="cal-editor__kind-opt">
              <input
                type="radio"
                name="kind"
                value="workable"
                checked={kind === "workable"}
                onChange={() => setKind("workable")}
                disabled={busy}
              />
              <CalendarDays size={14} /> Workable
            </label>
          </div>
          <input
            className="cal-editor__name-input"
            type="text"
            placeholder="Label (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            maxLength={120}
          />
          {err && <div className="cal-editor__err">{err}</div>}
          <div className="cal-editor__popover-actions">
            {exception && (
              <button
                type="button"
                className="btn btn--danger btn--sm"
                disabled={busy}
                onClick={() => void (async () => {
                  setBusy(true);
                  try { await onDelete(); }
                  catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); setBusy(false); }
                })()}
              >
                Remove
              </button>
            )}
            <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>
              {exception ? "Update" : <><Plus size={12} /> Add</>}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── HolidayFetchDialog ───────────────────────────────────────────────────────

function HolidayFetchDialog({
  onClose,
  onFetch,
}: {
  onClose: () => void;
  onFetch: (countryCode: string, year: number) => Promise<void>;
}) {
  const [cc, setCc] = useState("NL");
  const [yr, setYr] = useState(new Date().getFullYear());
  const [status, setStatus] = useState<"idle" | "streaming" | "done" | "error">("idle");
  const [log, setLog] = useState<string[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handleFetch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (status === "streaming") return;
      setStatus("streaming");
      setLog([]);
      setCount(null);
      setErr(null);

      const { abort, done } = streamFetchHolidays(
        cc.toUpperCase(),
        yr,
        (ev) => {
          const raw = ev as unknown as Record<string, unknown>;
          if (raw["type"] === "holidays_inserted") {
            setCount(raw["count"] as number);
          } else if (raw["type"] === "tool_call") {
            setLog((l) => [...l, `→ ${raw["toolName"] as string}`]);
          } else if (raw["type"] === "error") {
            setErr(raw["message"] as string);
          }
        },
      );

      done
        .then(() => {
          setStatus("done");
          void onFetch(cc.toUpperCase(), yr);
        })
        .catch((ex: unknown) => {
          setStatus("error");
          setErr(ex instanceof Error ? ex.message : String(ex));
        });

      return () => abort();
    },
    [cc, yr, onFetch, status],
  );

  return (
    <div className="cal-editor__holiday-dialog">
      <div className="cal-editor__popover-head">
        <span>Fetch national holidays</span>
        <button type="button" className="btn btn--icon btn--sm" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>
      <form
        className="cal-editor__popover-form"
        onSubmit={handleFetch}
      >
        <div className="cal-editor__kind-row">
          <label className="project-form__field" style={{ flex: 1 }}>
            <span>Country (ISO 3166-1)</span>
            <input
              value={cc}
              onChange={(e) => setCc(e.target.value.toUpperCase())}
              maxLength={2}
              pattern="[A-Z]{2}"
              placeholder="NL"
              disabled={status === "streaming"}
              style={{ textTransform: "uppercase" }}
            />
          </label>
          <label className="project-form__field" style={{ flex: 1 }}>
            <span>Year</span>
            <input
              type="number"
              value={yr}
              min={1970}
              max={2100}
              onChange={(e) => setYr(Number(e.target.value))}
              disabled={status === "streaming"}
            />
          </label>
        </div>
        {log.length > 0 && (
          <div className="cal-editor__log">
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
        {count !== null && status === "done" && (
          <div className="cal-editor__ok">Imported {count} holidays.</div>
        )}
        {err && <div className="cal-editor__err">{err}</div>}
        <div className="cal-editor__popover-actions">
          <button type="button" className="btn btn--sm" onClick={onClose}>
            {status === "done" ? "Close" : "Cancel"}
          </button>
          {status !== "done" && (
            <button
              type="submit"
              className="btn btn--primary btn--sm"
              disabled={status === "streaming" || cc.length !== 2}
            >
              {status === "streaming" ? "Fetching…" : "Fetch"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
