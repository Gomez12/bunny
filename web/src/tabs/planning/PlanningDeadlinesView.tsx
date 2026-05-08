import { useCallback, useEffect, useState } from "react";
import {
  type PlanningDeadline,
  type PlanningProject,
  createPlanningDeadline,
  deletePlanningDeadline,
  listPlanningDeadlines,
  patchPlanningDeadline,
} from "../../api";
import { Pencil, Plus, Trash2 } from "../../lib/icons";
import EmptyState from "../../components/EmptyState";
import Modal from "../../components/Modal";

interface Props {
  planningProject: PlanningProject;
}

export default function PlanningDeadlinesView({ planningProject }: Props) {
  const [items, setItems] = useState<PlanningDeadline[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlanningDeadline | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    try {
      setItems(await listPlanningDeadlines(planningProject.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [planningProject.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="planning-view">
      <header className="planning-view__header">
        <h2>Deadlines</h2>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setCreating(true)}
        >
          <Plus size={14} /> New deadline
        </button>
      </header>
      {error && <div className="planning-tab__error">{error}</div>}
      {items.length === 0 ? (
        <EmptyState
          title="No deadlines yet"
          description="Add fixed end-dates so the scheduler can flag at-risk wishes."
          action={
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setCreating(true)}
            >
              <Plus size={14} /> New deadline
            </button>
          }
        />
      ) : (
        <ul className="planning-card-list">
          {items.map((dl) => (
            <li key={dl.id}>
              <article className="planning-card">
                <div className="planning-card__head">
                  <span
                    className="planning-card__swatch"
                    style={{ background: dl.color ?? "var(--accent)" }}
                    aria-hidden="true"
                  />
                  <span className="planning-card__name">{dl.name}</span>
                  <span className="kb-chip kb-chip--deadline">
                    {dl.dueDate}
                  </span>
                </div>
                {dl.description && (
                  <p className="planning-card__desc">{dl.description}</p>
                )}
                <div className="planning-card__actions">
                  <button
                    type="button"
                    className="planning-card__action-btn"
                    onClick={() => setEditing(dl)}
                    aria-label="Edit"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="planning-card__action-btn"
                    onClick={async () => {
                      if (
                        !window.confirm(`Move deadline "${dl.name}" to the trash?`)
                      )
                        return;
                      try {
                        await deletePlanningDeadline(dl.id);
                        void reload();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                    aria-label="Delete"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
      {(creating || editing) && (
        <Modal
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        >
          <Modal.Header
            title={
              editing ? `Edit deadline "${editing.name}"` : "New deadline"
            }
          />
          <DeadlineForm
            initial={editing}
            onCancel={() => {
              setCreating(false);
              setEditing(null);
            }}
            onSubmit={async (body) => {
              try {
                if (editing) await patchPlanningDeadline(editing.id, body);
                else
                  await createPlanningDeadline(planningProject.id, {
                    name: body.name ?? "",
                    description: body.description,
                    dueDate: body.dueDate ?? "",
                    color: body.color,
                  });
                setCreating(false);
                setEditing(null);
                void reload();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function DeadlineForm({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: PlanningDeadline | null;
  onCancel: () => void;
  onSubmit: (body: {
    name?: string;
    description?: string;
    dueDate?: string;
    color?: string | null;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? "");
  const [color, setColor] = useState(initial?.color ?? "");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="planning-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onSubmit({
          name: name.trim() || undefined,
          description: description.trim(),
          dueDate: dueDate || undefined,
          color: color.trim() === "" ? null : color.trim(),
        });
        setBusy(false);
      }}
    >
      <label className="project-form__field">
        <span className="project-form__label">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          disabled={busy}
        />
      </label>
      <label className="project-form__field">
        <span className="project-form__label">Due date</span>
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          required
          disabled={busy}
        />
      </label>
      <label className="project-form__field">
        <span className="project-form__label">Description (optional)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          disabled={busy}
        />
      </label>
      <label className="project-form__field">
        <span className="project-form__label">Color (optional)</span>
        <input
          type="color"
          value={color || "#dc2626"}
          onChange={(e) => setColor(e.target.value)}
          disabled={busy}
        />
      </label>
      <div className="planning-form__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save" : "Create"}
        </button>
      </div>
    </form>
  );
}
