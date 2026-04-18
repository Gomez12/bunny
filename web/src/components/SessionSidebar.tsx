import { memo, useEffect, useState } from "react";
import {
  fetchSessions,
  setSessionHiddenFromChat,
  type SessionSummary,
} from "../api";

interface Props {
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  /** Optional second action: start a new Quick Chat (auto-hides after inactivity). */
  onNewQuickChat?: () => void;
  /** Bump this to force a refetch (e.g. after a turn completes). */
  refreshKey?: unknown;
  /** "mine" (default) or "all" — only honored server-side for admins. */
  scope?: "mine" | "all";
  /** Show owner badge next to each session (useful under Messages for admins). */
  showOwner?: boolean;
  /** Restrict the listed sessions to a single project. */
  project?: string;
  /** When true, exclude hidden sessions. The toggle below flips this. */
  excludeHidden?: boolean;
  /** When provided, renders a "Show hidden" toggle. `value` is true when
   *  hidden sessions should be displayed. */
  showHiddenToggle?: { value: boolean; onChange: (v: boolean) => void };
  /** Render a per-row hide/unhide control. Default false. */
  allowToggleHidden?: boolean;
  /** Admin-only scope toggle. When provided, renders a segmented control. */
  scopeToggle?: { value: "mine" | "all"; onChange: (v: "mine" | "all") => void };
}

function sameSessions(a: SessionSummary[], b: SessionSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i]!.sessionId !== b[i]!.sessionId ||
      a[i]!.lastTs !== b[i]!.lastTs ||
      a[i]!.hiddenFromChat !== b[i]!.hiddenFromChat ||
      a[i]!.isQuickChat !== b[i]!.isQuickChat
    ) {
      return false;
    }
  }
  return true;
}

export default memo(function SessionSidebar({
  activeId,
  onPick,
  onNew,
  onNewQuickChat,
  refreshKey,
  scope,
  showOwner,
  project,
  excludeHidden,
  showHiddenToggle,
  allowToggleHidden,
  scopeToggle,
}: Props) {
  const [search, setSearch] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [localBump, setLocalBump] = useState(0);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const list = await fetchSessions(search.trim() || undefined, {
          scope,
          project,
          excludeHidden,
        });
        setSessions((prev) => (sameSessions(prev, list) ? prev : list));
      } catch (e) {
        console.error(e);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [search, refreshKey, scope, project, excludeHidden, localBump]);

  const toggleHidden = async (s: SessionSummary) => {
    const next = !s.hiddenFromChat;
    // Optimistic: when excluding hidden ones, immediately drop the row;
    // otherwise just flip the flag and keep it in place.
    setSessions((prev) =>
      excludeHidden && next
        ? prev.filter((p) => p.sessionId !== s.sessionId)
        : prev.map((p) => (p.sessionId === s.sessionId ? { ...p, hiddenFromChat: next } : p)),
    );
    try {
      await setSessionHiddenFromChat(s.sessionId, next);
    } catch (e) {
      console.error(e);
      // Roll back by refetching.
      setLocalBump((n) => n + 1);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__new-row">
        <button className="btn btn--send sidebar__new" onClick={onNew}>
          + New chat
        </button>
        {onNewQuickChat && (
          <button
            type="button"
            className="btn btn--ghost sidebar__new-quick"
            title="Start a Quick Chat — auto-hides after 15 min of inactivity"
            onClick={onNewQuickChat}
          >
            + Quick
          </button>
        )}
      </div>
      <input
        type="search"
        className="sidebar__search"
        placeholder="Search messages…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {scopeToggle && (
        <div className="sidebar__scope" role="tablist" aria-label="Session scope">
          <button
            type="button"
            role="tab"
            aria-selected={scopeToggle.value === "mine"}
            className={
              "sidebar__scope-btn" +
              (scopeToggle.value === "mine" ? " sidebar__scope-btn--active" : "")
            }
            onClick={() => scopeToggle.onChange("mine")}
          >
            Mine
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scopeToggle.value === "all"}
            className={
              "sidebar__scope-btn" +
              (scopeToggle.value === "all" ? " sidebar__scope-btn--active" : "")
            }
            onClick={() => scopeToggle.onChange("all")}
          >
            All
          </button>
        </div>
      )}
      <div className="sidebar__section">
        <span>Sessions</span>
        {showHiddenToggle && (
          <label className="sidebar__hidden-toggle" title="Show sessions you have hidden">
            <input
              type="checkbox"
              checked={showHiddenToggle.value}
              onChange={(e) => showHiddenToggle.onChange(e.target.checked)}
            />
            Show hidden
          </label>
        )}
      </div>
      <ul className="sidebar__list">
        {sessions.length === 0 && (
          <li className="sidebar__empty">No sessions yet.</li>
        )}
        {sessions.map((s) => (
          <li key={s.sessionId} className="sidebar__row">
            <button
              className={
                "sidebar__item" +
                (s.sessionId === activeId ? " sidebar__item--active" : "") +
                (s.hiddenFromChat ? " sidebar__item--hidden" : "") +
                (s.isQuickChat ? " sidebar__item--quick" : "")
              }
              onClick={() => onPick(s.sessionId)}
              title={
                (s.isQuickChat ? "(quick chat)\n" : "") +
                (s.hiddenFromChat ? "(hidden from chat)\n" : "") +
                new Date(s.lastTs).toLocaleString()
              }
            >
              <div className="sidebar__item-title">
                {s.isQuickChat && <span className="sidebar__quick-badge">QC</span>}
                {s.title || "(untitled)"}
              </div>
              <div className="sidebar__item-meta">
                {showOwner && (
                  <span className="sidebar__owner">
                    {s.displayName || s.username || "anonymous"}
                  </span>
                )}
                <span>{s.messageCount} msg</span>
                {s.hiddenFromChat && <span className="sidebar__hidden-badge">hidden</span>}
              </div>
            </button>
            {allowToggleHidden && (
              <button
                type="button"
                className="sidebar__hide-btn"
                title={s.hiddenFromChat ? "Show in chat" : "Hide from chat"}
                aria-label={s.hiddenFromChat ? "Show in chat" : "Hide from chat"}
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleHidden(s);
                }}
              >
                {s.hiddenFromChat ? "👁" : "✕"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
});
