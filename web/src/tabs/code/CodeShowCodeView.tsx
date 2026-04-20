import { useCallback, useEffect, useState } from "react";
import {
  fetchCodeProject,
  listCodeProjectTree,
  triggerCodeProjectClone,
  streamCodeEdit,
  type CodeProject,
  type CodeTreeEntry,
} from "../../api";
import {
  AlertCircle,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  Pencil,
  RefreshCw,
  Send,
  Trash2,
} from "../../lib/icons";
import { formatSize } from "../../lib/format";

const POLL_MS = 2000;
// Keeps the edit-mode live log bounded for long runs — DOM + memory pressure.
const MAX_STREAM_LOG_CHARS = 8000;

function clampLog(text: string): string {
  return text.length > MAX_STREAM_LOG_CHARS
    ? text.slice(text.length - MAX_STREAM_LOG_CHARS)
    : text;
}

interface Props {
  codeProject: CodeProject;
  onChanged: (next: CodeProject) => void;
  onEditProject: () => void;
  onDeleteProject: () => void;
}

/**
 * "Show Code" feature: browse the code project's working tree on disk and
 * apply quick LLM edits. No sidebar — the code project is picked from the
 * rail at the top, this view fills the whole main area.
 */
export default function CodeShowCodeView({
  codeProject,
  onChanged,
  onEditProject,
  onDeleteProject,
}: Props) {
  const [treePath, setTreePath] = useState("");
  const [entries, setEntries] = useState<CodeTreeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamLog, setStreamLog] = useState("");

  const reload = useCallback(async () => {
    try {
      const fresh = await fetchCodeProject(codeProject.id);
      onChanged(fresh);
      return fresh;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [codeProject.id, onChanged]);

  const loadTree = useCallback(
    async (path: string) => {
      try {
        const { entries: fresh } = await listCodeProjectTree(
          codeProject.id,
          path,
        );
        setEntries(fresh);
      } catch (e) {
        setEntries([]);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [codeProject.id],
  );

  // Reset navigation on project switch.
  useEffect(() => {
    setTreePath("");
    setError(null);
  }, [codeProject.id]);

  // Load the tree whenever the status is ready or the path changes.
  useEffect(() => {
    if (codeProject.gitStatus !== "ready") return;
    void loadTree(treePath);
  }, [codeProject.id, codeProject.gitStatus, treePath, loadTree]);

  // Poll while cloning.
  useEffect(() => {
    if (codeProject.gitStatus !== "cloning") return;
    const t = setTimeout(() => void reload(), POLL_MS);
    return () => clearTimeout(t);
  }, [codeProject.id, codeProject.gitStatus, reload]);

  const handleClone = async () => {
    try {
      await triggerCodeProjectClone(codeProject.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleEditSubmit = async () => {
    const text = instruction.trim();
    if (!text) return;
    setError(null);
    setStreaming(true);
    setStreamLog("");
    try {
      const { done } = streamCodeEdit(codeProject.id, text, (ev) => {
        if (ev.type === "content") {
          setStreamLog((prev) => clampLog(prev + ev.text));
        } else if (ev.type === "tool_call" && ev.name) {
          setStreamLog((prev) => clampLog(prev + `\n[tool_call] ${ev.name}\n`));
        } else if (ev.type === "error") {
          setError(ev.message);
        }
      });
      await done;
      setInstruction("");
      await reload();
      await loadTree(treePath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="code-view">
      <header className="code-view__header">
        <div>
          <h2 className="code-view__title">{codeProject.name}</h2>
          <div className="code-view__meta">
            <StatusBadge status={codeProject.gitStatus} />
            {codeProject.gitUrl && (
              <span className="code-view__url" title={codeProject.gitUrl}>
                {codeProject.gitUrl}
              </span>
            )}
          </div>
          {codeProject.gitError && (
            <div className="project-form__hint project-form__hint--error">
              <AlertCircle size={14} /> {codeProject.gitError}
            </div>
          )}
        </div>
        <div className="code-view__header-actions">
          {codeProject.gitUrl && (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={codeProject.gitStatus === "cloning"}
              onClick={handleClone}
              title="Re-clone"
            >
              <RefreshCw size={14} />{" "}
              {codeProject.gitStatus === "cloning" ? "Cloning…" : "Re-clone"}
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onEditProject}
            title="Edit"
          >
            <Pencil size={14} /> Edit
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--danger"
            onClick={onDeleteProject}
            title="Delete"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </header>
      <div className="code-view__body">
        <FileTreeView
          status={codeProject.gitStatus}
          path={treePath}
          entries={entries}
          onNavigate={setTreePath}
        />
      </div>

      {streaming && (
        <pre className="code-view__stream-log" aria-live="polite">
          {streamLog || "Working…"}
        </pre>
      )}

      {error && (
        <div className="project-form__hint project-form__hint--error">
          {error}
        </div>
      )}

      <div className="code-view__composer">
        <textarea
          className="code-view__composer-input"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Quick edit — e.g. 'add a README documenting each top-level file'. The agent may read and write files."
          rows={2}
          disabled={streaming}
        />
        <button
          type="button"
          className="btn btn--primary code-view__composer-send"
          disabled={
            streaming ||
            !instruction.trim() ||
            codeProject.gitStatus !== "ready"
          }
          onClick={() => void handleEditSubmit()}
        >
          <Send size={14} /> {streaming ? "Streaming…" : "Run edit"}
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: CodeProject["gitStatus"] }) {
  const label: Record<CodeProject["gitStatus"], string> = {
    idle: "Idle",
    cloning: "Cloning",
    ready: "Ready",
    error: "Error",
  };
  return <span className={`badge badge--${status}`}>{label[status]}</span>;
}

interface TreeProps {
  status: CodeProject["gitStatus"];
  path: string;
  entries: CodeTreeEntry[];
  onNavigate: (next: string) => void;
}

function FileTreeView({ status, path, entries, onNavigate }: TreeProps) {
  if (status === "cloning") {
    return (
      <div className="code-view__tree-state">
        <Loader2 size={16} /> Cloning repository…
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="code-view__tree-state">
        <AlertCircle size={16} /> Clone failed. Re-clone from the header to
        retry.
      </div>
    );
  }
  const breadcrumbs = ["", ...path.split("/").filter(Boolean)];
  return (
    <div className="code-view__tree">
      <nav className="code-view__breadcrumbs" aria-label="Path">
        {breadcrumbs.map((seg, idx) => {
          const target = breadcrumbs.slice(1, idx + 1).join("/");
          const isLast = idx === breadcrumbs.length - 1;
          return (
            <span key={idx} className="code-view__breadcrumb">
              <button
                type="button"
                className="code-view__breadcrumb-btn"
                onClick={() => onNavigate(target)}
                disabled={isLast}
              >
                {seg === "" ? "/" : seg}
              </button>
              {!isLast && <ChevronRight size={12} />}
            </span>
          );
        })}
      </nav>
      <ul className="code-view__tree-list">
        {entries.length === 0 && (
          <li className="code-view__tree-empty">(empty)</li>
        )}
        {entries.map((e) => (
          <li key={e.path} className="code-view__tree-row">
            <button
              type="button"
              className="code-view__tree-button"
              onClick={() => {
                if (e.kind === "dir") onNavigate(e.path);
              }}
              disabled={e.kind !== "dir"}
              title={e.path}
            >
              {e.kind === "dir" ? (
                <Folder size={14} />
              ) : (
                <FileText size={14} />
              )}
              <span className="code-view__tree-name">{e.name}</span>
              {e.kind === "file" && (
                <span className="code-view__tree-size">
                  {formatSize(e.size)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

