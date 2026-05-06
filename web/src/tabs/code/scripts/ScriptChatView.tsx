import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Composer from "../../../components/Composer";
import MessageBubble from "../../../components/MessageBubble";
import MarkdownContent from "../../../components/MarkdownContent";
import ReasoningBlock from "../../../components/ReasoningBlock";
import ToolCallCard from "../../../components/ToolCallCard";
import QueueWaitBadge from "../../../components/QueueWaitBadge";
import StatsFooter from "../../../components/StatsFooter";
import EmptyState from "../../../components/EmptyState";
import {
  fetchMessages,
  groupTurns,
  reorderReasoning,
  streamScriptChat,
  type AuthUser,
  type HistoryTurn,
  type Script,
} from "../../../api";
import { useSSEChat, type ChatStreamer } from "../../../hooks/useSSEChat";
import { MessageCircle } from "../../../lib/icons";
import type { ComposerHandle } from "../../../components/Composer";

const CHAT_SESSION_KEY = (scriptId: number) =>
  `bunny.scriptChatSession.${scriptId}`;

interface Props {
  script: Script;
  currentUser: AuthUser;
}

export default function ScriptChatView({ script, currentUser }: Props) {
  const expandThink = currentUser.expandThinkBubbles;
  const expandTool = currentUser.expandToolBubbles;

  const [history, setHistory] = useState<HistoryTurn[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    return localStorage.getItem(CHAT_SESSION_KEY(script.id));
  });
  const composerRef = useRef<ComposerHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const streamer = useCallback<ChatStreamer>(
    (body, onEvent) => streamScriptChat(script.id, body, onEvent),
    [script.id],
  );

  const mintSessionId = useCallback(
    () => `script-chat-${script.id}-${crypto.randomUUID()}`,
    [script.id],
  );

  // Ensure we have a session ID
  const sessionId = useMemo(() => {
    if (activeSessionId) return activeSessionId;
    const id = mintSessionId();
    localStorage.setItem(CHAT_SESSION_KEY(script.id), id);
    setActiveSessionId(id);
    return id;
  }, [activeSessionId, mintSessionId, script.id]);

  const { turns, streaming, send, abort, reset } = useSSEChat(
    sessionId,
    script.project,
    undefined,
    { streamer },
  );

  // Load history on mount or session change
  useEffect(() => {
    if (!activeSessionId) return;
    fetchMessages(activeSessionId)
      .then((msgs) => setHistory(groupTurns(reorderReasoning(msgs))))
      .catch(() => {});
  }, [activeSessionId]);

  // Reset when script changes
  useEffect(() => {
    reset();
    setHistory([]);
    const stored = localStorage.getItem(CHAT_SESSION_KEY(script.id));
    setActiveSessionId(stored);
  }, [script.id]);

  // Sticky scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [history, turns]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };

  function handleNewChat() {
    const id = mintSessionId();
    localStorage.setItem(CHAT_SESSION_KEY(script.id), id);
    setActiveSessionId(id);
    setHistory([]);
    reset();
  }

  const isEmpty = history.length === 0 && turns.length === 0;

  return (
    <div className="chat chat--embedded">
      <div className="chat__main">
        <div className="chat__scroll" ref={scrollRef} onScroll={handleScroll}>
          {isEmpty ? (
            <EmptyState
              title="Script chat"
              description="Ask the assistant to generate, explain, or improve this script."
              action={null}
            />
          ) : null}

          {history.map((t) => (
            <div key={t.id} className="turn">
              <MessageBubble
                role="user"
                authorDisplayName={t.promptDisplayName}
                authorUsername={t.promptUsername}
                rawContent={t.prompt}
                edited={t.promptEdited}
              >
                {t.prompt}
              </MessageBubble>
              <MessageBubble
                role="assistant"
                author={t.author}
                rawContent={t.content}
                edited={t.contentEdited}
              >
                {t.reasoning && (
                  <ReasoningBlock
                    text={t.reasoning}
                    defaultOpen={expandThink}
                  />
                )}
                {t.toolCalls.map((tc) => (
                  <ToolCallCard
                    key={tc.id}
                    name={tc.name}
                    args={tc.args}
                    ok={tc.ok}
                    output={tc.output}
                    defaultOpen={expandTool}
                  />
                ))}
                {t.content && <MarkdownContent text={t.content} />}
                <StatsFooter stats={t.stats} />
              </MessageBubble>
            </div>
          ))}

          {turns.map((t) => (
            <div key={t.id} className="turn">
              <MessageBubble
                role="user"
                authorDisplayName={currentUser.displayName}
                authorUsername={currentUser.username}
              >
                {t.prompt}
              </MessageBubble>
              <MessageBubble role="assistant" author={t.author}>
                {t.reasoning && (
                  <ReasoningBlock
                    text={t.reasoning}
                    defaultOpen={expandThink}
                  />
                )}
                {t.toolCalls.map((tc) => (
                  <ToolCallCard
                    key={tc.callIndex}
                    name={tc.name}
                    args={tc.args}
                    ok={tc.ok}
                    output={tc.output}
                    error={tc.error}
                    defaultOpen={expandTool}
                  />
                ))}
                {t.content && <MarkdownContent text={t.content} />}
                {!t.content &&
                  !t.reasoning &&
                  t.toolCalls.length === 0 &&
                  !t.done &&
                  t.queueState !== "waiting" && (
                    <div className="bubble__pending">
                      <span className="spinner" /> waiting for model…
                    </div>
                  )}
                {!t.done && t.queueState === "waiting" && (
                  <QueueWaitBadge
                    position={t.queuePosition}
                    waitedTotalMs={t.queueWaitTotalMs}
                  />
                )}
                {t.error && (
                  <div className="bubble__error">error: {t.error}</div>
                )}
                <StatsFooter stats={t.stats} />
              </MessageBubble>
            </div>
          ))}
        </div>

        <div className="chat__composer">
          <div style={{ display: "flex", gap: "8px", marginBottom: "4px" }}>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ fontSize: "11px" }}
              onClick={handleNewChat}
              title="Start a new chat session"
            >
              <MessageCircle size={12} /> New chat
            </button>
          </div>
          <Composer
            ref={composerRef}
            project={script.project}
            disabled={streaming}
            streaming={streaming}
            onSubmit={(prompt, attachments) => {
              stickToBottom.current = true;
              send(prompt, attachments);
            }}
            onAbort={abort}
          />
        </div>
      </div>
    </div>
  );
}
