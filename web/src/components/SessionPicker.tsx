import type { SessionSummary } from "../api";

interface Props {
  sessions: SessionSummary[];
  activeId: string;
  onPick: (id: string) => void;
  onNew: () => void;
}

export default function SessionPicker({ sessions, activeId, onPick, onNew }: Props) {
  const hasActive = sessions.some((s) => s.sessionId === activeId);
  return (
    <div className="session-picker">
      <select
        className="session-picker__select"
        value={activeId}
        onChange={(e) => onPick(e.target.value)}
      >
        {!hasActive && (
          <option value={activeId}>New session · {activeId.slice(0, 8)}</option>
        )}
        {sessions.map((s) => (
          <option key={s.sessionId} value={s.sessionId}>
            {s.title || s.sessionId.slice(0, 8)} · {s.messageCount} msg
          </option>
        ))}
      </select>
      <button className="btn btn--ghost" onClick={onNew} title="New chat">
        + New
      </button>
    </div>
  );
}
