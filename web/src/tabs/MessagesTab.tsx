import { useEffect, useState } from "react";
import {
  fetchMessages,
  fetchSessions,
  type SessionSummary,
  type StoredMessage,
} from "../api";
import MessageBubble from "../components/MessageBubble";
import ReasoningBlock from "../components/ReasoningBlock";

function sameSessions(a: SessionSummary[], b: SessionSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.sessionId !== b[i]!.sessionId || a[i]!.lastTs !== b[i]!.lastTs) return false;
  }
  return true;
}

// Older turns were persisted as [content, reasoning]; newer turns as [reasoning,
// content]. Swap any legacy pair so the thinking block always renders above
// its answer.
function reorderReasoning(messages: StoredMessage[]): StoredMessage[] {
  const out = messages.slice();
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i]!;
    const b = out[i + 1]!;
    if (
      a.role === "assistant" &&
      b.role === "assistant" &&
      a.channel === "content" &&
      b.channel === "reasoning"
    ) {
      out[i] = b;
      out[i + 1] = a;
    }
  }
  return out;
}

export default function MessagesTab() {
  const [search, setSearch] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const list = await fetchSessions(search.trim() || undefined);
        setSessions((prev) => (sameSessions(prev, list) ? prev : list));
        if (list.length > 0 && !list.some((s) => s.sessionId === activeId)) {
          setActiveId(list[0]!.sessionId);
        }
      } catch (e) {
        console.error(e);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    setLoading(true);
    fetchMessages(activeId)
      .then((msgs) => setMessages(reorderReasoning(msgs)))
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
  }, [activeId]);

  return (
    <div className="messages">
      <aside className="messages__sidebar">
        <input
          type="search"
          className="messages__search"
          placeholder="Search messages…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul className="messages__list">
          {sessions.length === 0 && (
            <li className="messages__empty">No sessions yet.</li>
          )}
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                className={`messages__item ${
                  s.sessionId === activeId ? "messages__item--active" : ""
                }`}
                onClick={() => setActiveId(s.sessionId)}
              >
                <div className="messages__item-title">{s.title || "(untitled)"}</div>
                <div className="messages__item-meta">
                  {new Date(s.lastTs).toLocaleString()} · {s.messageCount} msg
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="messages__transcript">
        {loading && <div className="messages__loading">Loading…</div>}
        {!loading && messages.length === 0 && activeId && (
          <div className="messages__empty">Session has no messages yet.</div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            role={(m.role === "system" ? "assistant" : m.role) as never}
            timestamp={m.ts}
          >
            {m.channel === "reasoning" ? (
              <ReasoningBlock text={m.content ?? ""} />
            ) : m.channel === "tool_result" ? (
              <pre className="bubble__toolresult">
                {m.toolName ? `[${m.toolName}] ` : ""}
                {m.content}
              </pre>
            ) : (
              <div className="bubble__content">{m.content}</div>
            )}
          </MessageBubble>
        ))}
      </section>
    </div>
  );
}
