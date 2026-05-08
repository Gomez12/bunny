import type { ComponentType } from "react";
import {
  CalendarDays,
  CalendarRange,
  ChevronDown,
  Flag,
  ICON_DEFAULTS,
  Lightbulb,
  ListChecks,
  Tags,
  Target,
  Users,
} from "../lib/icons";
import type { PlanningProject } from "../api";

/**
 * Secondary icon rail for the Planning sub-application. Mirrors `<CodeRail>`
 * — top picker for the active planning project, then a single feature group
 * with the canonical entry points (Roadmap / Wishes / Deadlines / Teams /
 * Tags / Report).
 */
export type PlanningFeatureId =
  | "roadmap"
  | "wishes"
  | "deadlines"
  | "teams"
  | "tags"
  | "report"
  | "calendar";

type IconType = ComponentType<{ size?: number; strokeWidth?: number }>;

type RailItem = {
  id: PlanningFeatureId;
  label: string;
  icon: IconType;
};

type RailGroup = {
  label: string;
  items: RailItem[];
};

const FEATURES: RailGroup[] = [
  {
    label: "Plan",
    items: [
      { id: "roadmap", label: "Roadmap", icon: CalendarRange },
      { id: "wishes", label: "Wishes", icon: Lightbulb },
      { id: "deadlines", label: "Deadlines", icon: Flag },
      { id: "teams", label: "Teams", icon: Users },
      { id: "tags", label: "Tags", icon: Tags },
      { id: "report", label: "Report", icon: ListChecks },
      { id: "calendar", label: "Calendar", icon: CalendarDays },
    ],
  },
];

interface Props {
  activePlanningProject: PlanningProject | null;
  activeFeature: PlanningFeatureId;
  onPickFeature: (id: PlanningFeatureId) => void;
  onOpenPicker: () => void;
}

export default function PlanningRail({
  activePlanningProject,
  activeFeature,
  onPickFeature,
  onOpenPicker,
}: Props) {
  const hasProject = Boolean(activePlanningProject);
  return (
    <nav className="code-rail" aria-label="Planning">
      <button
        type="button"
        className="code-rail__picker"
        onClick={onOpenPicker}
        title="Switch or add planning project"
      >
        <span className="code-rail__picker-icon" aria-hidden="true">
          <Target {...ICON_DEFAULTS} />
        </span>
        <span className="code-rail__picker-labels">
          <span className="code-rail__picker-label">Planning project</span>
          <span className="code-rail__picker-value">
            {activePlanningProject ? activePlanningProject.name : "Pick one"}
          </span>
        </span>
        <span className="code-rail__picker-chevron" aria-hidden="true">
          <ChevronDown size={14} />
        </span>
      </button>

      <div className="code-rail__groups">
        {FEATURES.map((group) => (
          <div className="code-rail__group" key={group.label}>
            <div className="code-rail__group-label">{group.label}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = activeFeature === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`code-rail__item ${isActive ? "code-rail__item--active" : ""}`}
                  aria-current={isActive ? "page" : undefined}
                  disabled={!hasProject}
                  onClick={() => onPickFeature(item.id)}
                  title={
                    hasProject ? item.label : "Pick a planning project first"
                  }
                >
                  <span className="code-rail__item-icon">
                    <Icon {...ICON_DEFAULTS} />
                  </span>
                  <span className="code-rail__item-label">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
