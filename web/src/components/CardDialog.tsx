import { useEffect, useState } from "react";
import type { Agent, AuthUser, BoardCard, Swimlane } from "../api";
import { listUsers, runCard } from "../api";
import CardRunLog from "./CardRunLog";

export interface CardDialogValue {
  swimlaneId: number;
  title: string;
  description: string;
  assigneeKind: "none" | "user" | "agent";
  assigneeUserId: string | null;
  assigneeAgent: string | null;
}

interface Props {
  mode: "create" | "edit";
  swimlanes: Swimlane[];
  agents: Agent[];
  initial?: BoardCard;
  defaultSwimlaneId?: number;
  currentUser: AuthUser;
  onClose: () => void;
  onSubmit: (v: CardDialogValue) => Promise<void>;
  /** Switch to Chat tab focused on a session id (for "Open in Chat"). */
  onOpenSession?: (sessionId: string) => void;
}

export default function CardDialog({
  mode,
  swimlanes,
  agents,
  initial,
  defaultSwimlaneId,
  currentUser,
  onClose,
  onSubmit,
  onOpenSession,
}: Props) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [swimlaneId, setSwimlaneId] = useState<number>(
    initial?.swimlaneId ?? defaultSwimlaneId ?? swimlanes[0]?.id ?? 0,
  );
  const initialKind: "none" | "user" | "agent" = initial?.assigneeAgent
    ? "agent"
    : initial?.assigneeUserId
      ? "user"
      : "none";
  const [assigneeKind, setAssigneeKind] = useState<"none" | "user" | "agent">(initialKind);
  const [assigneeUserId, setAssigneeUserId] = useState<string | null>(initial?.assigneeUserId ?? null);
  const [assigneeAgent, setAssigneeAgent] = useState<string | null>(initial?.assigneeAgent ?? null);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveRunId, setLiveRunId] = useState<number | undefined>(undefined);
  const [runRefreshKey, setRunRefreshKey] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    if (assigneeKind !== "user") return;
    if (currentUser.role !== "admin") {
      // Non-admins can only assign to themselves.
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

  const submit = async () => {
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        swimlaneId,
        title: title.trim(),
        description,
        assigneeKind,
        assigneeUserId: assigneeKind === "user" ? assigneeUserId : null,
        assigneeAgent: assigneeKind === "agent" ? assigneeAgent : null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog__backdrop" onClick={onClose}>
      <div className="dialog dialog--card" onClick={(e) => e.stopPropagation()}>
        <h2>{mode === "create" ? "New card" : `Edit card`}</h2>
        {error && <div className="dialog__error">{error}</div>}

        <label className="dialog__field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>

        <label className="dialog__field">
          <span>Description</span>
          <textarea
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What needs to happen?"
          />
        </label>

        <label className="dialog__field">
          <span>Swimlane</span>
          <select value={swimlaneId} onChange={(e) => setSwimlaneId(Number(e.target.value))}>
            {swimlanes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <div className="dialog__field">
          <span>Assignee</span>
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
          <label className="dialog__field">
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
          <label className="dialog__field">
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
              <small className="dialog__hint">
                No agents are linked to this project. Link one in the Agents tab first.
              </small>
            )}
          </label>
        )}

        <div className="dialog__actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={submit} disabled={busy}>
            {mode === "create" ? "Create" : "Save"}
          </button>
        </div>

        {mode === "edit" && initial && (
          <div className="dialog__runs">
            <div className="dialog__runs-actions">
              <button
                type="button"
                disabled={
                  busy || (assigneeKind !== "agent" && !initial.assigneeAgent) ||
                  (assigneeKind === "agent" && !assigneeAgent)
                }
                onClick={async () => {
                  setRunError(null);
                  try {
                    const agent =
                      assigneeKind === "agent" ? assigneeAgent ?? undefined : undefined;
                    const { run } = await runCard(initial.id, agent ? { agent } : {});
                    setLiveRunId(run.id);
                    setRunRefreshKey((k) => k + 1);
                  } catch (e) {
                    setRunError(e instanceof Error ? e.message : String(e));
                  }
                }}
                title="Run this card with the assigned agent"
              >
                ▶ Run
              </button>
              {runError && <span className="dialog__run-err">{runError}</span>}
            </div>
            <CardRunLog
              cardId={initial.id}
              onOpenSession={(sid) => onOpenSession?.(sid)}
              refreshKey={runRefreshKey}
              liveRunId={liveRunId}
            />
          </div>
        )}
      </div>
    </div>
  );
}
