import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  listTaskHandlers,
  patchScheduledTask,
  runScheduledTaskNow,
  type AuthUser,
  type ScheduledTask,
  type TaskKind,
} from "../api";

interface Props {
  currentUser: AuthUser;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; task: ScheduledTask };

function formatTs(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function StatusBadge({ status }: { status: "ok" | "error" | null }) {
  if (!status) return <span className="task-status task-status--idle">never run</span>;
  return (
    <span className={`task-status task-status--${status}`}>{status === "ok" ? "ok" : "error"}</span>
  );
}

export default function TasksTab({ currentUser }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [handlers, setHandlers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const isAdmin = currentUser.role === "admin";

  const refresh = useCallback(async () => {
    try {
      const ts = await listScheduledTasks();
      setTasks(ts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void listTaskHandlers()
      .then(setHandlers)
      .catch(() => undefined);
  }, []);

  const { system, mine } = useMemo(() => {
    const sys: ScheduledTask[] = [];
    const usr: ScheduledTask[] = [];
    for (const t of tasks ?? []) {
      if (t.kind === "system") sys.push(t);
      else usr.push(t);
    }
    return { system: sys, mine: usr };
  }, [tasks]);

  const canEdit = (t: ScheduledTask): boolean => {
    if (t.kind === "system") return isAdmin;
    if (isAdmin) return true;
    return t.ownerUserId === currentUser.id;
  };

  const handleToggleEnabled = async (t: ScheduledTask) => {
    try {
      await patchScheduledTask(t.id, { enabled: !t.enabled });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRunNow = async (t: ScheduledTask) => {
    try {
      await runScheduledTaskNow(t.id);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (t: ScheduledTask) => {
    if (!confirm(`Delete task '${t.name}'?`)) return;
    try {
      await deleteScheduledTask(t.id);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const renderRow = (t: ScheduledTask) => (
    <tr key={t.id}>
      <td>
        <div className="task-row__name">{t.name}</div>
        {t.description && <div className="task-row__desc">{t.description}</div>}
      </td>
      <td>
        <code>{t.handler}</code>
      </td>
      <td>
        <code>{t.cronExpr}</code>
      </td>
      <td>
        <label className="task-toggle">
          <input
            type="checkbox"
            checked={t.enabled}
            disabled={!canEdit(t)}
            onChange={() => void handleToggleEnabled(t)}
          />
          <span>{t.enabled ? "on" : "off"}</span>
        </label>
      </td>
      <td>
        <div>{formatTs(t.nextRunAt)}</div>
        <div className="task-row__muted">last: {formatTs(t.lastRunAt)}</div>
      </td>
      <td>
        <StatusBadge status={t.lastStatus} />
        {t.lastError && <div className="task-row__error" title={t.lastError}>{t.lastError}</div>}
      </td>
      <td className="task-row__actions">
        {canEdit(t) && (
          <>
            <button onClick={() => void handleRunNow(t)} title="Run now">Run now</button>
            <button onClick={() => setDialog({ kind: "edit", task: t })}>Edit</button>
            <button onClick={() => void handleDelete(t)} className="task-row__danger">
              Delete
            </button>
          </>
        )}
      </td>
    </tr>
  );

  const renderSection = (
    title: string,
    hint: string,
    rows: ScheduledTask[],
    emptyLabel: string,
  ) => (
    <section className="tasks-section">
      <header className="tasks-section__header">
        <h2>{title}</h2>
        <span className="tasks-section__hint">{hint}</span>
      </header>
      {rows.length === 0 ? (
        <div className="tasks-empty">{emptyLabel}</div>
      ) : (
        <table className="tasks-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Handler</th>
              <th>Cron</th>
              <th>Enabled</th>
              <th>Schedule</th>
              <th>Last</th>
              <th></th>
            </tr>
          </thead>
          <tbody>{rows.map(renderRow)}</tbody>
        </table>
      )}
    </section>
  );

  return (
    <div className="tasks">
      <div className="tasks__header">
        <div>
          <h1>Tasks</h1>
          <p>Periodic background work. System tasks ship with Bunny; you can add your own user tasks.</p>
        </div>
        <button className="tasks__new" onClick={() => setDialog({ kind: "create" })}>
          + New task
        </button>
      </div>

      {error && <div className="tasks__error">{error}</div>}

      {tasks === null ? (
        <div className="tasks-empty">Loading…</div>
      ) : (
        <>
          {renderSection(
            "System tasks",
            isAdmin
              ? "Built-in. Visible to everyone, editable only by admins."
              : "Built-in. Visible to everyone; admins can toggle or edit them.",
            system,
            "No system tasks registered.",
          )}
          {renderSection(
            isAdmin ? "User tasks" : "My tasks",
            isAdmin
              ? "User-created tasks across the install."
              : "Tasks you created. Other users only see their own.",
            mine,
            "No user tasks yet — create one to automate a handler on a cron schedule.",
          )}
        </>
      )}

      {dialog.kind !== "closed" && (
        <TaskDialog
          mode={dialog.kind}
          initial={dialog.kind === "edit" ? dialog.task : null}
          handlers={handlers}
          isAdmin={isAdmin}
          onClose={() => setDialog({ kind: "closed" })}
          onSaved={async () => {
            setDialog({ kind: "closed" });
            await refresh();
          }}
        />
      )}
    </div>
  );
}

interface DialogProps {
  mode: "create" | "edit";
  initial: ScheduledTask | null;
  handlers: string[];
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

function TaskDialog({ mode, initial, handlers, isAdmin, onClose, onSaved }: DialogProps) {
  const [kind, setKind] = useState<TaskKind>(initial?.kind ?? "user");
  const [handler, setHandler] = useState<string>(initial?.handler ?? handlers[0] ?? "");
  const [name, setName] = useState<string>(initial?.name ?? "");
  const [description, setDescription] = useState<string>(initial?.description ?? "");
  const [cronExpr, setCronExpr] = useState<string>(initial?.cronExpr ?? "*/5 * * * *");
  const [payload, setPayload] = useState<string>(
    initial?.payload !== undefined && initial?.payload !== null
      ? JSON.stringify(initial.payload, null, 2)
      : "",
  );
  const [enabled, setEnabled] = useState<boolean>(initial?.enabled ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handlerLocked = mode === "edit";
  const kindLocked = mode === "edit" || !isAdmin;

  const submit = async () => {
    setErr(null);
    let parsedPayload: unknown = undefined;
    if (payload.trim()) {
      try {
        parsedPayload = JSON.parse(payload);
      } catch {
        setErr("Payload must be valid JSON (or empty).");
        return;
      }
    }
    if (!name.trim()) {
      setErr("Name is required.");
      return;
    }
    if (!cronExpr.trim()) {
      setErr("Cron expression is required.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "create") {
        await createScheduledTask({
          kind,
          handler,
          name: name.trim(),
          description: description.trim() || null,
          cronExpr: cronExpr.trim(),
          payload: parsedPayload,
          enabled,
        });
      } else if (initial) {
        await patchScheduledTask(initial.id, {
          name: name.trim(),
          description: description.trim() || null,
          cronExpr: cronExpr.trim(),
          payload: parsedPayload,
          enabled,
        });
      }
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal>
      <div className="modal__card">
        <header className="modal__header">
          <h2>{mode === "create" ? "New task" : `Edit '${initial?.name}'`}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal__body">
          <label className="form-row">
            <span>Kind</span>
            <select
              value={kind}
              disabled={kindLocked}
              onChange={(e) => setKind(e.target.value as TaskKind)}
            >
              <option value="user">user</option>
              {isAdmin && <option value="system">system</option>}
            </select>
          </label>
          <label className="form-row">
            <span>Handler</span>
            <select
              value={handler}
              disabled={handlerLocked}
              onChange={(e) => setHandler(e.target.value)}
            >
              {handlers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
          <label className="form-row">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="form-row">
            <span>Description</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="form-row">
            <span>Cron (minute hour dom month dow)</span>
            <input
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="*/5 * * * *"
            />
          </label>
          <label className="form-row form-row--stack">
            <span>Payload (JSON, optional)</span>
            <textarea
              rows={4}
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder='{"example":"value"}'
            />
          </label>
          <label className="form-row form-row--inline">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Enabled</span>
          </label>
          {err && <div className="modal__error">{err}</div>}
        </div>
        <footer className="modal__footer">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="modal__primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
