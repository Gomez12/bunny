export const DIAGRAM_TYPE_LABELS: Record<string, string> = {
  network: "Network",
  flowchart: "Flowchart",
  orgchart: "Org Chart",
  architecture: "Architecture",
  er: "ER Diagram",
  sequence: "Sequence",
  mindmap: "Mind Map",
  class: "Class Diagram",
  bpmn: "BPMN",
  custom: "Custom",
};

// Shapes that support CSS border-radius (clip-path and transform-based shapes ignore it).
export const RADIUS_SHAPES = ["rectangle", "cylinder", "cloud", "actor"] as const;
