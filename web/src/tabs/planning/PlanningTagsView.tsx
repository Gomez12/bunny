import { useCallback, useEffect, useState } from "react";
import {
  type PlanningProject,
  type PlanningTag,
  createPlanningTag,
  deletePlanningTag,
  listPlanningTags,
  patchPlanningTag,
} from "../../api";
import { Pencil, Plus, Trash2 } from "../../lib/icons";
import EmptyState from "../../components/EmptyState";
import Modal from "../../components/Modal";

interface Props {
  planningProject: PlanningProject;
}

export default function PlanningTagsView({ planningProject }: Props) {
  const [items, setItems] = useState<PlanningTag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlanningTag | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    try {
      setItems(await listPlanningTags(planningProject.id));
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
        <h2>Tags</h2>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setCreating(true)}
        >
          <Plus size={14} /> New tag
        </button>
      </header>
      {error && <div className="planning-tab__error">{error}</div>}
      {items.length === 0 ? (
        <EmptyState
          title="No tags yet"
          description="Create tags to type your wishes and express prerequisite groups."
          action={
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setCreating(true)}
            >
              <Plus size={14} /> New tag
            </button>
          }
        />
      ) : (
        <ul className="planning-card-list">
          {items.map((tag) => (
            <li key={tag.id}>
              <article className="planning-card">
                <div className="planning-card__head">
                  <span
                    className="planning-card__swatch"
                    style={{ background: tag.color ?? "var(--border)" }}
                    aria-hidden="true"
                  />
                  <span className="planning-card__name">{tag.name}</span>
                </div>
                {tag.description && (
                  <p className="planning-card__desc">{tag.description}</p>
                )}
                <div className="planning-card__actions">
                  <button
                    type="button"
                    className="planning-card__action-btn"
                    onClick={() => setEditing(tag)}
                    aria-label="Edit"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="planning-card__action-btn"
                    onClick={async () => {
                      if (!window.confirm(`Move "${tag.name}" to the trash?`))
                        return;
                      try {
                        await deletePlanningTag(tag.id);
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
            title={editing ? `Edit tag "${editing.name}"` : "New tag"}
          />
          <TagForm
            initial={editing}
            onCancel={() => {
              setCreating(false);
              setEditing(null);
            }}
            onSubmit={async (body) => {
              try {
                if (editing) await patchPlanningTag(editing.id, body);
                else
                  await createPlanningTag(
                    planningProject.id,
                    body as { name: string },
                  );
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

function TagForm({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: PlanningTag | null;
  onCancel: () => void;
  onSubmit: (body: {
    name?: string;
    description?: string;
    color?: string | null;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
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
        <span className="project-form__label">Description (optional)</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
        />
      </label>
      <label className="project-form__field">
        <span className="project-form__label">Color (optional)</span>
        <input
          type="color"
          value={color || "#888888"}
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
