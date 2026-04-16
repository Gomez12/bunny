import { useEffect, useState } from "react";
import type { Agent, AuthUser, Swimlane } from "../api";
import { listUsers } from "../api";

const LANE_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444"] as const;

export interface SwimlaneDialogValue {
  name: string;
  autoRun: boolean;
  wipLimit: number | null;
  defaultAssigneeUserId: string | null;
  defaultAssigneeAgent: string | null;
  nextSwimlaneId: number | null;
  color: string | null;
  group: string | null;
}

interface Props {
  mode: "create" | "edit";
  swimlanes: Swimlane[];
  agents: Agent[];
  currentUser: AuthUser;
  initial?: Swimlane;
  onClose: () => void;
  onSubmit: (v: SwimlaneDialogValue) => Promise<void>;
}

export default function SwimlaneDialog({
  mode,
  swimlanes,
  agents,
  currentUser,
  initial,
  onClose,
  onSubmit,
}: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [autoRun, setAutoRun] = useState(initial?.autoRun ?? false);
  const [wipLimit, setWipLimit] = useState<string>(
    initial?.wipLimit != null ? String(initial.wipLimit) : "",
  );

  const initialKind: "none" | "user" | "agent" = initial?.defaultAssigneeAgent
    ? "agent"
    : initial?.defaultAssigneeUserId
      ? "user"
      : "none";
  const [assigneeKind, setAssigneeKind] = useState<"none" | "user" | "agent">(initialKind);
  const [assigneeUserId, setAssigneeUserId] = useState<string | null>(
    initial?.defaultAssigneeUserId ?? null,
  );
  const [assigneeAgent, setAssigneeAgent] = useState<string | null>(
    initial?.defaultAssigneeAgent ?? null,
  );
  const [nextSwimlaneId, setNextSwimlaneId] = useState<number | null>(
    initial?.nextSwimlaneId ?? null,
  );
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [group, setGroup] = useState<string>(initial?.group ?? "");

  const [users, setUsers] = useState<AuthUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (assigneeKind !== "user") return;
    if (currentUser.role !== "admin") {
      setUsers([currentUser]);
      if (!assigneeUserId) setAssigneeUserId(currentUser.id);
      return;
    }
    void listUsers()
      .then((u) => {
        setUsers(u);
        if (!assigneeUserId && u.length) setAssigneeUserId(u[0]!.id);
      })
      .catch(() => setUsers([currentUser]));
  }, [assigneeKind, currentUser, assigneeUserId]);

  const otherLanes = swimlanes.filter((s) => !initial || s.id !== initial.id);
  const existingGroups = [...new Set(swimlanes.map((s) => s.group).filter(Boolean))] as string[];

  const submit = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        autoRun,
        wipLimit: wipLimit.trim() ? Number(wipLimit) : null,
        defaultAssigneeUserId: assigneeKind === "user" ? assigneeUserId : null,
        defaultAssigneeAgent: assigneeKind === "agent" ? assigneeAgent : null,
        nextSwimlaneId,
        color,
        group: group.trim() || null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <form
          className="project-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h2>{mode === "create" ? "New swimlane" : "Edit swimlane"}</h2>

          <label className="project-form__field">
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Lane name"
              autoFocus
              required
            />
          </label>

          <div className="project-form__field">
            <span>Color</span>
            <div className="lane-color-picker">
              <button
                type="button"
                className={`lane-color-swatch lane-color-swatch--none ${color === null ? "lane-color-swatch--active" : ""}`}
                onClick={() => setColor(null)}
                title="No color"
              />
              {LANE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`lane-color-swatch ${color === c ? "lane-color-swatch--active" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  title={c}
                />
              ))}
            </div>
          </div>

          <label className="project-form__field">
            <span>Group</span>
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="No group"
              list="lane-groups"
            />
            <datalist id="lane-groups">
              {existingGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <span className="project-form__hint">
              Lanes with the same group are visually grouped together on the board.
            </span>
          </label>

          <label className="project-form__field project-form__field--inline">
            <input
              type="checkbox"
              checked={autoRun}
              onChange={(e) => setAutoRun(e.target.checked)}
            />
            <span>Auto-run — scheduler will auto-run agent cards in this lane</span>
          </label>

          <label className="project-form__field">
            <span>WIP limit</span>
            <input
              type="number"
              min={0}
              value={wipLimit}
              onChange={(e) => setWipLimit(e.target.value)}
              placeholder="No limit"
            />
          </label>

          <div className="project-form__field">
            <span>Default assignee</span>
            <div className="card-assignee-tabs">
              {(["none", "user", "agent"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`card-assignee-tab ${assigneeKind === k ? "card-assignee-tab--active" : ""}`}
                  onClick={() => setAssigneeKind(k)}
                >
                  {k === "none" ? "None" : k === "user" ? "User" : "Agent"}
                </button>
              ))}
            </div>
          </div>

          {assigneeKind === "user" && (
            <label className="project-form__field">
              <span>User</span>
              <select
                value={assigneeUserId ?? ""}
                onChange={(e) => setAssigneeUserId(e.target.value || null)}
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName || u.username}
                  </option>
                ))}
              </select>
            </label>
          )}

          {assigneeKind === "agent" && (
            <label className="project-form__field">
              <span>Agent</span>
              <select
                value={assigneeAgent ?? ""}
                onChange={(e) => setAssigneeAgent(e.target.value || null)}
              >
                <option value="">— pick an agent —</option>
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
              {agents.length === 0 && (
                <span className="project-form__hint">
                  No agents are linked to this project. Link one in the Agents tab first.
                </span>
              )}
            </label>
          )}

          <label className="project-form__field">
            <span>Next swimlane (auto-move after agent run)</span>
            <select
              value={nextSwimlaneId ?? ""}
              onChange={(e) => setNextSwimlaneId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">— none —</option>
              {otherLanes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          {error && <div className="project-form__error">{error}</div>}

          <div className="project-form__actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn--send" disabled={busy}>
              {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
