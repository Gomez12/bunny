import { lazy, Suspense, useState } from "react";
import type { AuthUser } from "../api";

const ProjectsTab = lazy(() => import("./ProjectsTab"));
const AgentsTab = lazy(() => import("./AgentsTab"));
const SkillsTab = lazy(() => import("./SkillsTab"));

type Sub = "projects" | "agents" | "skills";

type Props = {
  currentUser: AuthUser;
  activeProject: string;
  onPickProject: (name: string) => void;
  initialSub?: Sub;
};

export default function WorkspaceTab({
  currentUser,
  activeProject,
  onPickProject,
  initialSub = "projects",
}: Props) {
  const [sub, setSub] = useState<Sub>(initialSub);

  return (
    <div className="workspace-tab">
      <nav className="subtabs" aria-label="Workspace sections">
        <button
          type="button"
          className={`subtab ${sub === "projects" ? "subtab--active" : ""}`}
          aria-current={sub === "projects" ? "page" : undefined}
          onClick={() => setSub("projects")}
        >
          Projects
        </button>
        <button
          type="button"
          className={`subtab ${sub === "agents" ? "subtab--active" : ""}`}
          aria-current={sub === "agents" ? "page" : undefined}
          onClick={() => setSub("agents")}
        >
          Agents
        </button>
        <button
          type="button"
          className={`subtab ${sub === "skills" ? "subtab--active" : ""}`}
          aria-current={sub === "skills" ? "page" : undefined}
          onClick={() => setSub("skills")}
        >
          Skills
        </button>
      </nav>
      <Suspense fallback={<div className="app-loading">Loading…</div>}>
        {sub === "projects" && (
          <ProjectsTab
            currentUser={currentUser}
            activeProject={activeProject}
            onPickProject={onPickProject}
          />
        )}
        {sub === "agents" && (
          <AgentsTab currentUser={currentUser} activeProject={activeProject} />
        )}
        {sub === "skills" && (
          <SkillsTab currentUser={currentUser} activeProject={activeProject} />
        )}
      </Suspense>
    </div>
  );
}
