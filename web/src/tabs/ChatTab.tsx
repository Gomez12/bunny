import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import Composer, {
  MAX_IMAGE_BYTES,
  resolveImageMime,
  type ComposerHandle,
} from "../components/Composer";
import {
  answerUserQuestion,
  fetchSessions,
  forkSessionApi,
  patchMessage,
  regenerateAssistantMessage,
  setSessionQuickChat,
  trimMessagesAfter,
  uploadImageForDataUrl,
  type ChatAttachment,
  type SessionSummary,
} from "../api";
import MessageBubble from "../components/MessageBubble";
import MarkdownContent from "../components/MarkdownContent";
import ReasoningBlock from "../components/ReasoningBlock";
import ToolCallCard from "../components/ToolCallCard";
import UserQuestionCard from "../components/UserQuestionCard";
import SessionSidebar from "../components/SessionSidebar";
import EmptyState from "../components/EmptyState";
import QueueWaitBadge from "../components/QueueWaitBadge";
import StatsFooter from "../components/StatsFooter";
import {
  fetchMessages,
  groupTurns,
  reorderReasoning,
  type AuthUser,
  type HistoryTurn,
} from "../api";
import { useSSEChat } from "../hooks/useSSEChat";

interface Props {
  sessionId: string;
  project: string;
  currentUser: AuthUser;
  /** Currently-selected agent for this session. */
  activeAgent: string;
  /** Configured default agent name. */
  defaultAgent: string;
  /** Called when the user picks a different agent from the composer dropdown. */
  onChangeActiveAgent: (agent: string) => void;
  onPickSession: (id: string) => void;
  onNewSession: () => void;
  /** Optional: start a brand-new session AND mark it as a Quick Chat. */
  onNewQuickChat?: () => void;
  /** Compact (mini-window) layout — hides the session sidebar and the admin
   *  Mine/All scope toggle so the chat fills a 520×660 BrowserWindow. */
  compact?: boolean;
  /** Focus the composer textarea on first mount (Quick Chat). */
  autoFocusComposer?: boolean;
  /** Handoff payload from Documents / Whiteboards / Contacts "ask". The tab
   * auto-sends this prompt (once) after the session prop catches up. */
  pendingChatSend?: {
    sessionId: string;
    prompt: string;
    attachments?: ChatAttachment[];
    isQuickChat?: boolean;
  } | null;
  onConsumePendingChatSend?: () => void;
}

