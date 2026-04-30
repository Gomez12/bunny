import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import Composer, { type ComposerHandle } from "../../components/Composer";
import MessageBubble from "../../components/MessageBubble";
import MarkdownContent from "../../components/MarkdownContent";
import ReasoningBlock from "../../components/ReasoningBlock";
import ToolCallCard from "../../components/ToolCallCard";
import StatsFooter from "../../components/StatsFooter";
import EmptyState from "../../components/EmptyState";
import {
  fetchMessages,
  fetchSessions,
  groupTurns,
  reorderReasoning,
  setSessionHiddenFromChat,
  streamCodeChat,
  type AuthUser,
  type CodeProject,
  type HistoryTurn,
  type SessionSummary,
} from "../../api";
import { useSSEChat, type ChatStreamer } from "../../hooks/useSSEChat";
import { MessageCircle, Plus, Trash2 } from "../../lib/icons";
import { formatRelative } from "../../lib/format";

interface Props {
  codeProject: CodeProject;
  currentUser: AuthUser;
}

/**
 * Code-scoped chat pane. Structurally mirrors `ChatTab`: sidebar on the left
 * (code-chat sessions only), `chat__main` on the right with the same
 * `MessageBubble` / `Composer` / `StatsFooter` primitives the main Chat tab
 * uses — so the UX feels identical. The only difference is the transport:
 * `streamCodeChat` POSTs to `/api/code/:id/chat`, which pins the code-project
 * system prompt on the agent loop.
 */
