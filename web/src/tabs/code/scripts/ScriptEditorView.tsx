import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { CodeProject, Script, ScriptLanguage } from "../../../api";
import { fetchScript, patchScript, streamScriptChat, streamScriptRun } from "../../../api";
import type {
  SseScriptRunFinishedEvent,
  SseScriptRunOutputEvent,
} from "../../../../../src/agent/sse_events";
import { Play, Square, HardDrive, Terminal } from "../../../lib/icons";
import EntityComposer from "../../../components/EntityComposer";
import { applyPatches, extractPatches, extractFullBlock } from "../../../lib/patchUtils";

const LANGUAGE_TO_MONACO: Record<ScriptLanguage, string> = {
  javascript: "javascript",
  typescript: "typescript",
  csharp: "csharp",
  python: "python",
  sql: "sql",
  bash: "shell",
  powershell: "powershell",
  go: "go",
};

const LANGUAGE_LABELS: Record<ScriptLanguage, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  csharp: "C# / .NET",
  python: "Python",
  bash: "Bash",
  powershell: "PowerShell",
  go: "Go",
  sql: "SQL",
};

const LANGUAGES = Object.entries(LANGUAGE_LABELS) as [ScriptLanguage, string][];

interface OutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

interface Props {
  script: Script;
  codeProject: CodeProject;
  onScriptChange: (updated: Script) => void;
  onPromote: (id: number) => Promise<void>;
  onDelete: (s: Script) => void;
  onRename: (s: Script) => void;
  onOpenChat: () => void;
}

