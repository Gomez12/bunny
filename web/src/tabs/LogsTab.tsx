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

const N = new Intl.NumberFormat();

interface PayloadView {
  pretty: string;
  chars: number;
  bytes: number;
  lines: number;
}

function buildPayloadView(raw: string | null): PayloadView {
  const pretty = prettyJson(raw);
  return {
    pretty,
    chars: raw?.length ?? 0,
    bytes: raw ? new Blob([raw]).size : 0,
    lines: pretty.split("\n").length,
  };
}

function toggleInSet<T>(
  setter: (updater: (prev: Set<T>) => Set<T>) => void,
  id: T,
): void {
  setter((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
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
  const [rawById, setRawById] = useState<Set<number>>(new Set());
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
  const toggleRow = (id: number) => toggleInSet(setExpanded, id);
  const toggleRaw = (id: number) => toggleInSet(setRawById, id);

  const viewById = useMemo(() => {
    const map = new Map<number, PayloadView>();
    for (const e of items) map.set(e.id, buildPayloadView(e.payloadJson));
    return map;
  }, [items]);

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
            <th style={{ width: "8rem" }} title="chars · lines">size</th>
            <th>error</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => {
            const open = expanded.has(e.id);
            const view = viewById.get(e.id) ?? buildPayloadView(e.payloadJson);
            const isRaw = rawById.has(e.id);
            const body = isRaw ? (e.payloadJson ?? "(no payload)") : view.pretty;
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
                  <td
                    className="mono num"
                    title={`${view.chars} chars · ${view.lines} lines${view.bytes !== view.chars ? ` · ${view.bytes} bytes` : ""}`}
                  >
                    {view.chars > 0 ? (
                      <>
                        {N.format(view.chars)} · {N.format(view.lines)}L
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="error-cell">
                    {e.error ?? <span className="muted">—</span>}
                  </td>
                </tr>
                {open && (
                  <tr className="logs-payload-row">
                    <td colSpan={8}>
                      <dl className="logs-payload-meta-list">
                        <dt>id</dt>
                        <dd>{e.id}</dd>
                        <dt>ts</dt>
                        <dd>{fmtTs(e.ts)}</dd>
                        <dt>topic</dt>
                        <dd>{e.topic}</dd>
                        <dt>kind</dt>
                        <dd>{e.kind}</dd>
                        <dt>session</dt>
                        <dd>{e.sessionId ?? <span className="muted">—</span>}</dd>
                        <dt>user</dt>
                        <dd>{e.userId ?? <span className="muted">—</span>}</dd>
                        <dt>ms</dt>
                        <dd>
                          {e.durationMs != null ? (
                            N.format(e.durationMs)
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </dd>
                        <dt>error</dt>
                        <dd className={e.error ? "error" : undefined}>
                          {e.error ?? <span className="muted">—</span>}
                        </dd>
                      </dl>
                      <div className="logs-payload-actions">
                        <span className="logs-payload-meta">
                          {N.format(view.chars)} chars
                          {view.bytes !== view.chars && (
                            <> · {N.format(view.bytes)} bytes</>
                          )}{" "}
                          · {N.format(view.lines)} lines
                        </span>
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            toggleRaw(e.id);
                          }}
                        >
                          {isRaw ? "Pretty" : "Raw"}
                        </button>
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void navigator.clipboard.writeText(body);
                          }}
                        >
                          Copy payload
                        </button>
                      </div>
                      <pre className="logs-payload">{body}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {!loading && items.length === 0 && (
            <tr>
              <td colSpan={8} className="muted" style={{ padding: "1rem", textAlign: "center" }}>
                No events match these filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
