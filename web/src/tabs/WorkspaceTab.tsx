import { lazy, Suspense, useState } from "react";
import type { AuthUser } from "../api";
import SubTabs from "../components/SubTabs";

const ProjectsTab = lazy(() => import("./ProjectsTab"));
const AgentsTab = lazy(() => import("./AgentsTab"));
const SkillsTab = lazy(() => import("./SkillsTab"));
const IntegrationsTab = lazy(() => import("./IntegrationsTab"));
const MemoryPanel = lazy(() => import("./MemoryPanel"));

type Sub = "projects" | "agents" | "skills" | "memory" | "integrations";

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
      <SubTabs<Sub>
        ariaLabel="Workspace sections"
        current={sub}
        onChange={setSub}
        items={[
          { id: "projects", label: "Projects" },
          { id: "agents", label: "Agents" },
          { id: "skills", label: "Skills" },
          { id: "memory", label: "Memory" },
          { id: "integrations", label: "Integrations" },
        ]}
      />
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
        {sub === "memory" && (
          <MemoryPanel
            currentUser={currentUser}
            activeProject={activeProject}
          />
        )}
        {sub === "integrations" && (
          <IntegrationsTab
            currentUser={currentUser}
            activeProject={activeProject}
          />
        )}
      </Suspense>
    </div>
  );
}
