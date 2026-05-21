import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { AuthUser } from "../api";
import SubTabs from "../components/SubTabs";

const DefinitionsTab = lazy(() => import("./kb/DefinitionsTab"));

type Sub = "definitions";

type Props = {
  project: string;
  currentUser: AuthUser;
  initialSub?: Sub;
};

// Single sub-tab today, but the segmented-control pattern matches WorkspaceTab
// so adding more sub-tabs (FAQ, glossary, etc.) later is a drop-in.
export default function KnowledgeBaseTab({ project, currentUser, initialSub = "definitions" }: Props) {
  const { t } = useTranslation();
  const sub: Sub = initialSub;

  return (
    <div className="workspace-tab">
      <SubTabs<Sub>
        ariaLabel={t("tab.kb.a11y.sections")}
        current={sub}
        onChange={() => {}}
        items={[{ id: "definitions", label: t("tab.kb.subtab.definitions") }]}
      />
      <Suspense fallback={<div className="app-loading">{t("tab.kb.loading")}</div>}>
        {sub === "definitions" && (
          <DefinitionsTab project={project} currentUser={currentUser} />
        )}
      </Suspense>
    </div>
  );
}
