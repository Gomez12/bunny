import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const [sub, setSub] = useState<Sub>(initialSub);

  return (
    <div className="workspace-tab">
      <SubTabs<Sub>
        ariaLabel={t("tab.workspace.a11y.sections")}
        current={sub}
        onChange={setSub}
        items={[
          { id: "projects", label: t("tab.workspace.subtab.projects") },
          { id: "agents", label: t("tab.workspace.subtab.agents") },
          { id: "skills", label: t("tab.workspace.subtab.skills") },
          { id: "memory", label: t("tab.workspace.subtab.memory") },
          { id: "integrations", label: t("tab.workspace.subtab.integrations") },
        ]}
      />
      <Suspense fallback={<div className="app-loading">{t("tab.workspace.loading")}</div>}>
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
