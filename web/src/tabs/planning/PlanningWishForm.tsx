import { useState } from "react";
import {
  type PlanningDeadline,
  type PlanningTag,
  type PlanningTeam,
  type PlanningWish,
  type PlanningWishStatus,
} from "../../api";
import { X } from "../../lib/icons";

export interface PlanningWishFormBody {
  title?: string;
  description?: string;
  durationDays?: number;
  teamId?: number | null;
  deadlineId?: number | null;
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  status?: PlanningWishStatus;
  dependsOnWishes?: number[];
  dependsOnTags?: string[];
  tagIds?: number[];
  jiraKey?: string | null;
}

interface Props {
  initial: PlanningWish | null;
  teams: PlanningTeam[];
  deadlines: PlanningDeadline[];
  tags: PlanningTag[];
  allWishes: PlanningWish[];
  onCancel: () => void;
  onSubmit: (body: PlanningWishFormBody) => Promise<void>;
}

export default function PlanningWishForm({
  initial,
  teams,
  deadlines,
  tags,
  allWishes,
  onCancel,
  onSubmit,
}: Props) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [durationDays, setDurationDays] = useState(initial?.durationDays ?? 1);
  const [teamId, setTeamId] = useState<number | null>(initial?.teamId ?? null);
  const [deadlineId, setDeadlineId] = useState<number | null>(
    initial?.deadlineId ?? null,
  );
  const [tagIds, setTagIds] = useState<number[]>(initial?.tagIds ?? []);
  const [dependsOnWishes, setDependsOnWishes] = useState<number[]>(
    initial?.dependsOnWishes ?? [],
  );
  const [dependsOnTags, setDependsOnTags] = useState<string[]>(
    initial?.dependsOnTags ?? [],
  );
  const [status, setStatus] = useState<PlanningWishStatus>(
    initial?.status ?? "planned",
  );
  const [jiraKey, setJiraKey] = useState(initial?.jiraKey ?? "");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="planning-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onSubmit({
          title: title.trim() || undefined,
          description: description.trim(),
          durationDays,
          teamId,
          deadlineId,
          status,
          dependsOnWishes,
          dependsOnTags,
          tagIds,
          jiraKey: jiraKey.trim() === "" ? null : jiraKey.trim(),
        });
        setBusy(false);
      }}
    >
      <label className="project-form__field">
        <span className="project-form__label">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
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
        <span className="project-form__label">Jira key (optional)</span>
        <input
          value={jiraKey}
          onChange={(e) => setJiraKey(e.target.value)}
          placeholder="e.g. PROJ-123"
          maxLength={64}
          disabled={busy}
        />
        <span className="project-form__hint">
          External tracker reference. Shown as a chip on the wishes list and
          in the Roadmap tooltip.
        </span>
      </label>
      <label className="project-form__field">
        <span className="project-form__label">Duration (working days)</span>
        <input
          type="number"
          min={1}
          max={9999}
          value={durationDays}
          onChange={(e) => setDurationDays(Number(e.target.value))}
          disabled={busy}
        />
      </label>
      <label className="project-form__field">
        <span className="project-form__label">Team</span>
        <select
          value={teamId ?? ""}
          onChange={(e) =>
            setTeamId(e.target.value === "" ? null : Number(e.target.value))
          }
          disabled={busy}
        >
          <option value="">— None —</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="project-form__field">
        <span className="project-form__label">Deadline</span>
        <select
          value={deadlineId ?? ""}
          onChange={(e) =>
            setDeadlineId(e.target.value === "" ? null : Number(e.target.value))
          }
          disabled={busy}
        >
          <option value="">— None —</option>
          {deadlines.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.dueDate})
            </option>
          ))}
        </select>
      </label>
      <fieldset className="project-form__field">
        <legend className="project-form__label">Tags</legend>
        <div className="planning-tags">
          {tags.map((tag) => {
            const checked = tagIds.includes(tag.id);
            return (
              <label
                key={tag.id}
                className={`planning-tags__chip ${checked ? "planning-tags__chip--on" : ""}`}
                style={checked && tag.color ? { background: tag.color } : undefined}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    setTagIds((ids) =>
                      ids.includes(tag.id)
                        ? ids.filter((x) => x !== tag.id)
                        : [...ids, tag.id],
                    );
                  }}
                  disabled={busy}
                />
                {tag.name}
              </label>
            );
          })}
          {tags.length === 0 && (
            <span className="project-form__hint">No tags defined yet.</span>
          )}
        </div>
      </fieldset>
      <fieldset className="project-form__field">
        <legend className="project-form__label">Depends on wishes</legend>
        <div className="planning-members">
          {dependsOnWishes.map((wid) => {
            const w = allWishes.find((x) => x.id === wid);
            return (
              <span key={wid} className="planning-members__chip">
                {w?.title ?? `#${wid}`}
                <button
                  type="button"
                  className="planning-members__remove"
                  onClick={() =>
                    setDependsOnWishes((arr) => arr.filter((x) => x !== wid))
                  }
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
            const id = Number(e.target.value);
            if (id && !dependsOnWishes.includes(id))
              setDependsOnWishes((arr) => [...arr, id]);
            e.currentTarget.value = "";
          }}
          disabled={busy}
        >
          <option value="">Add prerequisite wish…</option>
          {allWishes
            .filter(
              (w) =>
                !dependsOnWishes.includes(w.id) &&
                (!initial || w.id !== initial.id),
            )
            .map((w) => (
              <option key={w.id} value={w.id}>
                {w.title}
              </option>
            ))}
        </select>
      </fieldset>
      <fieldset className="project-form__field">
        <legend className="project-form__label">Depends on tags</legend>
        <span className="project-form__hint">
          Every wish carrying any selected tag must finish before this one.
        </span>
        <div className="planning-tags">
          {tags.map((tag) => {
            const checked = dependsOnTags.includes(tag.name);
            return (
              <label
                key={tag.id}
                className={`planning-tags__chip ${checked ? "planning-tags__chip--on" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    setDependsOnTags((arr) =>
                      arr.includes(tag.name)
                        ? arr.filter((x) => x !== tag.name)
                        : [...arr, tag.name],
                    );
                  }}
                  disabled={busy}
                />
                {tag.name}
              </label>
            );
          })}
        </div>
      </fieldset>
      <label className="project-form__field">
        <span className="project-form__label">Status</span>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as PlanningWishStatus)}
          disabled={busy}
        >
          <option value="planned">Planned</option>
          <option value="in_progress">In progress</option>
          <option value="done">Done</option>
        </select>
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
