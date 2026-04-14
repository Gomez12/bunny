import { useEffect, useState } from "react";
import { fetchMessages, groupTurns, reorderReasoning, type HistoryTurn } from "../api";
import MessageBubble from "../components/MessageBubble";
import ReasoningBlock from "../components/ReasoningBlock";
import ToolCallCard from "../components/ToolCallCard";
import SessionSidebar from "../components/SessionSidebar";
import StatsFooter from "../components/StatsFooter";

export default function MessagesTab() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<HistoryTurn[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activeId) {
      setTurns([]);
      return;
    }
    setLoading(true);
    fetchMessages(activeId)
      .then((msgs) => setTurns(groupTurns(reorderReasoning(msgs))))
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
  }, [activeId]);

  return (
    <div className="messages">
      <SessionSidebar activeId={activeId} onPick={setActiveId} onNew={() => setActiveId(null)} />
      <section className="messages__transcript">
        {loading && <div className="messages__loading">Loading…</div>}
        {!loading && !activeId && (
          <div className="messages__empty">Select a session on the left.</div>
        )}
        {!loading && activeId && turns.length === 0 && (
          <div className="messages__empty">Session has no messages yet.</div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="turn">
            <MessageBubble role="user">{t.prompt}</MessageBubble>
            <MessageBubble role="assistant">
              {t.reasoning && <ReasoningBlock text={t.reasoning} />}
              {t.toolCalls.map((tc) => (
                <ToolCallCard
                  key={tc.id}
                  name={tc.name}
                  args={tc.args}
                  ok={tc.ok}
                  output={tc.output}
                />
              ))}
              {t.content && <div className="bubble__content">{t.content}</div>}
              <StatsFooter stats={t.stats} />
            </MessageBubble>
          </div>
        ))}
      </section>
    </div>
  );
}
