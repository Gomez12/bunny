import type { ComponentType } from "react";
import {
  ChevronDown,
  Code,
  FolderGit2,
  ICON_DEFAULTS,
  MessageCircle,
  Network,
} from "../lib/icons";
import type { CodeProject } from "../api";

/**
 * Secondary icon rail for the Code sub-application.
 *
 * Top: code-project picker (shows the active project, click opens a modal to
 * switch / add). Below: per-project feature buttons (Show Code, Chat today;
 * future buttons like Code Review slot in as one entry).
 *
 * Mirrors the primary nav's 56 → 240 hover-expand geometry so the UX feels
 * continuous, and reuses the same `NavGroup[]` shape so future groups (e.g.
 * "Quality" for reviews / linting) land without shell changes.
 */
export type CodeFeatureId = "show-code" | "chat" | "graph";

type IconType = ComponentType<{ size?: number; strokeWidth?: number }>;

type RailItem = {
  id: CodeFeatureId;
  label: string;
  icon: IconType;
};

type RailGroup = {
  label: string;
  items: RailItem[];
};

const FEATURES: RailGroup[] = [
  {
    label: "Workspace",
    items: [
      { id: "show-code", label: "Show Code", icon: FolderGit2 },
      { id: "chat", label: "Chat", icon: MessageCircle },
      { id: "graph", label: "Graph", icon: Network },
    ],
  },
];

interface Props {
  activeCodeProject: CodeProject | null;
  activeFeature: CodeFeatureId;
  onPickFeature: (id: CodeFeatureId) => void;
  onOpenPicker: () => void;
}

export default function CodeRail({
  activeCodeProject,
  activeFeature,
  onPickFeature,
  onOpenPicker,
}: Props) {
  const hasProject = Boolean(activeCodeProject);
  return (
    <nav className="code-rail" aria-label="Code">
      <button
        type="button"
        className="code-rail__picker"
        onClick={onOpenPicker}
        title="Switch or add code project"
      >
        <span className="code-rail__picker-icon" aria-hidden="true">
          <Code {...ICON_DEFAULTS} />
        </span>
        <span className="code-rail__picker-labels">
          <span className="code-rail__picker-label">Code project</span>
          <span className="code-rail__picker-value">
            {activeCodeProject ? activeCodeProject.name : "Pick one"}
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
                    hasProject ? item.label : "Pick a code project first"
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
