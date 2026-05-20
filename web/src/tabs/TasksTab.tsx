import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import ConfirmDialog from "../components/ConfirmDialog";
import HistoryButton from "../components/HistoryButton";
import PageHeader from "../components/PageHeader";

interface Props {
  currentUser: AuthUser;
  initialErrorsOnly?: boolean;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; task: ScheduledTask };

function formatTs(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function StatusBadge({
  status,
  t,
}: {
  status: "ok" | "error" | null;
  t: TFunction;
}) {
  if (!status) {
    return (
      <span className="task-status task-status--idle">
        {t("tab.tasks.statusNeverRun")}
      </span>
    );
  }
  return (
    <span className={`task-status task-status--${status}`}>
      {status === "ok" ? t("tab.tasks.statusOk") : t("tab.tasks.statusError")}
    </span>
  );
}

export default function TasksTab({ currentUser, initialErrorsOnly = false }: Props) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [handlers, setHandlers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [confirmDelete, setConfirmDelete] = useState<ScheduledTask | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(initialErrorsOnly);

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
    const filtered = errorsOnly
      ? (tasks ?? []).filter((task) => task.lastStatus === "error")
      : (tasks ?? []);
    const sys: ScheduledTask[] = [];
    const usr: ScheduledTask[] = [];
    for (const task of filtered) {
      if (task.kind === "system") sys.push(task);
      else usr.push(task);
    }
    return { system: sys, mine: usr };
  }, [tasks, errorsOnly]);

  const canEdit = (task: ScheduledTask): boolean => {
    if (task.kind === "system") return isAdmin;
    if (isAdmin) return true;
    return task.ownerUserId === currentUser.id;
  };

  const handleToggleEnabled = async (task: ScheduledTask) => {
    try {
      await patchScheduledTask(task.id, { enabled: !task.enabled });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRunNow = async (task: ScheduledTask) => {
    try {
      await runScheduledTaskNow(task.id);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = (task: ScheduledTask) => {
    setConfirmDelete(task);
  };

  const doDelete = async (task: ScheduledTask) => {
    setConfirmDelete(null);
    try {
      await deleteScheduledTask(task.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const renderRow = (task: ScheduledTask) => {
    const runLabel = task.lastStatus === "error"
      ? t("tab.tasks.retry")
      : t("tab.tasks.runNow");
    return (
      <tr key={task.id}>
        <td>
          <div className="task-row__name">{task.name}</div>
          {task.description && <div className="task-row__desc">{task.description}</div>}
        </td>
        <td>
          <code>{task.handler}</code>
        </td>
        <td>
          <code>{task.cronExpr}</code>
        </td>
        <td>
          <label className="task-toggle">
            <input
              type="checkbox"
              checked={task.enabled}
              disabled={!canEdit(task)}
              onChange={() => void handleToggleEnabled(task)}
            />
            <span>
              {task.enabled ? t("tab.tasks.toggleOn") : t("tab.tasks.toggleOff")}
            </span>
          </label>
        </td>
        <td>
          <div>{formatTs(task.nextRunAt)}</div>
          <div className="task-row__muted">
            {t("tab.tasks.lastPrefix", { ts: formatTs(task.lastRunAt) })}
          </div>
        </td>
        <td>
          <StatusBadge status={task.lastStatus} t={t} />
          {task.lastError && (
            <div className="task-row__error" title={task.lastError}>
              {task.lastError}
            </div>
          )}
        </td>
        <td className="task-row__actions">
          {canEdit(task) && (
            <>
              <button onClick={() => void handleRunNow(task)} title={runLabel}>
                {runLabel}
              </button>
              <button onClick={() => setDialog({ kind: "edit", task })}>
                {t("tab.tasks.edit")}
              </button>
              <HistoryButton
                kind="scheduled_task"
                entityId={task.id}
                entityName={task.name}
              />
              <button
                onClick={() => void handleDelete(task)}
                className="task-row__danger"
              >
                {t("common.delete")}
              </button>
            </>
          )}
        </td>
      </tr>
    );
  };

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
              <th>{t("tab.tasks.column.name")}</th>
              <th>{t("tab.tasks.column.handler")}</th>
              <th>{t("tab.tasks.column.cron")}</th>
              <th>{t("tab.tasks.column.enabled")}</th>
              <th>{t("tab.tasks.column.schedule")}</th>
              <th>{t("tab.tasks.column.last")}</th>
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
      <PageHeader
        title={t("tab.tasks.title")}
        description={t("tab.tasks.description")}
        actions={
          <button
            className="btn btn--send"
            onClick={() => setDialog({ kind: "create" })}
          >
            {t("tab.tasks.newTask")}
          </button>
        }
      />

      {error && <div className="tasks__error">{error}</div>}

      <div className="tasks__filters">
        <label className="task-toggle">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
          />
          <span>{t("tab.tasks.errorsOnly")}</span>
        </label>
      </div>

      {tasks === null ? (
        <div className="tasks-empty">{t("tab.tasks.loading")}</div>
      ) : (
        <>
          {renderSection(
            t("tab.tasks.section.system"),
            isAdmin
              ? t("tab.tasks.section.systemHintAdmin")
              : t("tab.tasks.section.systemHintUser"),
            system,
            t("tab.tasks.section.systemEmpty"),
          )}
          {renderSection(
            isAdmin
              ? t("tab.tasks.section.userAdmin")
              : t("tab.tasks.section.userMine"),
            isAdmin
              ? t("tab.tasks.section.userHintAdmin")
              : t("tab.tasks.section.userHintUser"),
            mine,
            t("tab.tasks.section.userEmpty"),
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
      <ConfirmDialog
        open={confirmDelete !== null}
        message={t("tab.tasks.deleteConfirm", {
          name: confirmDelete?.name ?? "",
        })}
        confirmLabel={t("common.delete")}
        onConfirm={() => void doDelete(confirmDelete!)}
        onCancel={() => setConfirmDelete(null)}
      />
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
  const { t } = useTranslation();
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
        setErr(t("tab.tasks.dialog.errInvalidPayload"));
        return;
      }
    }
    if (!name.trim()) {
      setErr(t("tab.tasks.dialog.errNameRequired"));
      return;
    }
    if (!cronExpr.trim()) {
      setErr(t("tab.tasks.dialog.errCronRequired"));
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
    <div className="modal-backdrop" role="dialog" aria-modal onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal__header">
          <h2>
            {mode === "create"
              ? t("tab.tasks.dialog.titleCreate")
              : t("tab.tasks.dialog.titleEdit", { name: initial?.name ?? "" })}
          </h2>
          <button
            className="modal__close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            ✕
          </button>
        </header>
        <div className="modal__body">
          <label className="form-row">
            <span>{t("tab.tasks.dialog.kind")}</span>
            <select
              value={kind}
              disabled={kindLocked}
              onChange={(e) => setKind(e.target.value as TaskKind)}
            >
              <option value="user">{t("tab.tasks.dialog.kindUser")}</option>
              {isAdmin && (
                <option value="system">{t("tab.tasks.dialog.kindSystem")}</option>
              )}
            </select>
          </label>
          <label className="form-row">
            <span>{t("tab.tasks.dialog.handler")}</span>
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
            <span>{t("tab.tasks.dialog.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="form-row">
            <span>{t("tab.tasks.dialog.description")}</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="form-row">
            <span>{t("tab.tasks.dialog.cron")}</span>
            <input
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="*/5 * * * *"
            />
          </label>
          <label className="form-row form-row--stack">
            <span>{t("tab.tasks.dialog.payload")}</span>
            <textarea
              rows={4}
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder='{"example":"value"}'
            />
          </label>
          <label className="form-row form-row--inline">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>{t("tab.tasks.dialog.enabled")}</span>
          </label>
          {err && <div className="project-form__error">{err}</div>}
        </div>
        <div className="project-form__actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            className="btn btn--send"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy
              ? t("tab.tasks.dialog.saving")
              : mode === "create"
                ? t("tab.tasks.dialog.create")
                : t("tab.tasks.dialog.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
