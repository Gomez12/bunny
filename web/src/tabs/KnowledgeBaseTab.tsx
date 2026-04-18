import { lazy, Suspense } from "react";
import type { AuthUser } from "../api";

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
  const sub: Sub = initialSub;

  return (
    <div className="workspace-tab">
      <nav className="subtabs" aria-label="Knowledge Base sections">
        <button
          type="button"
          className={`subtab ${sub === "definitions" ? "subtab--active" : ""}`}
          aria-current={sub === "definitions" ? "page" : undefined}
        >
          Definitions
        </button>
      </nav>
      <Suspense fallback={<div className="app-loading">Loading…</div>}>
        {sub === "definitions" && (
          <DefinitionsTab project={project} currentUser={currentUser} />
        )}
      </Suspense>
    </div>
  );
}
