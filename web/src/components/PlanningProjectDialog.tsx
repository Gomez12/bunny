import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlanningProject } from "../api";
import Modal from "./Modal";

interface Props {
  open: boolean;
  initial?: PlanningProject | null;
  onClose: () => void;
  onSubmit: (body: {
    name?: string;
    description?: string;
    startDate?: string | null;
    sprintDurationDays?: number | null;
  }) => Promise<void>;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function PlanningProjectDialog({
  open,
  initial,
  onClose,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [startDate, setStartDate] = useState(initial?.startDate ?? "");
  const [sprintDurationDays, setSprintDurationDays] = useState<string>(
    initial?.sprintDurationDays != null ? String(initial.sprintDurationDays) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isEdit = Boolean(initial);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setDescription(initial?.description ?? "");
    setStartDate(initial?.startDate ?? "");
    setSprintDurationDays(
      initial?.sprintDurationDays != null
        ? String(initial.sprintDurationDays)
        : "",
    );
    setError(null);
  }, [open, initial]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isEdit) {
      const slug = name.trim().toLowerCase();
      if (!SLUG_RE.test(slug)) {
        setError(t("dialog.errors.slugInvalid"));
        return;
      }
    }
    const sd = startDate.trim();
    if (sd && !ISO_DATE_RE.test(sd)) {
      setError(t("dialog.planningProject.errStartDate"));
      return;
    }
    let parsedSprint: number | null = null;
    const sdur = sprintDurationDays.trim();
    if (sdur !== "") {
      const n = Number(sdur);
      if (!Number.isFinite(n) || n < 0 || n > 999) {
        setError(t("dialog.planningProject.errSprintDuration"));
        return;
      }
      parsedSprint = n === 0 ? null : Math.floor(n);
    }
    setBusy(true);
    try {
      if (isEdit) {
        await onSubmit({
          description: description.trim(),
          startDate: sd === "" ? null : sd,
          sprintDurationDays: parsedSprint,
        });
      } else {
        await onSubmit({
          name: name.trim().toLowerCase(),
          description: description.trim(),
          startDate: sd === "" ? null : sd,
          sprintDurationDays: parsedSprint,
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
              ? t("dialog.planningProject.titleEdit")
              : t("dialog.planningProject.titleCreate")
          }
        />
        <label className="project-form__field">
          <span className="project-form__label">{t("dialog.planningProject.nameLabel")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("dialog.planningProject.namePlaceholder")}
            disabled={isEdit || busy}
            autoFocus={!isEdit}
            required={!isEdit}
          />
          <span className="project-form__hint">{t("dialog.planningProject.nameHint")}</span>
        </label>
        <label className="project-form__field">
          <span className="project-form__label">{t("dialog.planningProject.descriptionLabel")}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            disabled={busy}
          />
        </label>
        <label className="project-form__field">
          <span className="project-form__label">{t("dialog.planningProject.startDateLabel")}</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            disabled={busy}
          />
          <span className="project-form__hint">{t("dialog.planningProject.startDateHint")}</span>
        </label>
        <label className="project-form__field">
          <span className="project-form__label">{t("dialog.planningProject.sprintDurationLabel")}</span>
          <input
            type="number"
            min={0}
            max={999}
            placeholder={t("dialog.planningProject.sprintDurationPlaceholder")}
            value={sprintDurationDays}
            onChange={(e) => setSprintDurationDays(e.target.value)}
            disabled={busy}
          />
          <span className="project-form__hint">{t("dialog.planningProject.sprintDurationHint")}</span>
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
