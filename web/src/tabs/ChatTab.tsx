import { useEffect, useRef, useState } from "react";
import Composer from "../components/Composer";
import MessageBubble from "../components/MessageBubble";
import MarkdownContent from "../components/MarkdownContent";
import ReasoningBlock from "../components/ReasoningBlock";
import ToolCallCard from "../components/ToolCallCard";
import SessionSidebar from "../components/SessionSidebar";
import StatsFooter from "../components/StatsFooter";
import { fetchMessages, groupTurns, reorderReasoning, type HistoryTurn } from "../api";
import { useSSEChat } from "../hooks/useSSEChat";

interface Props {
  sessionId: string;
  project: string;
  onPickSession: (id: string) => void;
  onNewSession: () => void;
}

export default function ChatTab({ sessionId, project, onPickSession, onNewSession }: Props) {
  const [history, setHistory] = useState<HistoryTurn[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const { turns, streaming, send, abort, reset } = useSSEChat(sessionId, project, () =>
    setRefreshKey((k) => k + 1),
  );

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    reset();
    setLoadingHistory(true);
    fetchMessages(sessionId)
      .then((msgs) => setHistory(groupTurns(reorderReasoning(msgs))))
      .catch((e) => console.error(e))
      .finally(() => setLoadingHistory(false));
  }, [sessionId, reset]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [history, turns]);

  const isEmpty = !loadingHistory && history.length === 0 && turns.length === 0;

  return (
    <div className="chat">
      <SessionSidebar
        activeId={sessionId}
        onPick={onPickSession}
        onNew={onNewSession}
        refreshKey={refreshKey}
        project={project}
      />
      <div className="chat__main">
        <div className="chat__scroll" ref={scrollRef}>
          {isEmpty && (
            <div className="chat__empty">
              <h2>How can I help you today?</h2>
              <p>Session <code>{sessionId.slice(0, 8)}</code></p>
            </div>
          )}
          {history.map((t) => (
            <div key={t.id} className="turn">
              <MessageBubble role="user">{t.prompt}</MessageBubble>
              <MessageBubble role="assistant" author={t.author}>
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
                {t.content && <MarkdownContent text={t.content} />}
                <StatsFooter stats={t.stats} />
              </MessageBubble>
            </div>
          ))}
          {turns.map((t) => (
            <div key={t.id} className="turn">
              <MessageBubble role="user">{t.prompt}</MessageBubble>
              <MessageBubble role="assistant" author={t.author}>
                {t.reasoning && <ReasoningBlock text={t.reasoning} />}
                {t.toolCalls.map((tc) => (
                  <ToolCallCard
                    key={tc.callIndex}
                    name={tc.name}
                    args={tc.args}
                    ok={tc.ok}
                    output={tc.output}
                    error={tc.error}
                  />
                ))}
                {t.content && <MarkdownContent text={t.content} />}
                {!t.content && !t.reasoning && t.toolCalls.length === 0 && !t.done && (
                  <div className="bubble__pending"><span className="spinner" /> waiting for model…</div>
                )}
                {t.error && <div className="bubble__error">error: {t.error}</div>}
                <StatsFooter stats={t.stats} />
              </MessageBubble>
            </div>
          ))}
        </div>
        <div className="chat__composer">
          <Composer
            disabled={streaming}
            streaming={streaming}
            onSubmit={send}
            onAbort={abort}
          />
        </div>
      </div>
    </div>
  );
}