export default function CodeChatView({ codeProject, currentUser }: Props) {
  const expandThink = currentUser.expandThinkBubbles;
  const expandTool = currentUser.expandToolBubbles;

  const sessionPrefix = useMemo(
    () => `code-chat-${codeProject.id}-`,
    [codeProject.id],
  );

  const mintSessionId = useCallback(
    () => `${sessionPrefix}${crypto.randomUUID()}`,
    [sessionPrefix],
  );

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryTurn[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const all = await fetchSessions(undefined, {
        project: codeProject.project,
        excludeHidden: true,
      });
      const filtered = all
        .filter((s) => s.sessionId.startsWith(sessionPrefix))
        .sort((a, b) => b.lastTs - a.lastTs);
      setSessions(filtered);
      return filtered;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return [];
    }
  }, [codeProject.project, sessionPrefix]);

  // Per-code-project streamer — memoised so useSSEChat's `send` keeps a
  // stable reference while streaming.
  const streamer: ChatStreamer = useCallback(
    (body, onEvent) => streamCodeChat(codeProject.id, body, onEvent),
    [codeProject.id],
  );

  const { turns, streaming, send, abort, reset } = useSSEChat(
    activeSessionId ?? "",
    codeProject.project,
    () => void refreshSessions(),
    { streamer },
  );

  // Load sessions on project switch; auto-select most recent (or null).
  useEffect(() => {
    setError(null);
    setActiveSessionId(null);
    setHistory([]);
    void refreshSessions().then((list) => {
      if (list.length > 0) setActiveSessionId(list[0]!.sessionId);
    });
  }, [codeProject.id, refreshSessions]);

  // Load persisted history whenever the active session changes.
  useEffect(() => {
    reset();
    stickToBottomRef.current = true;
    if (!activeSessionId) {
      setHistory([]);
      return;
    }
    setLoadingHistory(true);
    fetchMessages(activeSessionId)
      .then((msgs) => setHistory(groupTurns(reorderReasoning(msgs))))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingHistory(false));
  }, [activeSessionId, reset]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  // Sticky-bottom: only follow the stream while the user is already near the
  // bottom. Without this the 150ms timer tick in useSSEChat would yank the
  // viewport down on every update, making the transcript unreadable.
  const stickToBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [history, turns]);

  const handleNewChat = () => {
    // Mint a fresh id client-side; the server accepts caller-provided
    // `code-chat-<id>-…` ids. The new conversation only lands in the sidebar
    // after the first message is sent (when `turn_end` fires).
    setActiveSessionId(mintSessionId());
  };

  const handleDelete = (sessionId: string) => {
    setConfirmDeleteSessionId(sessionId);
  };

  const confirmDelete = async () => {
    const sessionId = confirmDeleteSessionId;
    setConfirmDeleteSessionId(null);
    if (!sessionId) return;
    try {
      await setSessionHiddenFromChat(sessionId, true);
      const list = await refreshSessions();
      if (sessionId === activeSessionId) {
        setActiveSessionId(list[0]?.sessionId ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const isEmpty =
    !loadingHistory && history.length === 0 && turns.length === 0;
  const composerDisabled = streaming || codeProject.gitStatus !== "ready";
  const hasDraftRow =
    activeSessionId !== null &&
    !sessions.some((s) => s.sessionId === activeSessionId);

  return (
    <div className="chat">
      <aside className="sidebar">
        <div className="sidebar__new-row">
          <button
            type="button"
            className="btn btn--send sidebar__new"
            onClick={handleNewChat}
            title="Start a new conversation"
          >
            <Plus size={14} /> New chat
          </button>
        </div>
        <ul className="sidebar__list">
          {sessions.length === 0 && !hasDraftRow && (
            <li className="sidebar__empty">No conversations yet.</li>
          )}
          {hasDraftRow && (
            <li className="sidebar__row">
              <button
                type="button"
                className="sidebar__item sidebar__item--active"
              >
                <div className="sidebar__item-title">
                  <MessageCircle size={12} /> New chat
                </div>
                <div className="sidebar__item-meta">draft</div>
              </button>
            </li>
          )}
          {sessions.map((s) => {
            const active = s.sessionId === activeSessionId;
            return (
              <li key={s.sessionId} className="sidebar__row">
                <button
                  type="button"
                  className={`sidebar__item${active ? " sidebar__item--active" : ""}`}
                  onClick={() => setActiveSessionId(s.sessionId)}
                >
                  <div className="sidebar__item-title">
                    <MessageCircle size={12} /> {s.title || "Untitled"}
                  </div>
                  <div className="sidebar__item-meta">
                    {formatRelative(s.lastTs)}
                  </div>
                </button>
                <button
                  type="button"
                  className="btn btn--icon code-chat__sidebar-delete"
                  onClick={() => handleDelete(s.sessionId)}
                  title="Hide conversation"
                  aria-label="Hide conversation"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="chat__main">
        <div className="chat__scroll" ref={scrollRef} onScroll={handleScroll}>
          {isEmpty && !activeSessionId && (
            <EmptyState
              title="No conversation selected"
              description="Start a new chat to ask about this code."
              action={
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={handleNewChat}
                >
                  <Plus size={14} /> New chat
                </button>
              }
            />
          )}
          {isEmpty && activeSessionId && (
            <EmptyState
              title={`Chat — ${codeProject.name}`}
              description="Ask about the code, request a review, or tell the agent to document or refactor a file."
            />
          )}
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
                  !t.done && (
                    <div className="bubble__pending">
                      <span className="spinner" /> waiting for model…
                    </div>
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
          {error && <div className="bubble__error">error: {error}</div>}
          {activeSessionId ? (
            <Composer
              ref={composerRef}
              disabled={composerDisabled}
              streaming={streaming}
              onSubmit={(prompt, attachments) => {
                stickToBottomRef.current = true;
                send(prompt, attachments);
              }}
              onAbort={abort}
              project={codeProject.project}
            />
          ) : (
            <div className="chat__readonly-note">
              Pick a conversation or{" "}
              <button
                type="button"
                className="btn btn--ghost chat__readonly-swap"
                onClick={handleNewChat}
              >
                Start a new one
              </button>
              to chat about this code.
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmDeleteSessionId !== null}
        message="Remove this conversation from the sidebar? The messages stay in the database and can be reopened from the main Chat tab."
        confirmLabel="Remove"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirmDeleteSessionId(null)}
      />
    </div>
  );
}

