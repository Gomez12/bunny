import { useEffect, useRef } from "react";
import Composer from "../components/Composer";
import MessageBubble from "../components/MessageBubble";
import ReasoningBlock from "../components/ReasoningBlock";
import ToolCallCard from "../components/ToolCallCard";
import { useSSEChat } from "../hooks/useSSEChat";

interface Props {
  sessionId: string;
  onTurnComplete?: () => void;
}

export default function ChatTab({ sessionId, onTurnComplete }: Props) {
  const { turns, streaming, send, abort, reset } = useSSEChat(sessionId, onTurnComplete);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    reset();
  }, [sessionId, reset]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  return (
    <div className="chat">
      <div className="chat__scroll" ref={scrollRef}>
        {turns.length === 0 && (
          <div className="chat__empty">
            <h2>How can I help you today?</h2>
            <p>Session <code>{sessionId.slice(0, 8)}</code></p>
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="turn">
            <MessageBubble role="user">{t.prompt}</MessageBubble>
            <MessageBubble role="assistant">
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
              {t.content && <div className="bubble__content">{t.content}</div>}
              {!t.content && !t.reasoning && t.toolCalls.length === 0 && !t.done && (
                <div className="bubble__pending">…</div>
              )}
              {t.error && <div className="bubble__error">error: {t.error}</div>}
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
  );
}