export default function ScriptEditorView({
  script,
  onScriptChange,
  onPromote,
  onDelete,
  onRename,
  onOpenChat,
}: Props) {
  const [content, setContent] = useState(script.content);
  const [language, setLanguage] = useState<ScriptLanguage>(script.language);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [runOutput, setRunOutput] = useState<OutputLine[]>([]);
  const [runFinished, setRunFinished] = useState<
    SseScriptRunFinishedEvent | null
  >(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [diskDiffers, setDiskDiffers] = useState(
    Boolean(script.diskDiffers),
  );
  const [diskContent, setDiskContent] = useState(script.diskContent);
  const [isPromoting, setIsPromoting] = useState(false);
  const [composerMode, setComposerMode] = useState<"edit" | "question">("edit");
  const [isEditing, setIsEditing] = useState(false);
  const [editResponse, setEditResponse] = useState<string>("");
  const [editError, setEditError] = useState<string | null>(null);
  const [bottomHeight, setBottomHeight] = useState(180);

  const abortRef = useRef<{ abort: () => void } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const versionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  // Ref updated inline in every setter — avoids useEffect sync lag and allows
  // the polling interval to read current dirty state without re-subscribing.
  const isDirtyRef = useRef(false);

  // Sync script prop changes (e.g. after version restore or external update)
  useEffect(() => {
    setContent(script.content);
    setLanguage(script.language);
    setDiskDiffers(Boolean(script.diskDiffers));
    setDiskContent(script.diskContent);
    isDirtyRef.current = false;
    setIsDirty(false);
  }, [script.id]);

  // Live disk watch: poll every 1s when editor is clean.
  useEffect(() => {
    const onScriptChangeRef = { current: onScriptChange };
    onScriptChangeRef.current = onScriptChange;
    const id = setInterval(async () => {
      try {
        const { script: fresh } = await fetchScript(script.id);
        if (!fresh.diskDiffers) return;
        if (!isDirtyRef.current) {
          setContent(fresh.diskContent ?? fresh.content);
          setDiskDiffers(false);
          onScriptChangeRef.current(fresh);
        } else {
          setDiskDiffers(true);
          setDiskContent(fresh.diskContent);
        }
      } catch {
        /* ignore transient errors */
      }
    }, 1000);
    return () => clearInterval(id);
  }, [script.id]); // intentionally excludes onScriptChange — ref keeps it current

  // Scroll output to bottom
  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [runOutput]);

  // Auto-save debounced (2 s) — does NOT create version
  const save = useCallback(
    async (newContent: string, newLanguage: ScriptLanguage, withVersion = false) => {
      setIsSaving(true);
      try {
        const { script: updated } = await patchScript(script.id, {
          content: newContent,
          language: newLanguage,
          createVersion: withVersion,
        });
        onScriptChange(updated);
        setIsDirty(false);
      } catch {
        /* silently ignore — dirty flag stays */
      } finally {
        setIsSaving(false);
      }
    },
    [script.id, onScriptChange],
  );

  function handleEditorChange(value: string | undefined) {
    const v = value ?? "";
    setContent(v);
    isDirtyRef.current = true; setIsDirty(true);

    // Debounced autosave (2 s, no version)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void save(v, language, false);
    }, 2000);

    // Idle version snapshot (30 s after last change)
    if (versionTimerRef.current) clearTimeout(versionTimerRef.current);
    versionTimerRef.current = setTimeout(() => {
      void save(v, language, true);
    }, 30_000);
  }

  function handleBlur() {
    // Create version on blur if dirty
    if (isDirty) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (versionTimerRef.current) clearTimeout(versionTimerRef.current);
      void save(content, language, true);
    }
  }

  async function handleLanguageChange(lang: ScriptLanguage) {
    setLanguage(lang);
    await patchScript(script.id, { language: lang });
  }

  async function handleRun() {
    // Force save before run
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await save(content, language, false);

    setRunOutput([]);
    setRunFinished(null);
    setRuntimeError(null);
    setIsRunning(true);

    const { abort } = streamScriptRun(script.id, (event) => {
      if (event.type === "script_run_output") {
        const e = event as SseScriptRunOutputEvent;
        setRunOutput((prev) => [...prev, { stream: e.stream, text: e.text }]);
      } else if (event.type === "script_run_finished") {
        setRunFinished(event as SseScriptRunFinishedEvent);
        setIsRunning(false);
      }
    });
    abortRef.current = { abort };
  }

  function handleStop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsRunning(false);
  }

  async function handlePromote() {
    setIsPromoting(true);
    try {
      await onPromote(script.id);
    } finally {
      setIsPromoting(false);
    }
  }

  function handleUseDisk() {
    if (!diskContent) return;
    setContent(diskContent);
    isDirtyRef.current = true; setIsDirty(true);
    setDiskDiffers(false);
    void save(diskContent, language, true);
  }

  function handleKeepDB() {
    setDiskDiffers(false);
    void save(content, language, false);
  }

  // Clean up any in-progress drag if the component unmounts mid-drag
  useEffect(() => () => { dragRef.current = null; }, []);

  function handleResizeStart(e: React.MouseEvent) {
    dragRef.current = { startY: e.clientY, startHeight: bottomHeight };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setBottomHeight(Math.max(80, Math.min(520, dragRef.current.startHeight + (dragRef.current.startY - ev.clientY))));
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  /** Stream one LLM request and return the accumulated content string. */
  async function streamEdit(prompt: string): Promise<string> {
    let acc = "";
    const sessionId = `script-edit-${crypto.randomUUID()}`;
    const { done } = streamScriptChat(
      script.id,
      { sessionId, prompt, content },
      (ev) => {
        if (ev.type === "content") { acc += ev.text; setEditResponse(acc); }
        else if (ev.type === "error") setEditError(ev.message);
      },
    );
    try { await done; } catch { /* aborted */ }
    return acc;
  }

  async function handleComposerSend(prompt: string) {
    if (composerMode === "question") { onOpenChat(); return; }

    // Force-save current editor state before any AI edit
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await save(content, language, false);

    setIsEditing(true);
    setEditResponse("");
    setEditError(null);

    // ── First request: try patch format ────────────────────────────────────
    const response = await streamEdit(prompt);

    const patches = extractPatches(response);
    if (patches.length > 0) {
      const patched = applyPatches(content, patches);
      if (patched !== null) {
        // All patches applied cleanly
        setContent(patched);
        isDirtyRef.current = true; setIsDirty(true);
        setEditResponse(`✓ ${patches.length} patch${patches.length > 1 ? "es" : ""} applied`);
        void save(patched, language, true);
        setIsEditing(false);
        return;
      }
      // Patches present but failed to apply → fall through to full rewrite
      setEditResponse("Patches couldn't be applied exactly — requesting full rewrite…");
    }

    // ── Check if LLM already gave a full code block ─────────────────────────
    const fullBlock = extractFullBlock(response);
    if (fullBlock) {
      setContent(fullBlock);
      isDirtyRef.current = true; setIsDirty(true);
      setEditResponse("✓ Full rewrite applied");
      void save(fullBlock, language, true);
      setIsEditing(false);
      return;
    }

    // ── Fallback: patches failed, no full block — ask for complete rewrite ──
    if (patches.length > 0) {
      setEditResponse("Requesting full rewrite…");
      const fallbackPrompt =
        "The search/replace patches you provided could not be applied to the current script (text not found exactly). " +
        "Please output the complete updated script in a single ```" +
        language +
        " code block.";
      const fallback = await streamEdit(fallbackPrompt);
      const fb = extractFullBlock(fallback);
      if (fb) {
        setContent(fb);
        isDirtyRef.current = true; setIsDirty(true);
        setEditResponse("✓ Full rewrite applied (patch fallback)");
        void save(fb, language, true);
      } else {
        setEditError("Could not apply changes. Check the response above.");
      }
    } else if (response.trim()) {
      // Plain text answer — no code changes, keep response visible
    } else {
      setEditError("Empty response from AI.");
    }

    setIsEditing(false);
  }

  const theme = document.documentElement.dataset.theme === "light" ? "vs-light" : "vs-dark";

  return (
    <div className="script-editor">
      {/* Toolbar */}
      <div className="script-editor__toolbar">
        <span className="script-editor__name">
          {script.name}
          {isDirty && (
            <span title="Unsaved changes" style={{ marginLeft: "4px", opacity: 0.6 }}>
              •
            </span>
          )}
          {isSaving && (
            <span style={{ marginLeft: "4px", opacity: 0.4, fontSize: "11px" }}>
              saving…
            </span>
          )}
        </span>

        <select
          className="form-input"
          style={{ width: "auto", fontSize: "12px", padding: "2px 6px" }}
          value={language}
          onChange={(e) => handleLanguageChange(e.target.value as ScriptLanguage)}
        >
          {LANGUAGES.map(([val, label]) => (
            <option key={val} value={val}>
              {label}
            </option>
          ))}
        </select>

        <div style={{ display: "flex", gap: "4px" }}>
          {!isRunning ? (
            <button
              type="button"
              className="btn btn--primary"
              style={{ display: "flex", gap: "4px", alignItems: "center" }}
              onClick={handleRun}
              disabled={language === "sql"}
              title={language === "sql" ? "SQL execution requires a database connection" : "Run script"}
            >
              <Play size={14} strokeWidth={2} />
              Run
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--secondary"
              style={{ display: "flex", gap: "4px", alignItems: "center" }}
              onClick={handleStop}
            >
              <Square size={14} strokeWidth={2} />
              Stop
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onRename(script)}
            title="Rename / edit"
          >
            Rename
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onDelete(script)}
            title="Delete"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Banners */}
      {script.isTemp && (
        <div
          className="script-editor__banner script-editor__banner--amber"
        >
          <span>
            <Terminal size={14} strokeWidth={2} style={{ verticalAlign: "middle" }} />{" "}
            This is a scratch script — not shown in the main list.
          </span>
          <button
            type="button"
            className="btn btn--secondary"
            style={{ padding: "2px 8px", fontSize: "12px" }}
            onClick={handlePromote}
            disabled={isPromoting}
          >
            {isPromoting ? "Promoting…" : "Promote to script"}
          </button>
        </div>
      )}

      {diskDiffers && (
        <div className="script-editor__banner script-editor__banner--info">
          <span>
            <HardDrive size={14} strokeWidth={2} style={{ verticalAlign: "middle" }} />{" "}
            File changed externally on disk.
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              className="btn btn--secondary"
              style={{ padding: "2px 8px", fontSize: "12px" }}
              onClick={handleUseDisk}
            >
              Use disk version
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ padding: "2px 8px", fontSize: "12px" }}
              onClick={handleKeepDB}
            >
              Keep this version
            </button>
          </div>
        </div>
      )}

      {runtimeError && (
        <div className="script-editor__banner script-editor__banner--error">
          Runtime not configured for {LANGUAGE_LABELS[script.language]}.{" "}
          Configure it in Settings → Script Runtimes.
        </div>
      )}

      {/* Monaco Editor */}
      {/* Monaco editor with AI-editing overlay */}
      <div className="script-editor__editor" onBlur={handleBlur}>
        <Editor
          height="100%"
          language={LANGUAGE_TO_MONACO[language]}
          value={content}
          onChange={handleEditorChange}
          theme={theme}
          options={{
            minimap: { enabled: false },
            lineNumbers: "on",
            wordWrap: "off",
            fontSize: 13,
            scrollBeyondLastLine: false,
            automaticLayout: true,
          }}
        />
        {isEditing && (
          <div className="script-editor__editing-overlay">
            <div className="script-editor__editing-overlay-card">
              <span className="spinner" style={{ width: 18, height: 18 }} />
              <span>AI is editing the script…</span>
            </div>
          </div>
        )}
      </div>

      {/* Drag handle — separates editor from bottom panel */}
      <div
        className="script-editor__resize-handle"
        onMouseDown={handleResizeStart}
        title="Drag to resize"
      >
        <div className="script-editor__resize-handle-bar" />
      </div>

      {/* Bottom panel: composer + AI response + output */}
      <div className="script-editor__bottom" style={{ height: bottomHeight }}>
        <EntityComposer
          mode={composerMode}
          onModeChange={setComposerMode}
          onSend={handleComposerSend}
          streaming={isEditing}
          editPlaceholder="Describe a change to the script… (Enter to send)"
          questionPlaceholder="Ask a question about the script… (opens Chat)"
        />

        {(isEditing || editResponse || editError) && (
          <div className="script-editor__ai-response">
            {isEditing && !editResponse && (
              <span className="script-editor__ai-response-pending">
                <span className="spinner" style={{ width: 12, height: 12 }} />
                Receiving response…
              </span>
            )}
            {editResponse && (
              <pre className="script-editor__ai-response-text">{editResponse}</pre>
            )}
            {editError && (
              <span style={{ color: "var(--color-error)" }}>{editError}</span>
            )}
          </div>
        )}

        <div className="script-editor__output">
          <div className="script-editor__output-header">
            Output
            {runFinished && (
              <span style={{ marginLeft: "8px", fontSize: "11px", opacity: 0.7 }}>
                exit {runFinished.exitCode ?? "—"} · {runFinished.durationMs} ms
                {runFinished.timedOut && " (timed out)"}
              </span>
            )}
          </div>
          <div className="script-editor__output-lines">
            {runOutput.map((line, i) => (
              <pre
                key={i}
                className={`script-editor__output-line ${line.stream === "stderr" ? "script-editor__output-line--err" : ""}`}
              >
                {line.text}
              </pre>
            ))}
            <div ref={outputEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
