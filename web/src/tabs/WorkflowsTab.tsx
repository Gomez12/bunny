import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthUser } from "../api";
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  type WorkflowDto,
} from "../api";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { ICON_DEFAULTS, Plus, Trash2, Workflow } from "../lib/icons";
import WorkflowEditor from "./workflows/WorkflowEditor";

interface Props {
  project: string;
  currentUser: AuthUser;
}

const ACTIVE_KEY_PREFIX = "bunny.activeWorkflow.";

const STARTER_TEMPLATE = `name = "My workflow"
description = "A short description of what this workflow does."

[[nodes]]
id = "plan"
prompt = """Explore the project and draft a plan. Be concise."""

[[nodes]]
id = "review"
depends_on = ["plan"]
interactive = true
`;

export default function WorkflowsTab({ project, currentUser }: Props) {
  const storageKey = `${ACTIVE_KEY_PREFIX}${project}`;
  const [items, setItems] = useState<WorkflowDto[] | null>(null);
  const [activeId, setActiveId] = useState<number | null>(() => {
    const raw = localStorage.getItem(storageKey);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<WorkflowDto | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const rows = await listWorkflows(project);
      setItems(rows);
      if (activeId != null && !rows.some((r) => r.id === activeId)) {
        setActiveId(null);
        localStorage.removeItem(storageKey);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    }
  }, [project, activeId, storageKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onPick = useCallback(
    (id: number) => {
      setActiveId(id);
      localStorage.setItem(storageKey, String(id));
    },
    [storageKey],
  );

  const onCreate = useCallback(async () => {
    setError(null);
    setCreating(true);
    try {
      // Slug is a filesystem identifier (immutable + lowercase/digits/-/_).
      // Generate a unique one so repeated "New" clicks don't collide; the
      // user can still rename the human-facing `name` inside the TOML.
      const slug = `workflow-${Date.now().toString(36)}`;
      const created = await createWorkflow(project, {
        slug,
        tomlText: STARTER_TEMPLATE,
      });
      await reload();
      onPick(created.workflow.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [project, reload, onPick]);

  const onDelete = useCallback(async () => {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    setConfirmDelete(null);
    try {
      await deleteWorkflow(id);
      if (activeId === id) {
        setActiveId(null);
        localStorage.removeItem(storageKey);
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [confirmDelete, activeId, reload, storageKey]);

  const active = useMemo(
    () => items?.find((w) => w.id === activeId) ?? null,
    [items, activeId],
  );

  return (
    <div className="workflows-tab">
      <aside className="workflows-tab__sidebar">
        <div className="workflows-tab__sidebar-head">
          <h2 className="workflows-tab__title">Workflows</h2>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={onCreate}
            disabled={creating}
            title="New workflow"
            aria-label="New workflow"
          >
            <Plus size={14} /> New
          </button>
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
        {items === null ? (
          <div className="workflows-tab__placeholder">Loading…</div>
        ) : items.length === 0 ? (
          <EmptyState
            size="sm"
            title="No workflows yet"
            description="Pipelines combine agent prompts, shell commands, loops, and human approvals."
            action={
              <button
                type="button"
                className="btn btn--primary"
                onClick={onCreate}
                disabled={creating}
              >
                Create your first workflow
              </button>
            }
          />
        ) : (
          <ul className="workflows-tab__list">
            {items.map((w) => (
              <li
                key={w.id}
                className={`workflows-tab__item ${
                  w.id === activeId ? "workflows-tab__item--active" : ""
                }`}
              >
                <button
                  type="button"
                  className="workflows-tab__item-btn"
                  onClick={() => onPick(w.id)}
                >
                  <Workflow {...ICON_DEFAULTS} />
                  <span className="workflows-tab__item-name">{w.name}</span>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Move to trash"
                  aria-label={`Move ${w.name} to trash`}
                  onClick={() => setConfirmDelete(w)}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <main className="workflows-tab__main">
        {active ? (
          <WorkflowEditor
            workflowId={active.id}
            project={project}
            currentUser={currentUser}
            onDeleted={() => void reload()}
          />
        ) : (
          <EmptyState
            title="Pick a workflow"
            description="Select a workflow on the left or create a new one to get started."
          />
        )}
      </main>
      <ConfirmDialog
        open={!!confirmDelete}
        message={
          confirmDelete
            ? `Move '${confirmDelete.name}' to the trash? You can restore it from the admin Trash tab.`
            : ""
        }
        confirmLabel="Move to trash"
        cancelLabel="Cancel"
        onConfirm={onDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
