import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CodeProject } from "../api";
import Modal from "./Modal";

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
  const { t } = useTranslation();
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
        setError(t("dialog.errors.slugInvalid"));
        return;
      }
    }
    const trimmedUrl = gitUrl.trim();
    if (trimmedUrl && !/^(https?|git):\/\//i.test(trimmedUrl)) {
      setError(t("dialog.codeProject.errGitUrlScheme"));
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
    <Modal onClose={onClose}>
      <form onSubmit={handleSubmit} className="project-form">
        <Modal.Header
          title={
            isEdit
              ? t("dialog.codeProject.titleEdit")
              : t("dialog.codeProject.titleCreate")
          }
        />
        <label className="project-form__field">
          <span className="project-form__label">{t("dialog.codeProject.nameLabel")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("dialog.codeProject.namePlaceholder")}
            disabled={isEdit || busy}
            autoFocus={!isEdit}
            required={!isEdit}
          />
          <span className="project-form__hint">{t("dialog.codeProject.nameHint")}</span>
        </label>
        <label className="project-form__field">
          <span className="project-form__label">{t("dialog.codeProject.descriptionLabel")}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            disabled={busy}
          />
        </label>
        <label className="project-form__field">
          <span className="project-form__label">{t("dialog.codeProject.gitUrlLabel")}</span>
          <input
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            placeholder={t("dialog.codeProject.gitUrlPlaceholder")}
            disabled={isEdit || busy}
            type="url"
          />
          <span className="project-form__hint">{t("dialog.codeProject.gitUrlHint")}</span>
        </label>
        <label className="project-form__field">
          <span className="project-form__label">{t("dialog.codeProject.gitRefLabel")}</span>
          <input
            value={gitRef}
            onChange={(e) => setGitRef(e.target.value)}
            placeholder={t("dialog.codeProject.gitRefPlaceholder")}
            disabled={busy}
          />
          <span className="project-form__hint">{t("dialog.codeProject.gitRefHint")}</span>
        </label>
        {error && (
          <div className="project-form__hint project-form__hint--error">
            {error}
          </div>
        )}
        <Modal.Footer>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy
              ? t("common.saving")
              : isEdit
                ? t("common.save")
                : t("common.create")}
          </button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
