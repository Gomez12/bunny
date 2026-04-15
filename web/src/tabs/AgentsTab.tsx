import { useCallback, useEffect, useState } from "react";
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

interface Props {
  currentUser: AuthUser;
  activeProject: string;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; agent: Agent };

export default function AgentsTab({ currentUser, activeProject }: Props) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const refresh = useCallback(async () => {
    try {
      const [a, p, t] = await Promise.all([fetchAgents(), fetchProjects(), fetchToolNames()]);
      setAgents(a);
      setProjects(p);
      setTools(t);
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

  const handleCreate = async (v: AgentDialogValue) => {
    await createAgent(v);
    await refresh();
  };

  const handleEdit = (target: Agent) => async (v: AgentDialogValue) => {
    await updateAgent(target.name, v);
    await refresh();
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete agent '${name}'? Messages remain; the agent config + links go away.`)) return;
    try {
      await deleteAgent(name);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
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
      <div className="projects__header">
        <h1>Agents</h1>
        <p>
          Named personalities with their own system prompt and tool set. Call an agent in Chat by
          prefixing your message with <code>@name</code>.
        </p>
      </div>

      {error && <div className="projects__error">{error}</div>}

      <div className="projects-grid">
        <button
          className="project-card project-card--new"
          onClick={() => setDialog({ kind: "create" })}
        >
          <div className="project-card__plus">+</div>
          <div className="project-card__title">New agent</div>
          <div className="project-card__hint">Prompt, tools, subagents</div>
        </button>

        {agents === null && <div className="project-card project-card--loading">Loading…</div>}

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
                <span className="project-card__vis">scope: {a.contextScope}</span>
                {a.isSubagent && <span className="project-card__vis">subagent</span>}
                {a.knowsOtherAgents && <span className="project-card__vis">knows peers</span>}
                {a.tools === null ? (
                  <span className="project-card__vis">all tools</span>
                ) : (
                  <span className="project-card__vis">{a.tools.length} tools</span>
                )}
              </div>
              <div className="project-card__meta" style={{ marginTop: 8, flexWrap: "wrap" }}>
                <span className="project-form__hint" style={{ width: "100%" }}>
                  Available in:
                </span>
                {projects.map((p) => (
                  <label
                    key={p.name}
                    className="project-form__chip"
                    title={
                      a.projects.includes(p.name)
                        ? `Unlink from ${p.name}`
                        : `Link to ${p.name}`
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
                <button
                  className="project-card__edit"
                  onClick={() => setDialog({ kind: "edit", agent: a })}
                  title="Edit"
                  aria-label={`Edit ${a.name}`}
                >
                  ✎
                </button>
                <button
                  className="project-card__edit"
                  onClick={() => void handleDelete(a.name)}
                  title="Delete"
                  aria-label={`Delete ${a.name}`}
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
          subagentCandidates={agents ?? []}
          onClose={() => setDialog({ kind: "closed" })}
          onSubmit={handleEdit(dialog.agent)}
        />
      )}
    </div>
  );
}
