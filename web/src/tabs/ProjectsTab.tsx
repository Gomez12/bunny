import { useCallback, useEffect, useState } from "react";
import {
  createProject,
  deleteProject,
  fetchAgents,
  fetchProjects,
  linkAgentToProject,
  unlinkAgentFromProject,
  updateProject,
  type Agent,
  type AuthUser,
  type Project,
} from "../api";
import ProjectDialog, { type ProjectDialogValue } from "../components/ProjectDialog";

interface Props {
  currentUser: AuthUser;
  activeProject: string;
  onPickProject: (name: string) => void;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; project: Project };

export default function ProjectsTab({ currentUser, activeProject, onPickProject }: Props) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const refresh = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([fetchProjects(), fetchAgents().catch(() => [])]);
      setProjects(p);
      setAgents(a);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canEdit = (p: Project) =>
    currentUser.role === "admin" || p.createdBy === currentUser.id;

  const handleCreate = async (v: ProjectDialogValue) => {
    await createProject({
      name: v.name,
      description: v.description || undefined,
      systemPrompt: v.systemPrompt,
      appendMode: v.appendMode,
      visibility: v.visibility,
      lastN: v.lastN,
      recallK: v.recallK,
      languages: v.languages,
      defaultLanguage: v.defaultLanguage,
    });
    await syncAgentLinks(v.name, [], v.linkedAgents);
    await refresh();
  };

  const handleEdit = async (v: ProjectDialogValue) => {
    await updateProject(v.name, {
      description: v.description,
      systemPrompt: v.systemPrompt,
      appendMode: v.appendMode,
      visibility: v.visibility,
      lastN: v.lastN,
      recallK: v.recallK,
      languages: v.languages,
      defaultLanguage: v.defaultLanguage,
    });
    const before = agents.filter((a) => a.projects.includes(v.name)).map((a) => a.name);
    await syncAgentLinks(v.name, before, v.linkedAgents);
    await refresh();
  };

  const syncAgentLinks = async (project: string, before: string[], after: string[]) => {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const toLink = after.filter((n) => !beforeSet.has(n));
    const toUnlink = before.filter((n) => !afterSet.has(n));
    await Promise.all([
      ...toLink.map((n) => linkAgentToProject(project, n).catch(() => undefined)),
      ...toUnlink.map((n) => unlinkAgentFromProject(project, n).catch(() => undefined)),
    ]);
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete project '${name}'? Messages will remain but the project metadata is removed.`)) return;
    try {
      await deleteProject(name);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="projects">
      <div className="projects__header">
        <h1>Projects</h1>
        <p>Each project has its own on-disk directory and system prompt.</p>
      </div>

      {error && <div className="projects__error">{error}</div>}

      <div className="projects-grid">
        <button
          className="project-card project-card--new"
          onClick={() => setDialog({ kind: "create" })}
        >
          <div className="project-card__plus">+</div>
          <div className="project-card__title">New project</div>
          <div className="project-card__hint">Name, description, system prompt</div>
        </button>

        {projects === null && <div className="project-card project-card--loading">Loading…</div>}

        {projects?.map((p) => (
          <div
            key={p.name}
            className={`project-card ${p.name === activeProject ? "project-card--active" : ""}`}
          >
            <button
              className="project-card__body"
              onClick={() => onPickProject(p.name)}
              title={`Open ${p.name} in Chat`}
            >
              <div className="project-card__title">{p.name}</div>
              {p.description && <div className="project-card__desc">{p.description}</div>}
              <div className="project-card__meta">
                <span className={`project-card__vis project-card__vis--${p.visibility}`}>
                  {p.visibility}
                </span>
                {p.name === activeProject && <span className="project-card__active">active</span>}
              </div>
            </button>
            {canEdit(p) && (
              <div className="project-card__actions">
                <button
                  className="project-card__edit"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDialog({ kind: "edit", project: p });
                  }}
                  title="Edit"
                  aria-label={`Edit ${p.name}`}
                >
                  ✎
                </button>
                {p.name !== "general" && (
                  <button
                    className="project-card__edit"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(p.name);
                    }}
                    title="Delete"
                    aria-label={`Delete ${p.name}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {dialog.kind === "create" && (
        <ProjectDialog
          mode="create"
          allAgents={agents}
          onClose={() => setDialog({ kind: "closed" })}
          onSubmit={handleCreate}
        />
      )}
      {dialog.kind === "edit" && (
        <ProjectDialog
          mode="edit"
          initial={dialog.project}
          allAgents={agents}
          onClose={() => setDialog({ kind: "closed" })}
          onSubmit={handleEdit}
        />
      )}
    </div>
  );
}
