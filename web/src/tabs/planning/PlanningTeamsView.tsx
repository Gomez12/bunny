import { useCallback, useEffect, useState } from "react";
import {
  type AuthUser,
  type PlanningProject,
  type PlanningTeam,
  addPlanningTeamMember,
  createPlanningTeam,
  deletePlanningTeam,
  listPlanningTeams,
  listUsers,
  patchPlanningTeam,
  removePlanningTeamMember,
} from "../../api";
import { Pencil, Plus, Trash2, Users, X } from "../../lib/icons";
import ConfirmDialog from "../../components/ConfirmDialog";
import EmptyState from "../../components/EmptyState";
import Modal from "../../components/Modal";

interface Props {
  planningProject: PlanningProject;
}

export default function PlanningTeamsView({ planningProject }: Props) {
  const [items, setItems] = useState<PlanningTeam[]>([]);
  const [allUsers, setAllUsers] = useState<AuthUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlanningTeam | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<PlanningTeam | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await listPlanningTeams(planningProject.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [planningProject.id]);

  useEffect(() => {
    void reload();
    void listUsers()
      .then(setAllUsers)
      .catch((e) =>
        setError((prev) => prev ?? (e instanceof Error ? e.message : String(e))),
      );
  }, [reload]);

  return (
    <div className="planning-view">
      <header className="planning-view__header">
        <h2>Teams</h2>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setCreating(true)}
        >
          <Plus size={14} /> New team
        </button>
      </header>
      {error && <div className="planning-tab__error">{error}</div>}
      {items.length === 0 ? (
        <EmptyState
          title="No teams yet"
          description="Define teams so the scheduler can respect parallel-work limits and route notifications."
          action={
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setCreating(true)}
            >
              <Plus size={14} /> New team
            </button>
          }
        />
      ) : (
        <ul className="planning-card-list">
          {items.map((team) => (
            <li key={team.id}>
              <article className="planning-card">
                <div className="planning-card__head">
                  <span
                    className="planning-card__swatch"
                    style={{
                      background: team.color ?? "var(--text-faint)",
                    }}
                    aria-hidden="true"
                  />
                  <span className="planning-card__name">{team.name}</span>
                  <span className="planning-card__meta">
                    <Users size={12} /> {team.maxParallel} parallel
                  </span>
                  <span className="planning-card__meta">
                    {team.members.length}{" "}
                    {team.members.length === 1 ? "member" : "members"}
                  </span>
                </div>
                {team.description && (
                  <p className="planning-card__desc">{team.description}</p>
                )}
                <div className="planning-card__actions">
                  <button
                    type="button"
                    className="planning-card__action-btn"
                    onClick={() => setEditing(team)}
                    aria-label="Edit"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="planning-card__action-btn"
                    onClick={() => setConfirmDelete(team)}
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
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Move team to trash"
        message={
          confirmDelete
            ? `Move team "${confirmDelete.name}" to the trash?`
            : ""
        }
        confirmLabel="Move to trash"
        onConfirm={async () => {
          const target = confirmDelete;
          setConfirmDelete(null);
          if (!target) return;
          try {
            await deletePlanningTeam(target.id);
            void reload();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
      {(creating || editing) && (
        <Modal
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          size="md"
        >
          <Modal.Header
            title={editing ? `Edit team "${editing.name}"` : "New team"}
          />
          <TeamForm
            initial={editing}
            users={allUsers}
            onCancel={() => {
              setCreating(false);
              setEditing(null);
            }}
            onSubmit={async (body) => {
              try {
                if (editing) {
                  await patchPlanningTeam(editing.id, {
                    name: body.name,
                    description: body.description,
                    color: body.color,
                    maxParallel: body.maxParallel,
                  });
                  const before = new Set(editing.members);
                  const after = new Set(body.members ?? []);
                  for (const u of after)
                    if (!before.has(u))
                      await addPlanningTeamMember(editing.id, u);
                  for (const u of before)
                    if (!after.has(u))
                      await removePlanningTeamMember(editing.id, u);
                } else {
                  await createPlanningTeam(planningProject.id, {
                    name: body.name ?? "",
                    description: body.description,
                    color: body.color,
                    maxParallel: body.maxParallel,
                    members: body.members,
                  });
                }
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

function TeamForm({
  initial,
  users,
  onCancel,
  onSubmit,
}: {
  initial: PlanningTeam | null;
  users: AuthUser[];
  onCancel: () => void;
  onSubmit: (body: {
    name?: string;
    description?: string;
    color?: string | null;
    maxParallel?: number;
    members?: string[];
  }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState(initial?.color ?? "");
  const [maxParallel, setMaxParallel] = useState(initial?.maxParallel ?? 1);
  const [members, setMembers] = useState<string[]>(initial?.members ?? []);
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
          maxParallel,
          members,
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
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          disabled={busy}
        />
      </label>
      <label className="project-form__field">
        <span className="project-form__label">Max parallel wishes</span>
        <input
          type="number"
          min={1}
          max={100}
          value={maxParallel}
          onChange={(e) => setMaxParallel(Number(e.target.value))}
          disabled={busy}
        />
        <span className="project-form__hint">
          How many wishes the scheduler may run for this team simultaneously.
        </span>
      </label>
      <label className="project-form__field">
        <span className="project-form__label">Color (optional)</span>
        <input
          type="color"
          value={color || "#3b82f6"}
          onChange={(e) => setColor(e.target.value)}
          disabled={busy}
        />
      </label>
      <fieldset className="project-form__field">
        <legend className="project-form__label">
          Members (optional — for notifications)
        </legend>
        <div className="planning-members">
          {members.map((uid) => {
            const user = users.find((u) => u.id === uid);
            return (
              <span key={uid} className="planning-members__chip">
                {user?.username ?? uid}
                <button
                  type="button"
                  className="planning-members__remove"
                  onClick={() => setMembers((m) => m.filter((x) => x !== uid))}
                  aria-label="Remove"
                >
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
        <select
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (id && !members.includes(id))
              setMembers((m) => [...m, id]);
            e.currentTarget.value = "";
          }}
          disabled={busy}
        >
          <option value="">Add user…</option>
          {users
            .filter((u) => !members.includes(u.id))
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
                {u.displayName ? ` (${u.displayName})` : ""}
              </option>
            ))}
        </select>
      </fieldset>
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
