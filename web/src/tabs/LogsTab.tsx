import { Fragment, useEffect, useMemo, useState } from "react";
import {
  listEventFacets,
  listEvents,
  type EventsFilter,
  type LogEvent,
} from "../api";

const PAGE_SIZE = 100;

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").replace("Z", "");
}

function parseLocalDateTime(v: string): number | undefined {
  if (!v) return undefined;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : undefined;
}

function prettyJson(raw: string | null): string {
  if (!raw) return "(no payload)";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default function LogsTab() {
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [userId, setUserId] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [fromStr, setFromStr] = useState("");
  const [toStr, setToStr] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const [items, setItems] = useState<LogEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);

  const [facets, setFacets] = useState<{ topics: string[]; kinds: string[] }>({
    topics: [],
    kinds: [],
  });

  useEffect(() => {
    void listEventFacets()
      .then(setFacets)
      .catch(() => {
        // non-fatal; dropdowns just stay empty
      });
  }, []);

  const filter: EventsFilter = useMemo(
    () => ({
      topic: topic || undefined,
      kind: kind || undefined,
      sessionId: sessionId.trim() || undefined,
      userId: userId.trim() || undefined,
      errorsOnly,
      fromTs: parseLocalDateTime(fromStr),
      toTs: parseLocalDateTime(toStr),
      q: q.trim() || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [topic, kind, sessionId, userId, errorsOnly, fromStr, toStr, q, page],
  );

  useEffect(() => {
    const ac = new AbortController();
    const h = setTimeout(() => {
      setLoading(true);
      setErr(null);
      listEvents(filter)
        .then((r) => {
          if (ac.signal.aborted) return;
          setItems(r.items);
          setTotal(r.total);
        })
        .catch((e: unknown) => {
          if (ac.signal.aborted) return;
          setErr(e instanceof Error ? e.message : "Failed to load events");
        })
        .finally(() => {
          if (!ac.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      ac.abort();
      clearTimeout(h);
    };
  }, [filter, reloadKey]);

  useEffect(() => {
    setPage(0);
  }, [topic, kind, sessionId, userId, errorsOnly, fromStr, toStr, q]);

  const refresh = () => setReloadKey((k) => k + 1);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const toggleRow = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="logs-tab">
      <div className="logs-toolbar">
        <select value={topic} onChange={(e) => setTopic(e.target.value)}>
          <option value="">All topics</option>
          {facets.topics.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {facets.kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          placeholder="Session id…"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
        />
        <input
          placeholder="User id…"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
        <input
          placeholder="Payload search…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <input
          type="datetime-local"
          value={fromStr}
          onChange={(e) => setFromStr(e.target.value)}
          title="From (inclusive)"
        />
        <input
          type="datetime-local"
          value={toStr}
          onChange={(e) => setToStr(e.target.value)}
          title="To (inclusive)"
        />
        <label className="logs-check">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
          />
          Errors only
        </label>
        <button onClick={refresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="logs-pager">
        <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
          « prev
        </button>
        <span className="muted">
          Page {page + 1} / {totalPages} — {total.toLocaleString()} events
        </span>
        <button
          onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          disabled={page >= totalPages - 1}
        >
          next »
        </button>
      </div>

      {err && <div className="auth-error">{err}</div>}

      <table className="logs-table">
        <thead>
          <tr>
            <th style={{ width: "13rem" }}>ts</th>
            <th style={{ width: "6rem" }}>topic</th>
            <th style={{ width: "6rem" }}>kind</th>
            <th>session</th>
            <th>user</th>
            <th style={{ width: "5rem" }}>ms</th>
            <th>error</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => {
            const open = expanded.has(e.id);
            return (
              <Fragment key={e.id}>
                <tr
                  onClick={() => toggleRow(e.id)}
                  className={`logs-row ${open ? "logs-row--open" : ""} ${e.error ? "logs-row--error" : ""}`}
                >
                  <td className="mono">{fmtTs(e.ts)}</td>
                  <td>{e.topic}</td>
                  <td>{e.kind}</td>
                  <td className="mono truncate" title={e.sessionId ?? ""}>
                    {e.sessionId ?? <span className="muted">—</span>}
                  </td>
                  <td className="mono truncate" title={e.userId ?? ""}>
                    {e.userId ?? <span className="muted">—</span>}
                  </td>
                  <td className="mono num">{e.durationMs ?? ""}</td>
                  <td className="error-cell">
                    {e.error ?? <span className="muted">—</span>}
                  </td>
                </tr>
                {open && (
                  <tr className="logs-payload-row">
                    <td colSpan={7}>
                      <div className="logs-payload-actions">
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void navigator.clipboard.writeText(prettyJson(e.payloadJson));
                          }}
                        >
                          Copy payload
                        </button>
                      </div>
                      <pre className="logs-payload">{prettyJson(e.payloadJson)}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {!loading && items.length === 0 && (
            <tr>
              <td colSpan={7} className="muted" style={{ padding: "1rem", textAlign: "center" }}>
                No events match these filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
