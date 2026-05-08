import { useEffect, useState } from "react";
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
        setError(
          "Name must start with a letter or digit and may contain only lowercase letters, digits, '-' or '_'.",
        );
        return;
      }
    }
    const sd = startDate.trim();
    if (sd && !ISO_DATE_RE.test(sd)) {
      setError("Start date must be in YYYY-MM-DD format.");
      return;
    }
    let parsedSprint: number | null = null;
    const sdur = sprintDurationDays.trim();
    if (sdur !== "") {
      const n = Number(sdur);
      if (!Number.isFinite(n) || n < 0 || n > 999) {
        setError("Sprint duration must be a number between 0 and 999.");
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
          title={isEdit ? "Edit planning project" : "New planning project"}
        />
        <label className="project-form__field">
          <span className="project-form__label">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="q1-roadmap"
            disabled={isEdit || busy}
            autoFocus={!isEdit}
            required={!isEdit}
          />
          <span className="project-form__hint">
            Slug used in the URL and picker. Immutable after creation.
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
          <span className="project-form__label">Project start (optional)</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            disabled={busy}
          />
          <span className="project-form__hint">
            Earliest date the scheduler will place wishes. Leave empty to use
            today.
          </span>
        </label>
        <label className="project-form__field">
          <span className="project-form__label">
            Sprint duration (optional)
          </span>
          <input
            type="number"
            min={0}
            max={999}
            placeholder="e.g. 10"
            value={sprintDurationDays}
            onChange={(e) => setSprintDurationDays(e.target.value)}
            disabled={busy}
          />
          <span className="project-form__hint">
            Working days per sprint. 5 = weekly, 10 = bi-weekly, 15 = three
            weeks. Leave empty or 0 to disable sprint indicators.
          </span>
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
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "Saving…" : isEdit ? "Save" : "Create"}
          </button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
