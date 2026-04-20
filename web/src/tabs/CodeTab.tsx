import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthUser, CodeProject } from "../api";
import {
  createCodeProject,
  deleteCodeProject,
  listCodeProjects,
  patchCodeProject,
} from "../api";
import CodeRail, { type CodeFeatureId } from "../components/CodeRail";
import CodeProjectDialog from "../components/CodeProjectDialog";
import CodeProjectPickerDialog from "../components/CodeProjectPickerDialog";
import CodeShowCodeView from "./code/CodeShowCodeView";
import CodeChatView from "./code/CodeChatView";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";

const CODE_FEATURE_STORAGE_KEY = "bunny.activeCodeFeature";
const CODE_PROJECT_STORAGE_KEY = (bunnyProject: string) =>
  `bunny.activeCodeProject.${bunnyProject}`;

const VALID_FEATURES: CodeFeatureId[] = ["show-code", "chat"];

function resolveStoredFeature(): CodeFeatureId {
  const stored = localStorage.getItem(CODE_FEATURE_STORAGE_KEY);
  if (stored && (VALID_FEATURES as string[]).includes(stored))
    return stored as CodeFeatureId;
  return "show-code";
}

function resolveStoredProjectId(bunnyProject: string): number | null {
  const raw = localStorage.getItem(CODE_PROJECT_STORAGE_KEY(bunnyProject));
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface Props {
  project: string;
  currentUser: AuthUser;
}

/**
 * Code sub-application shell. Owns `activeCodeProjectId` + `activeFeature`
 * state, renders the secondary icon rail (`<CodeRail>`), the picker + edit
 * dialogs, and dispatches to the selected feature view in the main pane.
 */
export default function CodeTab({ project, currentUser }: Props) {
  const [items, setItems] = useState<CodeProject[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeCodeProjectId, setActiveIdRaw] = useState<number | null>(() =>
    resolveStoredProjectId(project),
  );
  const [activeFeature, setActiveFeatureRaw] = useState<CodeFeatureId>(
    resolveStoredFeature,
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CodeProject | null>(null);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<CodeProject | null>(null);

  const setActiveId = useCallback(
    (id: number | null) => {
      if (id == null)
        localStorage.removeItem(CODE_PROJECT_STORAGE_KEY(project));
      else localStorage.setItem(CODE_PROJECT_STORAGE_KEY(project), String(id));
      setActiveIdRaw(id);
    },
    [project],
  );

  const setActiveFeature = useCallback((f: CodeFeatureId) => {
    localStorage.setItem(CODE_FEATURE_STORAGE_KEY, f);
    setActiveFeatureRaw(f);
  }, []);

  const reload = useCallback(async () => {
    try {
      const list = await listCodeProjects(project);
      setItems(list);
      return list;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      return [];
    }
  }, [project]);

  // Reset the active id when the Bunny project switches and load the list.
  useEffect(() => {
    const storedId = resolveStoredProjectId(project);
    setActiveIdRaw(storedId);
    void reload().then((list) => {
      if (list.length === 0) {
        setActiveIdRaw(null);
        return;
      }
      // If the stored id doesn't exist in this project, fall back to the first.
      const target = list.find((cp) => cp.id === storedId) ?? list[0]!;
      setActiveId(target.id);
    });
  }, [project, reload, setActiveId]);

  const activeCodeProject = useMemo(
    () => items.find((cp) => cp.id === activeCodeProjectId) ?? null,
    [items, activeCodeProjectId],
  );

  // Updaters for child views.
  const patchLocal = useCallback((next: CodeProject) => {
    setItems((prev) => prev.map((cp) => (cp.id === next.id ? next : cp)));
  }, []);

  const handleCreate = async (body: {
    name?: string;
    description?: string;
    gitUrl?: string;
    gitRef?: string;
  }) => {
    if (!body.name) throw new Error("name required");
    const created = await createCodeProject(project, {
      name: body.name,
      description: body.description,
      gitUrl: body.gitUrl,
      gitRef: body.gitRef,
    });
    await reload();
    setActiveId(created.id);
    setActiveFeature("show-code");
  };

  const handleEditSubmit = async (body: {
    description?: string;
    gitRef?: string;
  }) => {
    if (!editTarget) return;
    const next = await patchCodeProject(editTarget.id, {
      description: body.description,
      gitRef: body.gitRef ?? null,
    });
    patchLocal(next);
  };

  const handleDelete = (cp: CodeProject) => {
    setConfirmDeleteProject(cp);
  };

  const confirmDelete = async () => {
    const cp = confirmDeleteProject;
    setConfirmDeleteProject(null);
    if (!cp) return;
    try {
      await deleteCodeProject(cp.id);
      const list = await reload();
      if (activeCodeProjectId === cp.id) {
        setActiveId(list[0]?.id ?? null);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  // The caller (`CodeShowCodeView.reload`) already holds the server's
  // authoritative row — no need to refetch.
  const handleProjectTouched = patchLocal;

  const openPicker = () => setPickerOpen(true);
  const openNewDialog = () => {
    setPickerOpen(false);
    setEditTarget(null);
    setDialogOpen(true);
  };

  return (
    <div className="code-shell">
      <CodeRail
        activeCodeProject={activeCodeProject}
        activeFeature={activeFeature}
        onPickFeature={setActiveFeature}
        onOpenPicker={openPicker}
      />
      <div className="code-shell__main">
        {!activeCodeProject && (
          <EmptyState
            title={
              items.length === 0
                ? "No code projects yet"
                : "Pick a code project"
            }
            description={
              items.length === 0
                ? "Create one to hold a repository or a local scratch folder."
                : "Open the picker at the top of the rail to choose one."
            }
            action={
              <button
                type="button"
                className="btn btn--primary"
                onClick={items.length === 0 ? openNewDialog : openPicker}
              >
                {items.length === 0 ? "New code project" : "Pick one"}
              </button>
            }
          />
        )}
        {activeCodeProject && activeFeature === "show-code" && (
          <CodeShowCodeView
            codeProject={activeCodeProject}
            onChanged={handleProjectTouched}
            onEditProject={() => {
              setEditTarget(activeCodeProject);
              setDialogOpen(true);
            }}
            onDeleteProject={() => void handleDelete(activeCodeProject)}
          />
        )}
        {activeCodeProject && activeFeature === "chat" && (
          <CodeChatView
            codeProject={activeCodeProject}
            currentUser={currentUser}
          />
        )}
        {loadError && (
          <div className="project-form__hint project-form__hint--error">
            {loadError}
          </div>
        )}
      </div>

      <CodeProjectPickerDialog
        open={pickerOpen}
        items={items}
        activeId={activeCodeProjectId}
        onClose={() => setPickerOpen(false)}
        onPick={(id) => {
          setActiveId(id);
          setPickerOpen(false);
        }}
        onNew={openNewDialog}
        onEdit={(cp) => {
          setPickerOpen(false);
          setEditTarget(cp);
          setDialogOpen(true);
        }}
        onDelete={(cp) => handleDelete(cp)}
      />

      <CodeProjectDialog
        open={dialogOpen}
        initial={editTarget}
        onClose={() => {
          setDialogOpen(false);
          setEditTarget(null);
        }}
        onSubmit={editTarget ? handleEditSubmit : handleCreate}
      />

      <ConfirmDialog
        open={confirmDeleteProject !== null}
        message={`Move "${confirmDeleteProject?.name}" to the trash? You can restore it from Settings → Trash.`}
        confirmLabel="Move to Trash"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirmDeleteProject(null)}
      />
    </div>
  );
}
