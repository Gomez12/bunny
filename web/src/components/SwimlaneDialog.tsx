import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Agent, AuthUser, Swimlane } from "../api";
import { listUsers } from "../api";
import Modal from "./Modal";

const LANE_COLORS = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
] as const;

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
  const { t } = useTranslation();
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
  const [assigneeKind, setAssigneeKind] = useState<"none" | "user" | "agent">(
    initialKind,
  );
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
  const existingGroups = [
    ...new Set(swimlanes.map((s) => s.group).filter(Boolean)),
  ] as string[];

  const submit = async () => {
    if (!name.trim()) {
      setError(t("dialog.swimlane.errNameRequired"));
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
    <Modal onClose={onClose}>
      <form
        className="project-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Modal.Header
          title={
            mode === "create"
              ? t("dialog.swimlane.titleCreate")
              : t("dialog.swimlane.titleEdit")
          }
        />

        <label className="project-form__field">
          <span>{t("dialog.swimlane.nameLabel")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("dialog.swimlane.namePlaceholder")}
            autoFocus
            required
          />
        </label>

        <div className="project-form__field">
          <span>{t("dialog.swimlane.colorLabel")}</span>
          <div className="lane-color-picker">
            <button
              type="button"
              className={`lane-color-swatch lane-color-swatch--none ${color === null ? "lane-color-swatch--active" : ""}`}
              onClick={() => setColor(null)}
              title={t("dialog.swimlane.colorNone")}
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
          <span>{t("dialog.swimlane.groupLabel")}</span>
          <input
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder={t("dialog.swimlane.groupPlaceholder")}
            list="lane-groups"
          />
          <datalist id="lane-groups">
            {existingGroups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <span className="project-form__hint">{t("dialog.swimlane.groupHint")}</span>
        </label>

        <label className="project-form__field project-form__field--inline">
          <input
            type="checkbox"
            checked={autoRun}
            onChange={(e) => setAutoRun(e.target.checked)}
          />
          <span>{t("dialog.swimlane.autoRunLabel")}</span>
        </label>

        <label className="project-form__field">
          <span>{t("dialog.swimlane.wipLabel")}</span>
          <input
            type="number"
            min={0}
            value={wipLimit}
            onChange={(e) => setWipLimit(e.target.value)}
            placeholder={t("dialog.swimlane.wipPlaceholder")}
          />
        </label>

        <div className="project-form__field">
          <span>{t("dialog.swimlane.defaultAssigneeLabel")}</span>
          <div className="card-assignee-tabs">
            {(["none", "user", "agent"] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={`card-assignee-tab ${assigneeKind === k ? "card-assignee-tab--active" : ""}`}
                onClick={() => setAssigneeKind(k)}
              >
                {k === "none"
                  ? t("dialog.swimlane.assigneeNone")
                  : k === "user"
                    ? t("dialog.swimlane.assigneeUser")
                    : t("dialog.swimlane.assigneeAgent")}
              </button>
            ))}
          </div>
        </div>

        {assigneeKind === "user" && (
          <label className="project-form__field">
            <span>{t("dialog.swimlane.userLabel")}</span>
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
            <span>{t("dialog.swimlane.agentLabel")}</span>
            <select
              value={assigneeAgent ?? ""}
              onChange={(e) => setAssigneeAgent(e.target.value || null)}
            >
              <option value="">{t("dialog.swimlane.pickAgent")}</option>
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
            {agents.length === 0 && (
              <span className="project-form__hint">{t("dialog.swimlane.noAgentsHint")}</span>
            )}
          </label>
        )}

        <label className="project-form__field">
          <span>{t("dialog.swimlane.nextLaneLabel")}</span>
          <select
            value={nextSwimlaneId ?? ""}
            onChange={(e) =>
              setNextSwimlaneId(e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">{t("dialog.swimlane.nextLaneNone")}</option>
            {otherLanes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        {error && <div className="project-form__error">{error}</div>}

        <Modal.Footer>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn--send" disabled={busy}>
            {busy
              ? t("common.saving")
              : mode === "create"
                ? t("common.create")
                : t("common.save")}
          </button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
