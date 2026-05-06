import type { ComponentType } from "react";
import {
  ChevronDown,
  Code,
  MessageCircle,
  History,
  Terminal,
  HardDrive,
  ICON_DEFAULTS,
} from "../lib/icons";
import type { CodeProject, Script } from "../api";

export type ScriptFeatureId = "editor" | "chat" | "versions";

type IconType = ComponentType<{ size?: number; strokeWidth?: number }>;

type RailItem = { id: ScriptFeatureId; label: string; icon: IconType };
type RailGroup = { label: string; items: RailItem[] };

const FEATURES: RailGroup[] = [
  {
    label: "Script",
    items: [
      { id: "editor", label: "Editor", icon: Code },
      { id: "chat", label: "Chat", icon: MessageCircle },
      { id: "versions", label: "Versions", icon: History },
    ],
  },
];

interface Props {
  codeProjects: CodeProject[];
  activeCodeProject: CodeProject | null;
  scripts: Script[];
  tempScripts: Script[];
  activeScript: Script | null;
  activeFeature: ScriptFeatureId;
  showTemp: boolean;
  diskDiffers: boolean;
  onOpenProjectPicker: () => void;
  onPickScript: (id: number) => void;
  onPickFeature: (id: ScriptFeatureId) => void;
  onCreateScript: () => void;
  onCreateTemp: () => void;
  onToggleShowTemp: () => void;
}

export default function ScriptsRail({
  activeCodeProject,
  scripts,
  tempScripts,
  activeScript,
  activeFeature,
  showTemp,
  diskDiffers,
  onOpenProjectPicker,
  onPickScript,
  onPickFeature,
  onCreateScript,
  onCreateTemp,
  onToggleShowTemp,
}: Props) {
  const hasProject = Boolean(activeCodeProject);

  return (
    <nav className="code-rail" aria-label="Scripts">
      {/* Code project picker */}
      <button
        type="button"
        className="code-rail__picker"
        onClick={onOpenProjectPicker}
        title="Switch code project"
      >
        <span className="code-rail__picker-icon" aria-hidden="true">
          <Terminal {...ICON_DEFAULTS} />
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

      {/* Script list */}
      {hasProject && (
        <div className="code-rail__groups">
          <div className="code-rail__group">
            <div
              className="code-rail__group-label"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
            >
              <span>Scripts</span>
              <button
                type="button"
                className="code-rail__action-btn"
                onClick={onCreateScript}
                title="New script"
              >
                +
              </button>
            </div>
            {scripts.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`code-rail__item ${activeScript?.id === s.id ? "code-rail__item--active" : ""}`}
                aria-current={activeScript?.id === s.id ? "page" : undefined}
                onClick={() => onPickScript(s.id)}
                title={s.name}
              >
                <span className="code-rail__item-icon">
                  {diskDiffers && activeScript?.id === s.id ? (
                    <HardDrive {...ICON_DEFAULTS} size={14} />
                  ) : (
                    <Code {...ICON_DEFAULTS} size={14} />
                  )}
                </span>
                <span className="code-rail__item-label">{s.name}</span>
              </button>
            ))}

            {/* Temp scripts section */}
            <div style={{ marginTop: "4px" }}>
              <button
                type="button"
                className="code-rail__action-btn"
                onClick={onToggleShowTemp}
                style={{ fontSize: "10px", opacity: 0.6 }}
                title={showTemp ? "Hide temp scripts" : "Show temp scripts"}
              >
                {showTemp ? "Hide temp" : "Show temp"}
              </button>
              {showTemp &&
                tempScripts.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`code-rail__item ${activeScript?.id === s.id ? "code-rail__item--active" : ""}`}
                    style={{ opacity: 0.6, fontStyle: "italic" }}
                    onClick={() => onPickScript(s.id)}
                    title={`(temp) ${s.name}`}
                  >
                    <span className="code-rail__item-icon">
                      <Code {...ICON_DEFAULTS} size={14} />
                    </span>
                    <span className="code-rail__item-label">{s.name}</span>
                  </button>
                ))}
              <button
                type="button"
                className="code-rail__action-btn"
                onClick={onCreateTemp}
                style={{ fontSize: "10px" }}
                title="New scratch script (temp)"
              >
                + scratch
              </button>
            </div>
          </div>

          {/* Feature buttons */}
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
                    disabled={!activeScript}
                    onClick={() => onPickFeature(item.id)}
                    title={activeScript ? item.label : "Pick a script first"}
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
      )}
    </nav>
  );
}
