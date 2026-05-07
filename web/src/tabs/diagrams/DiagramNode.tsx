import { memo, useState } from "react";
import { Handle, NodeResizer, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import {
  Router,
  Network,
  Shield,
  Server,
  Monitor,
  Database,
  Cloud,
  Globe,
  Printer,
  Wifi,
  Shuffle,
  Lock,
  Timer,
  FileText,
  User,
  Briefcase,
  Building2,
  Users,
  Crown,
  Cpu,
  Layers,
  Zap,
  ListOrdered,
  HardDrive,
  Smartphone,
  Brain,
  Box,
  List,
  Package,
  Mail,
  StickyNote,
  Table2,
  ArrowRight,
  ArrowLeft,
  Plus,
  GitBranch,
} from "../../lib/icons";
import type { ComponentType } from "react";

export const ICON_MAP: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  Router,
  Network,
  Shield,
  Server,
  Monitor,
  Database,
  Cloud,
  Globe,
  Printer,
  Wifi,
  Shuffle,
  Lock,
  Timer,
  FileText,
  User,
  Briefcase,
  Building2,
  Users,
  Crown,
  Cpu,
  Layers,
  Zap,
  ListOrdered,
  HardDrive,
  Smartphone,
  Brain,
  Box,
  List,
  Package,
  Mail,
  StickyNote,
  Table2,
  ArrowRight,
  ArrowLeft,
  Plus,
  GitBranch,
};

export interface DiagramNodeData {
  label: string;
  shape: string;
  iconName: string | null;
  color: string;
  description?: string;
  libraryItemId?: number | null;
  [key: string]: unknown;
}

type DiagramNodeProps = NodeProps & { data: DiagramNodeData };

// Invisible anchor point used as endpoints for floating arrows/lines.
export function AnchorPointNode({ selected }: NodeProps) {
  return (
    <>
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="target" position={Position.Left} id="left" />
      <div className={`dn-anchor${selected ? " dn-anchor--selected" : ""}`} />
      <Handle type="source" position={Position.Bottom} id="bottom" />
      <Handle type="source" position={Position.Right} id="right" />
    </>
  );
}

function DiagramNodeComponent({ data, selected }: DiagramNodeProps) {
  const { label, shape, iconName, color } = data;
  const IconComponent = iconName ? ICON_MAP[iconName] : null;
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(label);

  const handleDoubleClick = () => {
    setEditValue(label);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    if (editValue.trim() && editValue !== label) {
      // Mutate via xyflow's node data update mechanism — caller uses onNodesChange
      (data as DiagramNodeData & { _onLabelChange?: (v: string) => void })._onLabelChange?.(editValue.trim());
    }
  };

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={60}
        minHeight={30}
        lineStyle={{ border: "1px dashed var(--accent, #7c5cff)", opacity: 0.6 }}
        handleStyle={{
          background: "var(--accent, #7c5cff)",
          border: "none",
          borderRadius: "2px",
          width: 7,
          height: 7,
        }}
      />
      <Handle type="target" position={Position.Top} id="top" className="dn-handle" />
      <Handle type="target" position={Position.Left} id="left" className="dn-handle" />
      <div
        className={`dn-node dn-shape--${shape ?? "rectangle"} ${selected ? "dn-node--selected" : ""}`}
        style={{ "--dn-color": color } as React.CSSProperties}
        title={!editing ? (data.description || label) : undefined}
        onDoubleClick={handleDoubleClick}
      >
        {editing ? (
          <input
            className="dn-node__edit-input"
            value={editValue}
            autoFocus
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            {IconComponent && (
              <span className="dn-node__icon">
                <IconComponent size={14} strokeWidth={1.75} />
              </span>
            )}
            <span className="dn-node__label">{label}</span>
          </>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" className="dn-handle" />
      <Handle type="source" position={Position.Right} id="right" className="dn-handle" />
    </>
  );
}

export default memo(DiagramNodeComponent);
