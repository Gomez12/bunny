import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthUser, PlanningProject } from "../api";
import {
  createPlanningProject,
  deletePlanningProject,
  listPlanningProjects,
  patchPlanningProject,
} from "../api";
import PlanningRail, {
  type PlanningFeatureId,
} from "../components/PlanningRail";
import PlanningProjectDialog from "../components/PlanningProjectDialog";
import PlanningProjectPickerDialog from "../components/PlanningProjectPickerDialog";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { PLANNING_STORAGE } from "../lib/planningStorage";

import PlanningRoadmapView from "./planning/PlanningRoadmapView";
import PlanningWishesView from "./planning/PlanningWishesView";
import PlanningDeadlinesView from "./planning/PlanningDeadlinesView";
import PlanningTeamsView from "./planning/PlanningTeamsView";
import PlanningTagsView from "./planning/PlanningTagsView";
import PlanningReportView from "./planning/PlanningReportView";
import PlanningCalendarView from "./planning/PlanningCalendarView";

const FEATURE_STORAGE_KEY = PLANNING_STORAGE.activeFeature;
const PROJECT_STORAGE_KEY = PLANNING_STORAGE.activeProject;

const VALID_FEATURES: PlanningFeatureId[] = [
  "roadmap",
  "wishes",
  "deadlines",
  "teams",
  "tags",
  "report",
  "calendar",
];

function resolveStoredFeature(): PlanningFeatureId {
  const stored = localStorage.getItem(FEATURE_STORAGE_KEY);
  if (stored && (VALID_FEATURES as string[]).includes(stored))
    return stored as PlanningFeatureId;
  return "roadmap";
}

function resolveStoredProjectId(bunnyProject: string): number | null {
  const raw = localStorage.getItem(PROJECT_STORAGE_KEY(bunnyProject));
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface Props {
  project: string;
  currentUser: AuthUser;
}

export default function PlanningTab({ project, currentUser: _currentUser }: Props) {
  const [items, setItems] = useState<PlanningProject[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveIdRaw] = useState<number | null>(() =>
    resolveStoredProjectId(project),
  );
  const [activeFeature, setActiveFeatureRaw] = useState<PlanningFeatureId>(
    resolveStoredFeature,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<PlanningProject | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PlanningProject | null>(
    null,
  );

  const setActiveId = useCallback(
    (id: number | null) => {
      if (id == null) localStorage.removeItem(PROJECT_STORAGE_KEY(project));
      else localStorage.setItem(PROJECT_STORAGE_KEY(project), String(id));
      setActiveIdRaw(id);
    },
    [project],
  );

  const setActiveFeature = useCallback((f: PlanningFeatureId) => {
    localStorage.setItem(FEATURE_STORAGE_KEY, f);
    setActiveFeatureRaw(f);
  }, []);

  const reload = useCallback(async () => {
    try {
      const list = await listPlanningProjects(project);
      setItems(list);
      return list;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      return [];
    }
  }, [project]);

  useEffect(() => {
    const storedId = resolveStoredProjectId(project);
    setActiveIdRaw(storedId);
    void reload().then((list) => {
      if (list.length === 0) {
        setActiveIdRaw(null);
        return;
      }
      const target = list.find((pp) => pp.id === storedId) ?? list[0]!;
      setActiveId(target.id);
    });
  }, [project, reload, setActiveId]);

  const activePp = useMemo(
    () => items.find((pp) => pp.id === activeId) ?? null,
    [items, activeId],
  );

  const handleCreate = async (body: {
    name?: string;
    description?: string;
    startDate?: string | null;
    sprintDurationDays?: number | null;
  }) => {
    if (!body.name) throw new Error("name required");
    const created = await createPlanningProject(project, {
      name: body.name,
      description: body.description,
      startDate: body.startDate ?? null,
      sprintDurationDays: body.sprintDurationDays ?? null,
    });
    await reload();
    setActiveId(created.id);
    setActiveFeature("roadmap");
  };

  const handleEditSubmit = async (body: {
    description?: string;
    startDate?: string | null;
    sprintDurationDays?: number | null;
  }) => {
    if (!editTarget) return;
    await patchPlanningProject(editTarget.id, {
      description: body.description,
      startDate: body.startDate,
      sprintDurationDays: body.sprintDurationDays,
    });
    await reload();
  };

  const confirmDoDelete = async () => {
    const pp = confirmDelete;
    setConfirmDelete(null);
    if (!pp) return;
    try {
      await deletePlanningProject(pp.id);
      const list = await reload();
      if (activeId === pp.id) setActiveId(list[0]?.id ?? null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  const openPicker = () => setPickerOpen(true);
  const openNewDialog = () => {
    setPickerOpen(false);
    setEditTarget(null);
    setDialogOpen(true);
  };

  return (
    <div className="code-shell">
      <PlanningRail
        activePlanningProject={activePp}
        activeFeature={activeFeature}
        onPickFeature={setActiveFeature}
        onOpenPicker={openPicker}
      />
      <div className="code-shell__main">
        {!activePp && (
          <EmptyState
            title={
              items.length === 0
                ? "No planning projects yet"
                : "Pick a planning project"
            }
            description={
              items.length === 0
                ? "Create one to start grouping deadlines, wishes and teams onto a Gantt roadmap."
                : "Open the picker at the top of the rail to choose one."
            }
            action={
              <button
                type="button"
                className="btn btn--primary"
                onClick={items.length === 0 ? openNewDialog : openPicker}
              >
                {items.length === 0 ? "New planning project" : "Pick one"}
              </button>
            }
          />
        )}
        {activePp && activeFeature === "roadmap" && (
          <PlanningRoadmapView
            planningProject={activePp}
            onEditProject={() => {
              setEditTarget(activePp);
              setDialogOpen(true);
            }}
            onDeleteProject={() => setConfirmDelete(activePp)}
          />
        )}
        {activePp && activeFeature === "wishes" && (
          <PlanningWishesView planningProject={activePp} />
        )}
        {activePp && activeFeature === "deadlines" && (
          <PlanningDeadlinesView planningProject={activePp} />
        )}
        {activePp && activeFeature === "teams" && (
          <PlanningTeamsView planningProject={activePp} />
        )}
        {activePp && activeFeature === "tags" && (
          <PlanningTagsView planningProject={activePp} />
        )}
        {activePp && activeFeature === "report" && (
          <PlanningReportView planningProject={activePp} />
        )}
        {activePp && activeFeature === "calendar" && (
          <PlanningCalendarView planningProject={activePp} />
        )}
        {loadError && (
          <div className="project-form__hint project-form__hint--error">
            {loadError}
          </div>
        )}
      </div>

      <PlanningProjectPickerDialog
        open={pickerOpen}
        items={items}
        activeId={activeId}
        onClose={() => setPickerOpen(false)}
        onPick={(id) => {
          setActiveId(id);
          setPickerOpen(false);
        }}
        onNew={openNewDialog}
        onEdit={(pp) => {
          setPickerOpen(false);
          setEditTarget(pp);
          setDialogOpen(true);
        }}
        onDelete={(pp) => setConfirmDelete(pp)}
      />

      <PlanningProjectDialog
        open={dialogOpen}
        initial={editTarget}
        onClose={() => {
          setDialogOpen(false);
          setEditTarget(null);
        }}
        onSubmit={editTarget ? handleEditSubmit : handleCreate}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        message={`Move "${confirmDelete?.name}" to the trash? You can restore it from Settings → Trash.`}
        confirmLabel="Move to Trash"
        onConfirm={() => void confirmDoDelete()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
