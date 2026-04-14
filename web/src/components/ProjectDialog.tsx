import { useEffect, useRef, useState } from "react";
import type { Project, ProjectVisibility } from "../api";

export interface ProjectDialogValue {
  name: string;
  description: string;
  systemPrompt: string;
  appendMode: boolean;
  visibility: ProjectVisibility;
  /** null = inherit the global [memory] default. */
  lastN: number | null;
  /** null = inherit the global [memory] default. */
  recallK: number | null;
}

interface Props {
  mode: "create" | "edit";
  initial?: Project;
  onClose: () => void;
  onSubmit: (value: ProjectDialogValue) => Promise<void>;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Return null (= inherit), a non-negative integer, or "invalid". */
function parseOverride(raw: string): number | null | "invalid" {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return "invalid";
  return n;
}

export default function ProjectDialog({ mode, initial, onClose, onSubmit }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [appendMode, setAppendMode] = useState(initial?.appendMode ?? true);
  const [visibility, setVisibility] = useState<ProjectVisibility>(initial?.visibility ?? "public");
  const [lastN, setLastN] = useState<string>(initial?.lastN == null ? "" : String(initial.lastN));
  const [recallK, setRecallK] = useState<string>(initial?.recallK == null ? "" : String(initial.recallK));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "create") nameRef.current?.focus();
  }, [mode]);

  const nameValid = mode === "edit" || NAME_RE.test(name.trim().toLowerCase());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameValid) {
      setError("Name must be lowercase letters, digits, _ or - (max 63 chars).");
      return;
    }
    const parsedLastN = parseOverride(lastN);
    const parsedRecallK = parseOverride(recallK);
    if (parsedLastN === "invalid" || parsedRecallK === "invalid") {
      setError("Memory overrides must be blank or a non-negative integer.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim().toLowerCase(),
        description: description.trim(),
        systemPrompt,
        appendMode,
        visibility,
        lastN: parsedLastN,
        recallK: parsedRecallK,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit} className="project-form">
          <h2>{mode === "create" ? "New project" : `Edit ${initial?.name}`}</h2>

          <label className="project-form__field">
            <span>Name</span>
            <input
              ref={nameRef}
              type="text"
              value={name}
              disabled={mode === "edit"}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. research, product-x"
              autoComplete="off"
              required
            />
            {!nameValid && name !== "" && (
              <span className="project-form__hint project-form__hint--error">
                Lowercase, digits, _ or - only (max 63 chars).
              </span>
            )}
          </label>

          <label className="project-form__field">
            <span>Description (optional)</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short summary shown on the card"
            />
          </label>

          <label className="project-form__field">
            <span>System prompt</span>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={8}
              placeholder="Instructions that apply to every chat in this project"
            />
          </label>

          <div className="project-form__row">
            <label className="project-form__choice">
              <input
                type="checkbox"
                checked={appendMode}
                onChange={(e) => setAppendMode(e.target.checked)}
              />
              <span>Append to base prompt (uncheck to replace)</span>
            </label>

            <label className="project-form__choice">
              <span>Visibility</span>
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as ProjectVisibility)}
              >
                <option value="public">Public</option>
                <option value="private">Private (only you)</option>
              </select>
            </label>
          </div>

          <div className="project-form__row">
            <label className="project-form__field">
              <span>Last N turns (verbatim)</span>
              <input
                type="number"
                min={0}
                step={1}
                value={lastN}
                onChange={(e) => setLastN(e.target.value)}
                placeholder="inherit global"
              />
              <span className="project-form__hint">
                How many recent user/assistant turns to replay verbatim. Leave blank to inherit.
              </span>
            </label>

            <label className="project-form__field">
              <span>Hybrid recall K</span>
              <input
                type="number"
                min={0}
                step={1}
                value={recallK}
                onChange={(e) => setRecallK(e.target.value)}
                placeholder="inherit global"
              />
              <span className="project-form__hint">
                How many BM25 + vector hits to inject. Leave blank to inherit.
              </span>
            </label>
          </div>

          {error && <div className="project-form__error">{error}</div>}

          <div className="project-form__actions">
            <button type="button" className="btn" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn--send" disabled={submitting || !nameValid}>
              {submitting ? "Saving…" : mode === "create" ? "Create" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
