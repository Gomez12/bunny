import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type PlanningDeadline,
  type PlanningProject,
  type PlanningTag,
  type PlanningTeam,
  type PlanningWish,
  createPlanningWish,
  deletePlanningWish,
  listPlanningDeadlines,
  listPlanningTags,
  listPlanningTeams,
  listPlanningWishes,
  patchPlanningWish,
} from "../../api";
import { Pencil, Plus, Trash2 } from "../../lib/icons";
import ConfirmDialog from "../../components/ConfirmDialog";
import EmptyState from "../../components/EmptyState";
import Modal from "../../components/Modal";
import PlanningWishForm from "./PlanningWishForm";

interface Props {
  planningProject: PlanningProject;
}

export default function PlanningWishesView({ planningProject }: Props) {
  const [wishes, setWishes] = useState<PlanningWish[]>([]);
  const [teams, setTeams] = useState<PlanningTeam[]>([]);
  const [deadlines, setDeadlines] = useState<PlanningDeadline[]>([]);
  const [tags, setTags] = useState<PlanningTag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlanningWish | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<PlanningWish | null>(null);

  const reload = useCallback(async () => {
    try {
      const [w, t, d, g] = await Promise.all([
        listPlanningWishes(planningProject.id),
        listPlanningTeams(planningProject.id),
        listPlanningDeadlines(planningProject.id),
        listPlanningTags(planningProject.id),
      ]);
      setWishes(w);
      setTeams(t);
      setDeadlines(d);
      setTags(g);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [planningProject.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const teamById = useMemo(() => {
    const m = new Map<number, PlanningTeam>();
    for (const t of teams) m.set(t.id, t);
    return m;
  }, [teams]);
  const deadlineById = useMemo(() => {
    const m = new Map<number, PlanningDeadline>();
    for (const d of deadlines) m.set(d.id, d);
    return m;
  }, [deadlines]);
  const tagById = useMemo(() => {
    const m = new Map<number, PlanningTag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  return (
    <div className="planning-view">
      <header className="planning-view__header">
        <h2>Wishes</h2>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setCreating(true)}
        >
          <Plus size={14} /> New wish
        </button>
      </header>
      {error && <div className="planning-tab__error">{error}</div>}
      {wishes.length === 0 ? (
        <EmptyState
          title="No wishes yet"
          description="Add a wish to start building the roadmap. Each wish carries a duration, an optional team, deadline, and dependencies."
          action={
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setCreating(true)}
            >
              <Plus size={14} /> New wish
            </button>
          }
        />
      ) : (
        <ul className="planning-card-list">
          {wishes.map((w) => {
            const team = w.teamId !== null ? teamById.get(w.teamId) : null;
            const deadline =
              w.deadlineId !== null ? deadlineById.get(w.deadlineId) : null;
            return (
              <li key={w.id}>
                <article className="planning-card">
                  <div className="planning-card__head">
                    <span className="planning-card__name">{w.title}</span>
                    {w.jiraKey && (
                      <span
                        className="kb-chip kb-chip--jira"
                        title={`External tracker: ${w.jiraKey}`}
                      >
                        {w.jiraKey}
                      </span>
                    )}
                    <span className="planning-card__meta">
                      {w.durationDays}d
                    </span>
                    {team && (
                      <span
                        className="kb-chip"
                        style={
                          team.color
                            ? { borderColor: team.color, color: team.color }
                            : undefined
                        }
                      >
                        {team.name}
                      </span>
                    )}
                    {deadline && (
                      <span className="kb-chip kb-chip--deadline">
                        {deadline.name} · {deadline.dueDate}
                      </span>
                    )}
                    {w.plannedStartDate && (
                      <span className="planning-card__date">
                        {w.plannedStartDate} → {w.plannedEndDate}
                      </span>
                    )}
                  </div>
                  {w.tagIds.length > 0 && (
                    <div className="planning-card__chips">
                      {w.tagIds.map((tid) => {
                        const tag = tagById.get(tid);
                        if (!tag) return null;
                        return (
                          <span
                            key={tid}
                            className="kb-chip"
                            style={
                              tag.color
                                ? {
                                    borderColor: tag.color,
                                    color: tag.color,
                                  }
                                : undefined
                            }
                          >
                            {tag.name}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {w.description && (
                    <p className="planning-card__desc">{w.description}</p>
                  )}
                  <div className="planning-card__actions">
                    <button
                      type="button"
                      className="planning-card__action-btn"
                      onClick={() => setEditing(w)}
                      aria-label="Edit"
                      title="Edit"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="planning-card__action-btn"
                      onClick={() => setConfirmDelete(w)}
                      aria-label="Delete"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Move wish to trash"
        message={
          confirmDelete
            ? `Move wish "${confirmDelete.title}" to the trash?`
            : ""
        }
        confirmLabel="Move to trash"
        onConfirm={async () => {
          const target = confirmDelete;
          setConfirmDelete(null);
          if (!target) return;
          try {
            await deletePlanningWish(target.id);
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
            title={editing ? `Edit wish "${editing.title}"` : "New wish"}
          />
          <PlanningWishForm
            initial={editing}
            teams={teams}
            deadlines={deadlines}
            tags={tags}
            allWishes={wishes}
            onCancel={() => {
              setCreating(false);
              setEditing(null);
            }}
            onSubmit={async (body) => {
            try {
              if (editing) await patchPlanningWish(editing.id, body);
              else
                await createPlanningWish(planningProject.id, {
                  title: body.title ?? "",
                  description: body.description,
                  durationDays: body.durationDays,
                  teamId: body.teamId,
                  deadlineId: body.deadlineId,
                  plannedStartDate: body.plannedStartDate,
                  plannedEndDate: body.plannedEndDate,
                  status: body.status,
                  dependsOnWishes: body.dependsOnWishes,
                  dependsOnTags: body.dependsOnTags,
                  tagIds: body.tagIds,
                  jiraKey: body.jiraKey,
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
