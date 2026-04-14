import { useEffect, useState } from "react";
import { fetchSessions, type SessionSummary } from "../api";

interface Props {
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  /** Bump this to force a refetch (e.g. after a turn completes). */
  refreshKey?: unknown;
}

function sameSessions(a: SessionSummary[], b: SessionSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.sessionId !== b[i]!.sessionId || a[i]!.lastTs !== b[i]!.lastTs) return false;
  }
  return true;
}

export default function SessionSidebar({ activeId, onPick, onNew, refreshKey }: Props) {
  const [search, setSearch] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const list = await fetchSessions(search.trim() || undefined);
        setSessions((prev) => (sameSessions(prev, list) ? prev : list));
      } catch (e) {
        console.error(e);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [search, refreshKey]);

  return (
    <aside className="sidebar">
      <button className="btn btn--send sidebar__new" onClick={onNew}>
        + New chat
      </button>
      <input
        type="search"
        className="sidebar__search"
        placeholder="Search messages…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="sidebar__section">Sessions</div>
      <ul className="sidebar__list">
        {sessions.length === 0 && (
          <li className="sidebar__empty">No sessions yet.</li>
        )}
        {sessions.map((s) => (
          <li key={s.sessionId}>
            <button
              className={`sidebar__item ${
                s.sessionId === activeId ? "sidebar__item--active" : ""
              }`}
              onClick={() => onPick(s.sessionId)}
              title={new Date(s.lastTs).toLocaleString()}
            >
              <div className="sidebar__item-title">{s.title || "(untitled)"}</div>
              <div className="sidebar__item-meta">{s.messageCount} msg</div>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
