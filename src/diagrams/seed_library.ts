import type { SeedNode } from "../memory/diagram_node_library.ts";

const H = ["top", "right", "bottom", "left"];

export const SEEDED_NODES: SeedNode[] = [
  // ── network ─────────────────────────────────────────────────────────────────
  { diagram_type: "network", name: "Router", description: "", shape: "rectangle", icon_name: "Router", color: "#3b82f6", width: 120, height: 60, handle_sides: H },
  { diagram_type: "network", name: "Switch", description: "", shape: "rectangle", icon_name: "Network", color: "#2563eb", width: 120, height: 60, handle_sides: H },
  { diagram_type: "network", name: "Firewall", description: "", shape: "rectangle", icon_name: "Shield", color: "#dc2626", width: 120, height: 60, handle_sides: H },
  { diagram_type: "network", name: "Server", description: "", shape: "rectangle", icon_name: "Server", color: "#374151", width: 120, height: 60, handle_sides: H },
  { diagram_type: "network", name: "Workstation", description: "", shape: "rectangle", icon_name: "Monitor", color: "#6b7280", width: 120, height: 60, handle_sides: H },
  { diagram_type: "network", name: "Database", description: "", shape: "cylinder", icon_name: "Database", color: "#7c3aed", width: 100, height: 70, handle_sides: H },
  { diagram_type: "network", name: "Cloud", description: "", shape: "cloud", icon_name: "Cloud", color: "#0ea5e9", width: 140, height: 80, handle_sides: H },
  { diagram_type: "network", name: "Internet", description: "", shape: "cloud", icon_name: "Globe", color: "#06b6d4", width: 120, height: 80, handle_sides: H },
  { diagram_type: "network", name: "Printer", description: "", shape: "rectangle", icon_name: "Printer", color: "#64748b", width: 120, height: 60, handle_sides: H },
  { diagram_type: "network", name: "Access Point", description: "", shape: "rectangle", icon_name: "Wifi", color: "#10b981", width: 120, height: 60, handle_sides: H },
  { diagram_type: "network", name: "Load Balancer", description: "", shape: "hexagon", icon_name: "Shuffle", color: "#f59e0b", width: 140, height: 60, handle_sides: H },
  { diagram_type: "network", name: "VPN Gateway", description: "", shape: "rectangle", icon_name: "Lock", color: "#8b5cf6", width: 120, height: 60, handle_sides: H },

  // ── flowchart ────────────────────────────────────────────────────────────────
  { diagram_type: "flowchart", name: "Start", description: "Start of a process", shape: "ellipse", icon_name: null, color: "#22c55e", width: 100, height: 60, handle_sides: H },
  { diagram_type: "flowchart", name: "End", description: "End of a process", shape: "ellipse", icon_name: null, color: "#ef4444", width: 100, height: 60, handle_sides: H },
  { diagram_type: "flowchart", name: "Process", description: "", shape: "rectangle", icon_name: null, color: "#3b82f6", width: 160, height: 60, handle_sides: H },
  { diagram_type: "flowchart", name: "Decision", description: "", shape: "diamond", icon_name: null, color: "#f59e0b", width: 140, height: 80, handle_sides: H },
  { diagram_type: "flowchart", name: "Document", description: "", shape: "rectangle", icon_name: "FileText", color: "#64748b", width: 140, height: 60, handle_sides: H },
  { diagram_type: "flowchart", name: "Delay", description: "", shape: "rectangle", icon_name: "Timer", color: "#a855f7", width: 140, height: 60, handle_sides: H },
  { diagram_type: "flowchart", name: "Connector", description: "Off-page connector", shape: "ellipse", icon_name: null, color: "#6b7280", width: 40, height: 40, handle_sides: H },
  { diagram_type: "flowchart", name: "I/O", description: "", shape: "parallelogram", icon_name: null, color: "#0ea5e9", width: 140, height: 60, handle_sides: H },

  // ── orgchart ─────────────────────────────────────────────────────────────────
  { diagram_type: "orgchart", name: "Person", description: "", shape: "rectangle", icon_name: "User", color: "#7c3aed", width: 160, height: 70, handle_sides: H },
  { diagram_type: "orgchart", name: "Role", description: "", shape: "rectangle", icon_name: "Briefcase", color: "#6d28d9", width: 160, height: 60, handle_sides: H },
  { diagram_type: "orgchart", name: "Department", description: "", shape: "rectangle", icon_name: "Building2", color: "#4c1d95", width: 180, height: 60, handle_sides: H },
  { diagram_type: "orgchart", name: "Team", description: "", shape: "rectangle", icon_name: "Users", color: "#8b5cf6", width: 160, height: 60, handle_sides: H },
  { diagram_type: "orgchart", name: "Executive", description: "", shape: "rectangle", icon_name: "Crown", color: "#5b21b6", width: 160, height: 70, handle_sides: H },
  { diagram_type: "orgchart", name: "External Party", description: "", shape: "rectangle", icon_name: "Globe", color: "#a16207", width: 160, height: 60, handle_sides: H },

  // ── architecture ─────────────────────────────────────────────────────────────
  { diagram_type: "architecture", name: "Service", description: "", shape: "rectangle", icon_name: "Cpu", color: "#0d9488", width: 140, height: 60, handle_sides: H },
  { diagram_type: "architecture", name: "API Gateway", description: "", shape: "rectangle", icon_name: "Layers", color: "#0891b2", width: 140, height: 60, handle_sides: H },
  { diagram_type: "architecture", name: "Database", description: "", shape: "cylinder", icon_name: "Database", color: "#7c3aed", width: 100, height: 70, handle_sides: H },
  { diagram_type: "architecture", name: "Cache", description: "", shape: "rectangle", icon_name: "Zap", color: "#f59e0b", width: 120, height: 60, handle_sides: H },
  { diagram_type: "architecture", name: "Queue", description: "", shape: "rectangle", icon_name: "ListOrdered", color: "#ea580c", width: 140, height: 60, handle_sides: H },
  { diagram_type: "architecture", name: "Storage", description: "", shape: "cylinder", icon_name: "HardDrive", color: "#64748b", width: 100, height: 70, handle_sides: H },
  { diagram_type: "architecture", name: "Load Balancer", description: "", shape: "hexagon", icon_name: "Shuffle", color: "#2563eb", width: 140, height: 60, handle_sides: H },
  { diagram_type: "architecture", name: "CDN", description: "", shape: "cloud", icon_name: "Globe", color: "#0ea5e9", width: 140, height: 80, handle_sides: H },
  { diagram_type: "architecture", name: "Browser", description: "", shape: "rectangle", icon_name: "Monitor", color: "#64748b", width: 120, height: 60, handle_sides: H },
  { diagram_type: "architecture", name: "Mobile Client", description: "", shape: "rectangle", icon_name: "Smartphone", color: "#374151", width: 80, height: 80, handle_sides: H },

  // ── er ───────────────────────────────────────────────────────────────────────
  { diagram_type: "er", name: "Entity", description: "", shape: "rectangle", icon_name: "Table", color: "#d97706", width: 180, height: 60, handle_sides: H },
  { diagram_type: "er", name: "Weak Entity", description: "Double-bordered entity", shape: "rectangle", icon_name: "Table", color: "#b45309", width: 180, height: 60, handle_sides: H },
  { diagram_type: "er", name: "Attribute", description: "", shape: "ellipse", icon_name: null, color: "#f59e0b", width: 120, height: 50, handle_sides: H },
  { diagram_type: "er", name: "Derived Attribute", description: "Dashed ellipse attribute", shape: "ellipse", icon_name: null, color: "#fbbf24", width: 120, height: 50, handle_sides: H },
  { diagram_type: "er", name: "Relationship", description: "", shape: "diamond", icon_name: null, color: "#92400e", width: 140, height: 70, handle_sides: H },
  { diagram_type: "er", name: "Weak Relationship", description: "", shape: "diamond", icon_name: null, color: "#78350f", width: 140, height: 70, handle_sides: H },

  // ── sequence ─────────────────────────────────────────────────────────────────
  { diagram_type: "sequence", name: "Actor", description: "", shape: "actor", icon_name: "User", color: "#4f46e5", width: 80, height: 100, handle_sides: H },
  { diagram_type: "sequence", name: "Lifeline", description: "Vertical lifeline bar", shape: "rectangle", icon_name: null, color: "#818cf8", width: 10, height: 200, handle_sides: H },
  { diagram_type: "sequence", name: "Object/System", description: "", shape: "rectangle", icon_name: "Box", color: "#4338ca", width: 140, height: 60, handle_sides: H },
  { diagram_type: "sequence", name: "Message", description: "", shape: "rectangle", icon_name: "ArrowRight", color: "#6366f1", width: 160, height: 40, handle_sides: H },
  { diagram_type: "sequence", name: "Return Message", description: "", shape: "rectangle", icon_name: "ArrowLeft", color: "#a5b4fc", width: 160, height: 40, handle_sides: H },
  { diagram_type: "sequence", name: "Activation Box", description: "", shape: "rectangle", icon_name: null, color: "#c7d2fe", width: 20, height: 80, handle_sides: H },

  // ── mindmap ──────────────────────────────────────────────────────────────────
  { diagram_type: "mindmap", name: "Root", description: "", shape: "ellipse", icon_name: "Brain", color: "#db2777", width: 160, height: 80, handle_sides: H },
  { diagram_type: "mindmap", name: "Branch", description: "", shape: "rectangle", icon_name: null, color: "#ec4899", width: 140, height: 50, handle_sides: H },
  { diagram_type: "mindmap", name: "Leaf", description: "", shape: "rectangle", icon_name: null, color: "#f9a8d4", width: 120, height: 40, handle_sides: H },
  { diagram_type: "mindmap", name: "Note", description: "", shape: "rectangle", icon_name: "StickyNote", color: "#fce7f3", width: 140, height: 60, handle_sides: H },
  { diagram_type: "mindmap", name: "Link Node", description: "", shape: "ellipse", icon_name: "Link", color: "#be185d", width: 80, height: 50, handle_sides: H },

  // ── class ────────────────────────────────────────────────────────────────────
  { diagram_type: "class", name: "Class", description: "", shape: "rectangle", icon_name: "Box", color: "#1e40af", width: 200, height: 100, handle_sides: H },
  { diagram_type: "class", name: "Interface", description: "«interface»", shape: "rectangle", icon_name: "Layers", color: "#1d4ed8", width: 200, height: 80, handle_sides: H },
  { diagram_type: "class", name: "Abstract Class", description: "", shape: "rectangle", icon_name: "Box", color: "#3730a3", width: 200, height: 100, handle_sides: H },
  { diagram_type: "class", name: "Enum", description: "", shape: "rectangle", icon_name: "List", color: "#4338ca", width: 160, height: 80, handle_sides: H },
  { diagram_type: "class", name: "Package", description: "", shape: "rectangle", icon_name: "Package", color: "#374151", width: 200, height: 60, handle_sides: H },

  // ── bpmn ─────────────────────────────────────────────────────────────────────
  { diagram_type: "bpmn", name: "Start Event", description: "", shape: "ellipse", icon_name: null, color: "#16a34a", width: 50, height: 50, handle_sides: H },
  { diagram_type: "bpmn", name: "End Event", description: "", shape: "ellipse", icon_name: null, color: "#dc2626", width: 50, height: 50, handle_sides: H },
  { diagram_type: "bpmn", name: "Task", description: "", shape: "rectangle", icon_name: null, color: "#15803d", width: 160, height: 70, handle_sides: H },
  { diagram_type: "bpmn", name: "XOR Gateway", description: "Exclusive OR decision", shape: "diamond", icon_name: null, color: "#ca8a04", width: 80, height: 80, handle_sides: H },
  { diagram_type: "bpmn", name: "AND Gateway", description: "Parallel fork/join", shape: "diamond", icon_name: null, color: "#d97706", width: 80, height: 80, handle_sides: H },
  { diagram_type: "bpmn", name: "Sub-process", description: "", shape: "rectangle", icon_name: "PlusSquare", color: "#166534", width: 180, height: 80, handle_sides: H },
  { diagram_type: "bpmn", name: "Pool", description: "", shape: "rectangle", icon_name: "Users", color: "#14532d", width: 600, height: 200, handle_sides: H },
  { diagram_type: "bpmn", name: "Lane", description: "", shape: "rectangle", icon_name: null, color: "#86efac", width: 600, height: 100, handle_sides: H },
  { diagram_type: "bpmn", name: "Timer Event", description: "", shape: "ellipse", icon_name: "Timer", color: "#16a34a", width: 50, height: 50, handle_sides: H },
  { diagram_type: "bpmn", name: "Message Event", description: "", shape: "ellipse", icon_name: "Mail", color: "#0369a1", width: 50, height: 50, handle_sides: H },

  // ── custom ───────────────────────────────────────────────────────────────────
  { diagram_type: "custom", name: "Box", description: "", shape: "rectangle", icon_name: null, color: "#374151", width: 140, height: 60, handle_sides: H },
  { diagram_type: "custom", name: "Circle", description: "", shape: "ellipse", icon_name: null, color: "#6b7280", width: 80, height: 80, handle_sides: H },
  { diagram_type: "custom", name: "Diamond", description: "", shape: "diamond", icon_name: null, color: "#9ca3af", width: 100, height: 80, handle_sides: H },
  { diagram_type: "custom", name: "Cylinder", description: "", shape: "cylinder", icon_name: null, color: "#64748b", width: 100, height: 70, handle_sides: H },
  { diagram_type: "custom", name: "Hexagon", description: "", shape: "hexagon", icon_name: null, color: "#475569", width: 120, height: 70, handle_sides: H },
  { diagram_type: "custom", name: "Cloud", description: "", shape: "cloud", icon_name: null, color: "#94a3b8", width: 140, height: 80, handle_sides: H },
  { diagram_type: "custom", name: "Actor", description: "", shape: "actor", icon_name: "User", color: "#374151", width: 60, height: 100, handle_sides: H },
  { diagram_type: "custom", name: "Document", description: "", shape: "rectangle", icon_name: "FileText", color: "#6b7280", width: 140, height: 60, handle_sides: H },
];
