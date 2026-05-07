import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
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

const ICON_MAP: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
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

function DiagramNodeComponent({ data, selected }: DiagramNodeProps) {
  const { label, shape, iconName, color } = data;
  const IconComponent = iconName ? ICON_MAP[iconName] : null;

  return (
    <>
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="target" position={Position.Left} id="left" />
      <div
        className={`dn-node dn-shape--${shape ?? "rectangle"} ${selected ? "dn-node--selected" : ""}`}
        style={{ "--dn-color": color } as React.CSSProperties}
        title={data.description || label}
      >
        {IconComponent && (
          <span className="dn-node__icon">
            <IconComponent size={14} strokeWidth={1.75} />
          </span>
        )}
        <span className="dn-node__label">{label}</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" />
      <Handle type="source" position={Position.Right} id="right" />
    </>
  );
}

export default memo(DiagramNodeComponent);
