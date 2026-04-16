import { useEffect, useRef, useState, type DragEvent } from "react";
import Composer, {
  MAX_IMAGE_BYTES,
  resolveImageMime,
  type ComposerHandle,
} from "../components/Composer";
import { uploadImageForDataUrl } from "../api";
import MessageBubble from "../components/MessageBubble";
import MarkdownContent from "../components/MarkdownContent";
import ReasoningBlock from "../components/ReasoningBlock";
import ToolCallCard from "../components/ToolCallCard";
import SessionSidebar from "../components/SessionSidebar";
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
  onPickSession: (id: string) => void;
  onNewSession: () => void;
}

export default function ChatTab({
  sessionId,
  project,
  currentUser,
  onPickSession,
  onNewSession,
}: Props) {
  const expandThink = currentUser.expandThinkBubbles;
  const expandTool = currentUser.expandToolBubbles;
  const [history, setHistory] = useState<HistoryTurn[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const { turns, streaming, send, abort, reset } = useSSEChat(sessionId, project, () =>
    setRefreshKey((k) => k + 1),
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);

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
            composer.reportAttachError(`could not read '${entry.name}'`);
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
        `'${f.name}': only PNG/JPEG/GIF/WEBP images are supported`,
      );
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      composer.reportAttachError(
        `'${f.name}' exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`,
      );
      return;
    }
    uploadImageForDataUrl(f, mime)
      .then((a) => composer.pushAttachment(a))
      .catch((err) =>
        composer.reportAttachError(
          `'${f.name}': ${err instanceof Error ? err.message : "upload failed"}`,
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
        excludeHidden
        allowToggleHidden
      />
      <div
        className={"chat__main" + (isDragOver ? " chat__main--dragover" : "")}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {isDragOver && (
          <div className="chat__dropzone">
            <div className="chat__dropzone-inner">Drop image to attach</div>
          </div>
        )}
        <div className="chat__scroll" ref={scrollRef}>
          {isEmpty && (
            <div className="chat__empty">
              <h2>How can I help you today?</h2>
              <p>Session <code>{sessionId.slice(0, 8)}</code></p>
            </div>
          )}
          {history.map((t) => (
            <div key={t.id} className="turn">
              <MessageBubble role="user">
                {t.attachments.length > 0 && (
                  <div className="bubble__attachments">
                    {t.attachments.map((a, i) => (
                      <img key={i} src={a.dataUrl} alt={`attachment ${i + 1}`} />
                    ))}
                  </div>
                )}
                {t.prompt}
              </MessageBubble>
              <MessageBubble role="assistant" author={t.author}>
                {t.reasoning && <ReasoningBlock text={t.reasoning} defaultOpen={expandThink} />}
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
              <MessageBubble role="user">
                {t.attachments.length > 0 && (
                  <div className="bubble__attachments">
                    {t.attachments.map((a, i) => (
                      <img key={i} src={a.dataUrl} alt={`attachment ${i + 1}`} />
                    ))}
                  </div>
                )}
                {t.prompt}
              </MessageBubble>
              <MessageBubble role="assistant" author={t.author}>
                {t.reasoning && <ReasoningBlock text={t.reasoning} defaultOpen={expandThink} />}
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
            ref={composerRef}
            disabled={streaming}
            streaming={streaming}
            onSubmit={send}
            onAbort={abort}
            project={project}
          />
        </div>
      </div>
    </div>
  );
}
