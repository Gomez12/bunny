import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  createAgent,
  deleteAgent,
  fetchAgents,
  fetchProjects,
  fetchToolNames,
  linkAgentToProject,
  unlinkAgentFromProject,
  updateAgent,
  type Agent,
  type AuthUser,
  type Project,
} from "../api";
import AgentDialog, { type AgentDialogValue } from "../components/AgentDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import HistoryButton from "../components/HistoryButton";
import PageHeader from "../components/PageHeader";

interface Props {
  currentUser: AuthUser;
  activeProject: string;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; agent: Agent };

export default function AgentsTab({ currentUser, activeProject }: Props) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, p, tl] = await Promise.all([
        fetchAgents(),
        fetchProjects(),
        fetchToolNames(),
      ]);
      setAgents(a);
      setProjects(p);
      setTools(tl);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canEdit = (a: Agent) =>
    currentUser.role === "admin" || a.createdBy === currentUser.id;

  const syncLinks = async (agentName: string, before: string[], after: string[]) => {
    const toLink = after.filter((p) => !before.includes(p));
    const toUnlink = before.filter((p) => !after.includes(p));
    await Promise.all([
      ...toLink.map((p) => linkAgentToProject(p, agentName)),
      ...toUnlink.map((p) => unlinkAgentFromProject(p, agentName)),
    ]);
  };

  const handleCreate = async (v: AgentDialogValue) => {
    await createAgent(v);
    await syncLinks(v.name, [], v.linkedProjects);
    await refresh();
  };

  const handleEdit = (target: Agent) => async (v: AgentDialogValue) => {
    await updateAgent(target.name, v);
    await syncLinks(target.name, target.projects, v.linkedProjects);
    await refresh();
  };

  const handleDelete = (name: string) => {
    setConfirmDelete(name);
  };

  const doDelete = async (name: string) => {
    setConfirmDelete(null);
    try {
      await deleteAgent(name);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleLink = async (agent: Agent, projectName: string) => {
    const linked = agent.projects.includes(projectName);
    try {
      if (linked) await unlinkAgentFromProject(projectName, agent.name);
      else await linkAgentToProject(projectName, agent.name);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="projects">
      <PageHeader
        title={t("tab.agents.title")}
        description={
          <Trans
            i18nKey="tab.agents.descriptionFull"
            components={{ code: <code /> }}
          />
        }
      />

      {error && <div className="projects__error">{error}</div>}

      <div className="projects-grid">
        <button
          className="project-card project-card--new"
          onClick={() => setDialog({ kind: "create" })}
        >
          <div className="project-card__plus">+</div>
          <div className="project-card__title">{t("tab.agents.newCardTitle")}</div>
          <div className="project-card__hint">{t("tab.agents.newCardHint")}</div>
        </button>

        {agents === null && (
          <div className="project-card project-card--loading">
            {t("tab.agents.loading")}
          </div>
        )}

        {agents?.map((a) => (
          <div
            key={a.name}
            className={`project-card ${a.projects.includes(activeProject) ? "project-card--active" : ""}`}
          >
            <div className="project-card__body" style={{ cursor: "default" }}>
              <div className="project-card__title">@{a.name}</div>
              {a.description && <div className="project-card__desc">{a.description}</div>}
              <div className="project-card__meta">
                <span className={`project-card__vis project-card__vis--${a.visibility}`}>
                  {a.visibility}
                </span>
                <span className="project-card__vis">
                  {t("tab.agents.scopeLabel", { value: a.contextScope })}
                </span>
                {a.isSubagent && (
                  <span className="project-card__vis">
                    {t("tab.agents.subagentBadge")}
                  </span>
                )}
                {a.knowsOtherAgents && (
                  <span className="project-card__vis">
                    {t("tab.agents.knowsPeers")}
                  </span>
                )}
                {a.tools === null ? (
                  <span className="project-card__vis">{t("tab.agents.allTools")}</span>
                ) : (
                  <span className="project-card__vis">
                    {t("tab.agents.toolsCount", { count: a.tools.length })}
                  </span>
                )}
              </div>
              <div className="project-card__meta" style={{ marginTop: 8, flexWrap: "wrap" }}>
                <span className="project-form__hint" style={{ width: "100%" }}>
                  {t("tab.agents.availableIn")}
                </span>
                {projects.map((p) => (
                  <label
                    key={p.name}
                    className="project-form__chip"
                    title={
                      a.projects.includes(p.name)
                        ? t("tab.agents.unlinkFrom", { name: p.name })
                        : t("tab.agents.linkTo", { name: p.name })
                    }
                  >
                    <input
                      type="checkbox"
                      disabled={!canEdit(a)}
                      checked={a.projects.includes(p.name)}
                      onChange={() => void toggleLink(a, p.name)}
                    />
                    <span>{p.name}</span>
                  </label>
                ))}
              </div>
            </div>
            {canEdit(a) && (
              <div className="project-card__actions">
                <HistoryButton kind="agent" entityId={a.name} entityName={a.name} />
                <button
                  className="project-card__edit"
                  onClick={() => setDialog({ kind: "edit", agent: a })}
                  title={t("common.edit")}
                  aria-label={t("tab.agents.editAria", { name: a.name })}
                >
                  ✎
                </button>
                <button
                  className="project-card__edit"
                  onClick={() => void handleDelete(a.name)}
                  title={t("common.delete")}
                  aria-label={t("tab.agents.deleteAria", { name: a.name })}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {dialog.kind === "create" && (
        <AgentDialog
          mode="create"
          allTools={tools}
          allProjects={projects}
          subagentCandidates={agents ?? []}
          onClose={() => setDialog({ kind: "closed" })}
          onSubmit={handleCreate}
        />
      )}
      {dialog.kind === "edit" && (
        <AgentDialog
          mode="edit"
          initial={dialog.agent}
          allTools={tools}
          allProjects={projects}
          subagentCandidates={agents ?? []}
          onClose={() => setDialog({ kind: "closed" })}
          onSubmit={handleEdit(dialog.agent)}
        />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        message={t("tab.agents.deleteConfirm", { name: confirmDelete ?? "" })}
        confirmLabel={t("common.delete")}
        onConfirm={() => void doDelete(confirmDelete!)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
