import { useCallback, useEffect, useState } from "react";
import {
  createSkill,
  deleteSkill,
  fetchProjects,
  fetchSkills,
  installSkill,
  linkSkillToProject,
  unlinkSkillFromProject,
  updateSkill,
  type AuthUser,
  type Project,
  type Skill,
} from "../api";
import SkillDialog, { type SkillDialogValue } from "../components/SkillDialog";

interface Props {
  currentUser: AuthUser;
  activeProject: string;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; skill: Skill }
  | { kind: "install" };

export default function SkillsTab({ currentUser, activeProject }: Props) {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([fetchSkills(), fetchProjects()]);
      setSkills(s);
      setProjects(p);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canEdit = (s: Skill) =>
    currentUser.role === "admin" || s.createdBy === currentUser.id;

  const syncLinks = async (skillName: string, before: string[], after: string[]) => {
    const toLink = after.filter((p) => !before.includes(p));
    const toUnlink = before.filter((p) => !after.includes(p));
    await Promise.all([
      ...toLink.map((p) => linkSkillToProject(p, skillName)),
      ...toUnlink.map((p) => unlinkSkillFromProject(p, skillName)),
    ]);
  };

  const handleCreate = async (v: SkillDialogValue) => {
    await createSkill(v);
    await syncLinks(v.name, [], v.linkedProjects);
    await refresh();
  };

  const handleEdit = (target: Skill) => async (v: SkillDialogValue) => {
    await updateSkill(target.name, v);
    await syncLinks(target.name, target.projects, v.linkedProjects);
    await refresh();
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete skill '${name}'?`)) return;
    try {
      await deleteSkill(name);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleInstall = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = installUrl.trim();
    if (!url) return;
    setInstalling(true);
    setError(null);
    try {
      await installSkill(url);
      setInstallUrl("");
      setDialog({ kind: "closed" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const toggleLink = async (skill: Skill, projectName: string) => {
    const linked = skill.projects.includes(projectName);
    try {
      if (linked) await unlinkSkillFromProject(projectName, skill.name);
      else await linkSkillToProject(projectName, skill.name);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="projects">
      <div className="projects__header">
        <h1>Skills</h1>
        <p>
          Reusable instruction packages that give agents specialized capabilities on demand.
          Skills follow the <a href="https://agentskills.io" target="_blank" rel="noreferrer">agentskills.io</a> open
          standard.
        </p>
      </div>

      {error && <div className="projects__error">{error}</div>}

      <div className="projects-grid">
        <button
          className="project-card project-card--new"
          onClick={() => setDialog({ kind: "create" })}
        >
          <div className="project-card__plus">+</div>
          <div className="project-card__title">New skill</div>
          <div className="project-card__hint">Write a SKILL.md</div>
        </button>

        <button
          className="project-card project-card--new"
          onClick={() => setDialog({ kind: "install" })}
        >
          <div className="project-card__plus">&#8595;</div>
          <div className="project-card__title">Install from URL</div>
          <div className="project-card__hint">GitHub or skills.sh</div>
        </button>

        {skills === null && <div className="project-card project-card--loading">Loading…</div>}

        {skills?.map((s) => (
          <div
            key={s.name}
            className={`project-card ${s.projects.includes(activeProject) ? "project-card--active" : ""}`}
          >
            <div className="project-card__body" style={{ cursor: "default" }}>
              <div className="project-card__title">{s.name}</div>
              {s.description && <div className="project-card__desc">{s.description}</div>}
              <div className="project-card__meta">
                <span className={`project-card__vis project-card__vis--${s.visibility}`}>
                  {s.visibility}
                </span>
                {s.sourceUrl && (
                  <span className="project-card__vis" title={s.sourceUrl}>
                    installed
                  </span>
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
                      s.projects.includes(p.name)
                        ? `Unlink from ${p.name}`
                        : `Link to ${p.name}`
                    }
                  >
                    <input
                      type="checkbox"
                      disabled={!canEdit(s)}
                      checked={s.projects.includes(p.name)}
                      onChange={() => void toggleLink(s, p.name)}
                    />
                    <span>{p.name}</span>
                  </label>
                ))}
              </div>
            </div>
            {canEdit(s) && (
              <div className="project-card__actions">
                <button
                  className="project-card__edit"
                  onClick={() => setDialog({ kind: "edit", skill: s })}
                  title="Edit"
                  aria-label={`Edit ${s.name}`}
                >
                  ✎
                </button>
                <button
                  className="project-card__edit"
                  onClick={() => void handleDelete(s.name)}
                  title="Delete"
                  aria-label={`Delete ${s.name}`}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {dialog.kind === "create" && (
        <SkillDialog
          mode="create"
          allProjects={projects}
          onClose={() => setDialog({ kind: "closed" })}
          onSubmit={handleCreate}
        />
      )}
      {dialog.kind === "edit" && (
        <SkillDialog
          mode="edit"
          initial={dialog.skill}
          allProjects={projects}
          onClose={() => setDialog({ kind: "closed" })}
          onSubmit={handleEdit(dialog.skill)}
        />
      )}
      {dialog.kind === "install" && (
        <div className="modal-backdrop" onClick={() => setDialog({ kind: "closed" })}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={handleInstall} className="project-form">
              <h2>Install skill from URL</h2>
              <label className="project-form__field">
                <span>URL</span>
                <input
                  type="text"
                  value={installUrl}
                  onChange={(e) => setInstallUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo/tree/main/skills/my-skill"
                  autoFocus
                  required
                />
                <span className="project-form__hint">
                  GitHub URL to a skill directory, or a skills.sh identifier (owner/repo/path)
                </span>
              </label>
              <div className="project-form__actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setDialog({ kind: "closed" })}
                  disabled={installing}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn--send" disabled={installing}>
                  {installing ? "Installing…" : "Install"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