export default function ChatTab({
  sessionId,
  project,
  currentUser,
  activeAgent,
  defaultAgent,
  onChangeActiveAgent,
  onPickSession,
  onNewSession,
  onNewQuickChat,
  pendingChatSend,
  onConsumePendingChatSend,
  compact = false,
  autoFocusComposer = false,
}: Props) {
  const { t } = useTranslation();
  const expandThink = currentUser.expandThinkBubbles;
  const expandTool = currentUser.expandToolBubbles;
  const [history, setHistory] = useState<HistoryTurn[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // Per-turn regen-version override (keyed by user-prompt message id).
  const [regenIndex, setRegenIndex] = useState<Record<number, number>>({});
  const [regeneratingTurnId, setRegeneratingTurnId] = useState<string | null>(null);
  const [activeSessionMeta, setActiveSessionMeta] = useState<{
    isQuickChat: boolean;
    forkedFromSessionId: string | null;
  } | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const refreshHistory = useCallback(async () => {
    try {
      const msgs = await fetchMessages(sessionId);
      setHistory(groupTurns(reorderReasoning(msgs)));
    } catch (e) {
      console.error(e);
    }
  }, [sessionId]);

  // Bump the sidebar refreshKey on turn end so a new session surfaces in "Mine".
  const { turns, streaming, send, abort, reset, markUserQuestionAnswered } =
    useSSEChat(sessionId, project, () => setRefreshKey((k) => k + 1));

  const [adminScope, setAdminScope] = useState<"mine" | "all">("mine");

  const scrollRef = useRef<HTMLDivElement>(null);
  // Sticky-bottom: auto-scroll only follows the stream when the user is
  // already near the bottom. Scrolling up to read or answer an off-screen
  // question card unsticks; the 150ms timer tick can no longer yank.
  const stickToBottomRef = useRef(true);
  const composerRef = useRef<ComposerHandle>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  }, []);

  // Safari hides `items[i].type` during dragenter/dragover for privacy, so
  // detecting "is this a file drag?" via item types is unreliable. The
  // `types` list (a DOMStringList) does reliably contain "Files" in every
  // browser during the whole drag, which is what we key off.
  const isFileDrag = (e: DragEvent<HTMLDivElement>): boolean => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "Files") return true;
    }
    return false;
  };

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    const composer = composerRef.current;
    if (!composer) {
      console.warn("[chat-drop] composer ref not ready");
      return;
    }

    // Collect files via BOTH classic paths and the webkit FileSystem Entry
    // API. Safari has a long-standing quirk where `dataTransfer.files` /
    // `getAsFile()` return File objects whose byte content can't be read;
    // `webkitGetAsEntry()` + `entry.file()` often works where those don't.
    type WebkitFileEntry = FileSystemEntry & {
      file: (ok: (f: File) => void, err?: (e: unknown) => void) => void;
    };

    const classic: File[] = [];
    if (dt.files && dt.files.length > 0) classic.push(...Array.from(dt.files));
    if (classic.length === 0 && dt.items) {
      for (const it of dt.items) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) classic.push(f);
        }
      }
    }

    const entries: WebkitFileEntry[] = [];
    if (dt.items) {
      for (const it of dt.items) {
        const entry = typeof it.webkitGetAsEntry === "function"
          ? it.webkitGetAsEntry()
          : null;
        if (entry && entry.isFile) entries.push(entry as WebkitFileEntry);
      }
    }

    // Build a list of File objects from ALL available sources. We create the
    // blob URL synchronously (inside the event) and convert via <img>+canvas
    // asynchronously. The blob URL stays valid after the handler returns —
    // only direct File byte reads (FileReader/arrayBuffer) are blocked by
    // Safari 26+. The <img> tag IS allowed to load blob URLs.
    const candidates = classic.length > 0 ? classic : [];
    if (candidates.length === 0 && entries.length > 0) {
      // webkitGetAsEntry path: entry.file() delivers a new File in its
      // callback. We can't collect them synchronously, so delegate to
      // an async helper.
      for (const entry of entries) {
        entry.file(
          (f) => processDroppedFile(f, composer),
          (err) => {
            console.error("[chat-drop] entry.file rejected", err);
            composer.reportAttachError(
              t("tab.chat.error.cannotReadEntry", { name: entry.name }),
            );
          },
        );
      }
    } else {
      for (const f of candidates) processDroppedFile(f, composer);
    }
  };

  /** Upload a dropped file via the server and push the resulting attachment
   * into the composer. Uses FormData which the browser serialises natively,
   * bypassing all client-side File-read APIs that Safari 26 blocks. */
  const processDroppedFile = (f: File, composer: ComposerHandle) => {
    const mime = resolveImageMime(f);
    if (!mime) {
      composer.reportAttachError(
        t("tab.chat.error.unsupportedImage", { name: f.name }),
      );
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      composer.reportAttachError(
        t("tab.chat.error.imageTooLarge", {
          name: f.name,
          limit: MAX_IMAGE_BYTES / 1024 / 1024,
        }),
      );
      return;
    }
    uploadImageForDataUrl(f, mime)
      .then((a) => composer.pushAttachment(a))
      .catch((err) =>
        composer.reportAttachError(
          t("tab.chat.error.uploadFailed", {
            name: f.name,
            message:
              err instanceof Error
                ? err.message
                : t("tab.chat.error.uploadFailedDefault"),
          }),
        ),
      );
  };

  // Window-level guard: a file drop anywhere outside the chat dropzone must
  // not be interpreted as a navigation (Safari otherwise shows the browser
  // loading bar and tries to open the image in the tab). Swallowing the
  // default on the window is the standard way to scope drag-and-drop to the
  // app without letting errant drops leak.
  useEffect(() => {
    const swallow = (e: Event) => {
      const dt = (e as globalThis.DragEvent).dataTransfer;
      if (dt && Array.from(dt.types).includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  useEffect(() => {
    reset();
    setRegenIndex({});
    setRegeneratingTurnId(null);
    // Clear stale QC / fork meta from the previous session so nothing leaks
    // into the new one — the pending-consume effect may seed it, and
    // fetchSessions will populate it once the session row exists.
    setActiveSessionMeta(null);
    stickToBottomRef.current = true;
    setLoadingHistory(true);
    fetchMessages(sessionId)
      .then((msgs) => setHistory(groupTurns(reorderReasoning(msgs))))
      .catch((e) => console.error(e))
      .finally(() => setLoadingHistory(false));
  }, [sessionId, reset]);

  // When the last live SSE turn completes, swap it for the DB-backed history
  // turn so that edit/regenerate/fork actions become available. Both state
  // updates run in the same React 18 batch (single render, no double display).
  const lastTurnDone = turns[turns.length - 1]?.done;
  useEffect(() => {
    if (!lastTurnDone) return;
    let cancelled = false;
    fetchMessages(sessionId)
      .then((msgs) => {
        if (cancelled) return;
        setHistory(groupTurns(reorderReasoning(msgs)));
        reset();
      })
      .catch((e) => console.error(e));
    return () => {
      cancelled = true;
    };
  }, [lastTurnDone, sessionId, reset]);

  // Auto-send the handoff prompt from Documents / Whiteboards / Contacts.
  // Gated on `sessionId === pending.sessionId` so the prompt can't leak into a
  // stale session if the user switched mid-flight; cleared immediately to
  // avoid re-firing on remount.
  useEffect(() => {
    if (!pendingChatSend) return;
    if (pendingChatSend.sessionId !== sessionId) return;
    if (pendingChatSend.isQuickChat) {
      setActiveSessionMeta((prev) => ({
        isQuickChat: true,
        forkedFromSessionId: prev?.forkedFromSessionId ?? null,
      }));
    }
    send(pendingChatSend.prompt, pendingChatSend.attachments ?? [], activeAgent);
    onConsumePendingChatSend?.();
  }, [pendingChatSend, sessionId, send, onConsumePendingChatSend, activeAgent]);

  // Toggles via the composer checkbox update activeSessionMeta directly. We
  // also re-run on `refreshKey` so the flag picks up the real DB row once a
  // handoff session (Documents/Whiteboards "ask") materialises on turn_end.
  // When `me` is undefined (session not yet in `messages`) we *preserve* the
  // existing meta rather than resetting — otherwise the seed set by a pending
  // handoff payload would flash then clear.
  useEffect(() => {
    let cancelled = false;
    fetchSessions(undefined, { project, scope: "mine" })
      .then((list: SessionSummary[]) => {
        if (cancelled) return;
        const me = list.find((s) => s.sessionId === sessionId);
        if (!me) return;
        const next = {
          isQuickChat: me.isQuickChat,
          forkedFromSessionId: me.forkedFromSessionId,
        };
        setActiveSessionMeta((prev) =>
          prev &&
          prev.isQuickChat === next.isQuickChat &&
          prev.forkedFromSessionId === next.forkedFromSessionId
            ? prev
            : next,
        );
      })
      .catch(() => {
        /* leave existing meta in place on fetch error */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, project, refreshKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    // Coalesce rapid SSE-delta scroll writes into a single layout per frame.
    const raf = requestAnimationFrame(() => {
      if (!stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [history, turns]);

  const isEmpty = !loadingHistory && history.length === 0 && turns.length === 0;

  const handleToggleQuickChat = useCallback(
    async (next: boolean) => {
      const prev = activeSessionMeta;
      setActiveSessionMeta((m) =>
        m ? { ...m, isQuickChat: next } : { isQuickChat: next, forkedFromSessionId: null },
      );
      try {
        await setSessionQuickChat(sessionId, next);
        setRefreshKey((k) => k + 1);
      } catch (e) {
        console.error(e);
        setActiveSessionMeta(prev);
      }
    },
    [activeSessionMeta, sessionId],
  );

  const handleEditUserPrompt = useCallback(
    async (turn: HistoryTurn, content: string) => {
      await patchMessage(turn.promptMessageId, content);
      await refreshHistory();
    },
    [refreshHistory],
  );

  const handleSaveAndRegenerate = useCallback(
    async (turn: HistoryTurn, content: string) => {
      await patchMessage(turn.promptMessageId, content);
      await trimMessagesAfter(turn.promptMessageId);
      // Re-run the agent against the (now edited) user message in place. We
      // hit /regenerate rather than /api/chat so no fresh user row is
      // inserted — the original prompt row is the "prompt" for this turn.
      setRegeneratingTurnId(turn.id);
      await new Promise<void>((resolve, reject) => {
        const { done } = regenerateAssistantMessage(turn.promptMessageId, () => {
          /* events ignored — we refresh on done */
        });
        done.then(resolve).catch(reject);
      })
        .catch((e) => console.error(e))
        .finally(() => setRegeneratingTurnId(null));
      await refreshHistory();
    },
    [refreshHistory],
  );

  const handleEditAssistant = useCallback(
    async (turn: HistoryTurn, content: string) => {
      if (turn.contentMessageId == null) return;
      await patchMessage(turn.contentMessageId, content);
      await refreshHistory();
    },
    [refreshHistory],
  );

  const handleFork = useCallback(
    async (
      _turn: HistoryTurn,
      untilMessageId: number,
      editedContent?: string,
    ) => {
      // Edit-then-fork should NOT mutate the source. The fork API rewrites
      // the last copied message in the new session only when
      // `editLastMessageContent` is set.
      const { sessionId: newId } = await forkSessionApi(sessionId, {
        untilMessageId,
        asQuickChat: true,
        project,
        ...(editedContent !== undefined
          ? { editLastMessageContent: editedContent }
          : {}),
      });
      onPickSession(newId);
    },
    [sessionId, project, onPickSession],
  );

  const handleRegenerateAssistant = useCallback(
    async (turn: HistoryTurn) => {
      if (turn.contentMessageId == null) return;
      setRegeneratingTurnId(turn.id);
      await new Promise<void>((resolve, reject) => {
        const { done } = regenerateAssistantMessage(turn.contentMessageId!, () => {
          /* events ignored — we refresh on done */
        });
        done.then(resolve).catch(reject);
      })
        .catch((e) => console.error(e))
        .finally(() => setRegeneratingTurnId(null));
      await refreshHistory();
    },
    [refreshHistory],
  );

  const sidebarShowOwner = currentUser.role === "admin" && adminScope === "all";

  // For each rendered turn, derive the assistant content to show — either the
  // active version (latest) or the user's manually-selected older alternate.
  const turnContent = useMemo(() => {
    const out = new Map<string, string>();
    for (const t of history) {
      const overrideIdx = regenIndex[t.promptMessageId];
      if (overrideIdx !== undefined && t.regenChain[overrideIdx]) {
        out.set(t.id, t.regenChain[overrideIdx]!.content ?? t.content);
      } else {
        out.set(t.id, t.content);
      }
    }
    return out;
  }, [history, regenIndex]);

  return (
    <div className={"chat" + (compact ? " chat--compact" : "")}>
      {!compact && (
        <SessionSidebar
          activeId={sessionId}
          onPick={onPickSession}
          onNew={onNewSession}
          onNewQuickChat={onNewQuickChat}
          refreshKey={refreshKey}
          project={project}
          excludeHidden={!showHidden && adminScope === "mine"}
          showHiddenToggle={
            adminScope === "mine"
              ? { value: showHidden, onChange: setShowHidden }
              : undefined
          }
          allowToggleHidden
          scope={currentUser.role === "admin" ? adminScope : undefined}
          showOwner={sidebarShowOwner}
          scopeToggle={
            currentUser.role === "admin"
              ? { value: adminScope, onChange: setAdminScope }
              : undefined
          }
        />
      )}
      <div
        className={"chat__main" + (isDragOver ? " chat__main--dragover" : "")}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {isDragOver && (
          <div className="chat__dropzone">
            <div className="chat__dropzone-inner">{t("tab.chat.dropToAttach")}</div>
          </div>
        )}
        {activeSessionMeta?.isQuickChat && (
          <div className="chat__quickbanner">
            <span className="chat__quickbanner-badge">{t("tab.chat.quickChatBadge")}</span>
            <span>{t("tab.chat.quickChatAutoHide")}</span>
            {activeSessionMeta.forkedFromSessionId && (
              <span>
                {t("tab.chat.forkedFrom", {
                  id: activeSessionMeta.forkedFromSessionId.slice(0, 8),
                })}
              </span>
            )}
          </div>
        )}
        <div className="chat__scroll" ref={scrollRef} onScroll={handleScroll}>
          {isEmpty && (
            <EmptyState
              title={t("tab.chat.emptyTitle")}
              description={t("tab.chat.emptyDescription", {
                project,
                session: sessionId.slice(0, 8),
              })}
            />
          )}
          {history.map((turn) => {
            const versionContent = turnContent.get(turn.id) ?? turn.content;
            const isRegenerating = regeneratingTurnId === turn.id;
            return (
              <div key={turn.id} className="turn">
                <MessageBubble
                  role="user"
                  authorDisplayName={turn.promptDisplayName}
                  authorUsername={turn.promptUsername}
                  rawContent={turn.prompt}
                  edited={turn.promptEdited}
                  actions={{
                    onSave: (c) => handleEditUserPrompt(turn, c),
                    onSaveAndRegenerate: (c) => handleSaveAndRegenerate(turn, c),
                    onFork: (edited) => handleFork(turn, turn.promptMessageId, edited),
                  }}
                >
                  {turn.attachments.length > 0 && (
                    <div className="bubble__attachments">
                      {turn.attachments.map((a, i) => (
                        <img
                          key={i}
                          src={a.dataUrl}
                          alt={t("tab.chat.attachmentAlt", { n: i + 1 })}
                        />
                      ))}
                    </div>
                  )}
                  {turn.prompt}
                </MessageBubble>
                <MessageBubble
                  role="assistant"
                  author={turn.author}
                  rawContent={versionContent}
                  edited={turn.contentEdited}
                  regenChain={turn.regenChain}
                  selectedIndex={
                    regenIndex[turn.promptMessageId] ?? Math.max(0, turn.regenChain.length - 1)
                  }
                  onSelectIndex={(idx) =>
                    setRegenIndex((m) => ({ ...m, [turn.promptMessageId]: idx }))
                  }
                  actions={{
                    onSave: turn.contentMessageId != null
                      ? (c) => handleEditAssistant(turn, c)
                      : undefined,
                    onFork: turn.contentMessageId != null
                      ? (edited) => handleFork(turn, turn.contentMessageId!, edited)
                      : undefined,
                    onRegenerate: turn.contentMessageId != null
                      ? () => handleRegenerateAssistant(turn)
                      : undefined,
                  }}
                >
                  {turn.reasoning && <ReasoningBlock text={turn.reasoning} defaultOpen={expandThink} />}
                  {turn.toolCalls.map((tc) => (
                    <ToolCallCard
                      key={tc.id}
                      name={tc.name}
                      args={tc.args}
                      ok={tc.ok}
                      output={tc.output}
                      defaultOpen={expandTool}
                    />
                  ))}
                  {turn.isError
                    ? <div className="bubble__error">{t("tab.chat.errorLabel", { message: versionContent })}</div>
                    : versionContent && <MarkdownContent text={versionContent} />}
                  {isRegenerating && (
                    <div className="bubble__pending">
                      <span className="spinner" /> {t("tab.chat.regenerating")}
                    </div>
                  )}
                  <StatsFooter stats={turn.stats} />
                </MessageBubble>
              </div>
            );
          })}
          {turns.map((turn) => (
            <div key={turn.id} className="turn">
              <MessageBubble
                role="user"
                authorDisplayName={currentUser.displayName}
                authorUsername={currentUser.username}
              >
                {turn.attachments.length > 0 && (
                  <div className="bubble__attachments">
                    {turn.attachments.map((a, i) => (
                      <img
                        key={i}
                        src={a.dataUrl}
                        alt={t("tab.chat.attachmentAlt", { n: i + 1 })}
                      />
                    ))}
                  </div>
                )}
                {turn.prompt}
              </MessageBubble>
              <MessageBubble role="assistant" author={turn.author}>
                {turn.items.map((it, i) => {
                  switch (it.kind) {
                    case "reasoning":
                      return (
                        <ReasoningBlock
                          key={`r-${i}`}
                          text={it.text}
                          defaultOpen={expandThink}
                        />
                      );
                    case "tool":
                      return (
                        <ToolCallCard
                          key={`t-${it.tool.callIndex}`}
                          name={it.tool.name}
                          args={it.tool.args}
                          ok={it.tool.ok}
                          output={it.tool.output}
                          error={it.tool.error}
                          defaultOpen={expandTool}
                        />
                      );
                    case "question":
                      return (
                        <UserQuestionCard
                          key={`q-${it.question.questionId}`}
                          question={it.question}
                          onSubmit={async (answer) => {
                            await answerUserQuestion(
                              sessionId,
                              it.question.questionId,
                              answer,
                            );
                            markUserQuestionAnswered(
                              turn.id,
                              it.question.questionId,
                              answer,
                            );
                          }}
                        />
                      );
                    case "content":
                      return <MarkdownContent key={`c-${i}`} text={it.text} />;
                  }
                })}
                {turn.items.length === 0 && !turn.done && turn.queueState !== "waiting" && (
                  <div className="bubble__pending">
                    <span className="spinner" /> {t("tab.chat.waitingForModel")}
                  </div>
                )}
                {!turn.done && turn.queueState === "waiting" && (
                  <QueueWaitBadge
                    position={turn.queuePosition}
                    waitedTotalMs={turn.queueWaitTotalMs}
                  />
                )}
                {turn.error && (
                  <div className="bubble__error">
                    {t("tab.chat.errorLabel", { message: turn.error })}
                  </div>
                )}
                <StatsFooter stats={turn.stats} />
              </MessageBubble>
            </div>
          ))}
        </div>
        <div className="chat__composer">
          {adminScope === "all" ? (
            <div className="chat__readonly-note">
              {t("tab.chat.readonlyPrefix")}{" "}
              <button
                type="button"
                className="btn btn--ghost chat__readonly-swap"
                onClick={() => setAdminScope("mine")}
              >
                {t("tab.chat.scopeMine")}
              </button>{" "}
              {t("tab.chat.readonlySuffix")}
            </div>
          ) : (
            <>
              <Composer
                ref={composerRef}
                disabled={streaming}
                streaming={streaming}
                onSubmit={(prompt, attachments) => {
                  stickToBottomRef.current = true;
                  send(prompt, attachments, activeAgent);
                }}
                onAbort={abort}
                project={project}
                activeAgent={activeAgent}
                defaultAgent={defaultAgent}
                onChangeActiveAgent={onChangeActiveAgent}
                autoFocus={autoFocusComposer}
              />
              <label className="chat__qctoggle" title={t("tab.chat.quickChatToggleTitle")}>
                <input
                  type="checkbox"
                  checked={Boolean(activeSessionMeta?.isQuickChat)}
                  onChange={(e) => void handleToggleQuickChat(e.target.checked)}
                />
                {t("tab.chat.quickChatLabel")}
              </label>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
