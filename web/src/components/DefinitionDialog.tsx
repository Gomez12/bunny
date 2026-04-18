import { useEffect, useRef, useState } from "react";
import {
  clearDefinitionLlm,
  setDefinitionActive,
  streamGenerateDefinition,
  type AuthUser,
  type ActiveDescription,
  type Definition,
  type DefinitionInput,
  type ServerEvent,
} from "../api";

type Props =
  | {
      project: string;
      currentUser: AuthUser;
      mode: "create";
      onClose: () => void;
      onCreate: (input: DefinitionInput) => Promise<void>;
    }
  | {
      project: string;
      currentUser: AuthUser;
      mode: "edit";
      definition: Definition;
      onClose: () => Promise<void> | void;
      onSave: (patch: DefinitionInput) => Promise<void>;
      onRefreshed: () => Promise<void>;
    };

export default function DefinitionDialog(props: Props) {
  const initial: Definition | null = props.mode === "edit" ? props.definition : null;

  const [term, setTerm] = useState(initial?.term ?? "");
  const [manual, setManual] = useState(initial?.manualDescription ?? "");
  const [projectDependent, setProjectDependent] = useState(initial?.isProjectDependent ?? false);
  const [active, setActive] = useState<ActiveDescription>(initial?.activeDescription ?? "manual");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [generating, setGenerating] = useState(initial?.llmStatus === "generating");
  const [generationLog, setGenerationLog] = useState<string[]>([]);
  const genAbortRef = useRef<AbortController | null>(null);

  const canEdit =
    props.mode === "create" ||
    props.currentUser.role === "admin" ||
    initial?.createdBy === props.currentUser.id;

  // Keep local state in sync when the backend row changes (after a save or a
  // generation finishes). Keyed on id + updatedAt so live edits aren't clobbered
  // on every unrelated re-render.
  const editDef = props.mode === "edit" ? props.definition : null;
  const editDefId = editDef?.id ?? null;
  const editDefUpdatedAt = editDef?.updatedAt ?? null;
  useEffect(() => {
    if (!editDef) return;
    setTerm(editDef.term);
    setManual(editDef.manualDescription);
    setProjectDependent(editDef.isProjectDependent);
    setActive(editDef.activeDescription);
    setGenerating(editDef.llmStatus === "generating");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editDefId, editDefUpdatedAt]);

  useEffect(() => {
    return () => {
      genAbortRef.current?.abort();
    };
  }, []);

  const handleClose = () => {
    genAbortRef.current?.abort();
    void props.onClose();
  };

  /** Returns true on a successful save. */
  const handleSaveMeta = async (): Promise<boolean> => {
    if (!canEdit) return false;
    const trimmed = term.trim();
    if (!trimmed) {
      setError("Term is required");
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      const patch: DefinitionInput = {
        term: trimmed,
        manualDescription: manual,
        isProjectDependent: projectDependent,
        activeDescription: active,
      };
      if (props.mode === "create") {
        await props.onCreate(patch);
      } else {
        await props.onSave(patch);
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSetActive = async (next: ActiveDescription) => {
    if (props.mode !== "edit" || !canEdit) return;
    setActive(next);
    try {
      await setDefinitionActive(props.project, props.definition.id, next);
      await props.onRefreshed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleGenerate = async () => {
    if (props.mode !== "edit" || !canEdit) return;
    if (generating) return;

    // Save any meta edits first so the prompt reflects the current flag.
    const saved = await handleSaveMeta();
    if (!saved) return;

    setGenerating(true);
    setGenerationLog([]);
    setError(null);

    const controller = new AbortController();
    genAbortRef.current = controller;

    try {
      const res = await streamGenerateDefinition(props.project, props.definition.id);
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string };
        setError(err.error ?? `HTTP ${res.status}`);
        setGenerating(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setError("No response body");
        setGenerating(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const ev = JSON.parse(payload) as ServerEvent;
              handleSseEvent(ev);
            } catch {
              /* ignore malformed */
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
      genAbortRef.current = null;
      if (props.mode === "edit") {
        await props.onRefreshed();
      }
    }
  };

  function handleSseEvent(ev: ServerEvent) {
    if (ev.type === "error") {
      setError(ev.message);
      return;
    }
    if (ev.type === "tool_call" && ev.name) {
      setGenerationLog((prev) => [...prev, `→ ${ev.name}`]);
      return;
    }
    if (ev.type === "tool_result") {
      setGenerationLog((prev) => [...prev, `  ${ev.ok ? "✓" : "✗"} ${ev.name}`]);
      return;
    }
    if (ev.type === "kb_definition_generated") {
      setGenerationLog((prev) => [...prev, `✓ stored ${ev.sources} source${ev.sources === 1 ? "" : "s"}`]);
      return;
    }
  }

  const handleClear = async () => {
    if (props.mode !== "edit" || !canEdit) return;
    if (!confirm("Clear the LLM-generated short, long and sources for this definition?")) return;
    try {
      await clearDefinitionLlm(props.project, props.definition.id);
      await props.onRefreshed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const current = props.mode === "edit" ? props.definition : null;
  const hasLlmData = !!(current && (current.llmShort || current.llmLong || current.llmSources.length > 0));
  const canGenerate = props.mode === "edit" && canEdit && !generating;
  const canClear = props.mode === "edit" && canEdit && hasLlmData && !generating;

  return (
    <div className="modal-backdrop" onClick={handleClose}>
      <div className="modal modal--wide kb-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>{props.mode === "create" ? "New definition" : current?.term ?? "Edit definition"}</h2>
          <button className="modal__close" onClick={handleClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="modal__body">
          {error && (
            <div className="kb-dialog__error">
              {error}
              <button onClick={() => setError(null)} aria-label="Dismiss">&times;</button>
            </div>
          )}

          <div className="kb-dialog__field">
            <label>Term *</label>
            <input
              className="kb-dialog__input"
              type="text"
              value={term}
              disabled={!canEdit}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="e.g. supplier"
              autoFocus={props.mode === "create"}
            />
          </div>

          <div className="kb-dialog__field">
            <label className="kb-dialog__active-row">
              <input
                type="radio"
                name="active"
                checked={active === "manual"}
                disabled={!canEdit}
                onChange={() => void handleSetActive("manual")}
              />
              Manual description
            </label>
            <textarea
              className="kb-dialog__textarea"
              rows={4}
              value={manual}
              disabled={!canEdit}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Write the project-specific meaning of this term."
            />
          </div>

          <div className="kb-dialog__field kb-dialog__field--inline">
            <label className="kb-dialog__checkbox">
              <input
                type="checkbox"
                checked={projectDependent}
                disabled={!canEdit}
                onChange={(e) => setProjectDependent(e.target.checked)}
              />
              Project-dependent definition
              <span className="kb-dialog__hint">
                When on, searches blend the term with the project domain (e.g. in a cars project, "chair" → "car seat").
              </span>
            </label>
          </div>

          {props.mode === "edit" && (
            <div className="kb-dialog__llm">
              <div className="kb-dialog__llm-header">
                <span className="kb-dialog__llm-title">AI-generated</span>
                <div className="kb-dialog__llm-actions">
                  <button
                    className="btn btn--send"
                    onClick={() => void handleGenerate()}
                    disabled={!canGenerate}
                    title={generating ? "Generation in progress" : "Generate with LLM"}
                  >
                    {generating ? "Generating…" : hasLlmData ? "Regenerate" : "Generate"}
                  </button>
                  <button
                    className="btn"
                    onClick={() => void handleClear()}
                    disabled={!canClear}
                    title="Clear the short, long and sources"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {current?.llmCleared && !hasLlmData && (
                <p className="kb-dialog__note">
                  Cleared. The scheduled auto-fill will skip this row until you click Generate again.
                </p>
              )}

              {current?.llmError && (
                <p className="kb-dialog__error" role="alert">{current.llmError}</p>
              )}

              {generationLog.length > 0 && (
                <pre className="kb-dialog__log">{generationLog.join("\n")}</pre>
              )}

              <div className="kb-dialog__panel">
                <label className="kb-dialog__active-row">
                  <input
                    type="radio"
                    name="active"
                    checked={active === "short"}
                    disabled={!canEdit || !current?.llmShort}
                    onChange={() => void handleSetActive("short")}
                  />
                  Short description
                </label>
                <div className="kb-dialog__readonly">
                  {current?.llmShort ? (
                    current.llmShort
                  ) : (
                    <em className="kb-dialog__placeholder">Not generated yet.</em>
                  )}
                </div>
              </div>

              <div className="kb-dialog__panel">
                <label className="kb-dialog__active-row">
                  <input
                    type="radio"
                    name="active"
                    checked={active === "long"}
                    disabled={!canEdit || !current?.llmLong}
                    onChange={() => void handleSetActive("long")}
                  />
                  Long description
                </label>
                <div className="kb-dialog__readonly kb-dialog__readonly--long">
                  {current?.llmLong ? (
                    current.llmLong
                  ) : (
                    <em className="kb-dialog__placeholder">Not generated yet.</em>
                  )}
                </div>
              </div>

              <div className="kb-dialog__panel">
                <span className="kb-dialog__panel-label">Sources</span>
                {current && current.llmSources.length > 0 ? (
                  <ul className="kb-dialog__sources">
                    {current.llmSources.map((s, i) => (
                      <li key={`${s.url}-${i}`}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer">
                          {s.title || s.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <em className="kb-dialog__placeholder">No sources.</em>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal__footer">
          <button className="btn" onClick={handleClose}>Close</button>
          {canEdit && (
            <button className="btn btn--send" onClick={() => void handleSaveMeta()} disabled={saving}>
              {saving ? "Saving…" : props.mode === "create" ? "Create" : "Save"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
