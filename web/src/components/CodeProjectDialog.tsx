import { useEffect, useState } from "react";
import type { CodeProject } from "../api";

interface Props {
  open: boolean;
  initial?: CodeProject | null;
  onClose: () => void;
  onSubmit: (body: {
    name?: string;
    description?: string;
    gitUrl?: string;
    gitRef?: string;
  }) => Promise<void>;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export default function CodeProjectDialog({
  open,
  initial,
  onClose,
  onSubmit,
}: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [gitUrl, setGitUrl] = useState(initial?.gitUrl ?? "");
  const [gitRef, setGitRef] = useState(initial?.gitRef ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isEdit = Boolean(initial);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setDescription(initial?.description ?? "");
    setGitUrl(initial?.gitUrl ?? "");
    setGitRef(initial?.gitRef ?? "");
    setError(null);
  }, [open, initial]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isEdit) {
      const trimmedName = name.trim().toLowerCase();
      if (!SLUG_RE.test(trimmedName)) {
        setError(
          "Name must start with a letter or digit and may contain only lowercase letters, digits, '-' or '_'.",
        );
        return;
      }
    }
    const trimmedUrl = gitUrl.trim();
    if (trimmedUrl && !/^(https?|git):\/\//i.test(trimmedUrl)) {
      setError("Git URL must start with https:// or git://.");
      return;
    }
    setBusy(true);
    try {
      if (isEdit) {
        await onSubmit({
          description: description.trim(),
          gitRef: gitRef.trim() || undefined,
        });
      } else {
        await onSubmit({
          name: name.trim().toLowerCase(),
          description: description.trim(),
          gitUrl: trimmedUrl || undefined,
          gitRef: gitRef.trim() || undefined,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit} className="project-form">
          <h2 className="project-form__title">
            {isEdit ? `Edit code project` : "New code project"}
          </h2>
          <label className="project-form__field">
            <span className="project-form__label">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-repo"
              disabled={isEdit || busy}
              autoFocus={!isEdit}
              required={!isEdit}
            />
            <span className="project-form__hint">
              Used as a directory name. Immutable after creation.
            </span>
          </label>
          <label className="project-form__field">
            <span className="project-form__label">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              disabled={busy}
            />
          </label>
          <label className="project-form__field">
            <span className="project-form__label">Git URL (optional)</span>
            <input
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              disabled={isEdit || busy}
              type="url"
            />
            <span className="project-form__hint">
              Public repositories only (https:// or git://). Leave empty for a
              local-only scratch area.
            </span>
          </label>
          <label className="project-form__field">
            <span className="project-form__label">Git ref (optional)</span>
            <input
              value={gitRef}
              onChange={(e) => setGitRef(e.target.value)}
              placeholder="main"
              disabled={busy}
            />
            <span className="project-form__hint">
              Branch, tag or commit. Leave empty to follow the remote default.
            </span>
          </label>
          {error && (
            <div className="project-form__hint project-form__hint--error">
              {error}
            </div>
          )}
          <div className="project-form__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? "Saving…" : isEdit ? "Save" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
