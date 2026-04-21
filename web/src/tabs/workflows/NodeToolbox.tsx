import type { NodeKind, ClientWorkflowNode } from "../../lib/workflowParser";
import {
  MessageCircle,
  Terminal,
  RotateCcw,
  User,
  GitBranch,
  Kanban,
  Code,
} from "../../lib/icons";

const ITEMS: Array<{
  kind: NodeKind;
  label: string;
  description: string;
  Icon: (props: { size?: number }) => React.ReactNode;
}> = [
  {
    kind: "prompt",
    label: "Prompt",
    description: "Run one agent turn",
    Icon: ({ size = 16 }) => <MessageCircle size={size} />,
  },
  {
    kind: "bash",
    label: "Bash",
    description: "Run a shell command",
    Icon: ({ size = 16 }) => <Terminal size={size} />,
  },
  {
    kind: "script",
    label: "Script",
    description: "Run JS/TS via bun -e",
    Icon: ({ size = 16 }) => <Code size={size} />,
  },
  {
    kind: "loop",
    label: "Loop",
    description: "Iterate until stop token",
    Icon: ({ size = 16 }) => <RotateCcw size={size} />,
  },
  {
    kind: "for_each",
    label: "For-each",
    description: "Run body per item / count",
    Icon: ({ size = 16 }) => <Kanban size={size} />,
  },
  {
    kind: "if_then_else",
    label: "If / else",
    description: "Branch on a condition",
    Icon: ({ size = 16 }) => <GitBranch size={size} />,
  },
  {
    kind: "interactive",
    label: "Approval",
    description: "Pause for human review",
    Icon: ({ size = 16 }) => <User size={size} />,
  },
];

interface Props {
  /** Click-to-add handler — used as a fallback on touch devices. */
  onAdd: (kind: NodeKind) => void;
  disabled?: boolean;
}

export default function NodeToolbox({ onAdd, disabled }: Props) {
  return (
    <div className="wf-toolbox" role="toolbar" aria-label="Workflow node toolbox">
      <div className="wf-toolbox__head">Add node</div>
      <div className="wf-toolbox__hint">
        Drag onto the canvas, or click to append.
      </div>
      {ITEMS.map((it) => (
        <div
          key={it.kind}
          className={`wf-toolbox__item wf-toolbox__item--${it.kind}`}
          draggable={!disabled}
          onDragStart={(e) => {
            e.dataTransfer.setData("application/bunny-node-kind", it.kind);
            e.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => {
            if (disabled) return;
            onAdd(it.kind);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onAdd(it.kind);
            }
          }}
          title={`Drag to canvas — ${it.description}`}
        >
          <span className="wf-toolbox__icon">
            <it.Icon size={16} />
          </span>
          <span className="wf-toolbox__text">
            <span className="wf-toolbox__label">{it.label}</span>
            <span className="wf-toolbox__desc">{it.description}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Produce a fresh node template for a given kind. The caller picks a
 * unique id (`nextNodeId`) and positions it on the canvas.
 */
export function defaultNodeForKind(
  kind: NodeKind,
  id: string,
): ClientWorkflowNode {
  switch (kind) {
    case "prompt":
      return { id, depends_on: [], kind, prompt: "Describe the task here." };
    case "bash":
      return { id, depends_on: [], kind, bash: "echo hello" };
    case "script":
      return {
        id,
        depends_on: [],
        kind,
        script: "// TypeScript runs via `bun -e`\nconsole.log('hello from script');",
      };
    case "loop":
      return {
        id,
        depends_on: [],
        kind,
        loop: {
          prompt: "Iterate on the task; stop when done.",
          until: "ALL_TASKS_COMPLETE",
          fresh_context: false,
        },
      };
    case "for_each":
      return {
        id,
        depends_on: [],
        kind,
        for_each: {
          count: "{{nodes.some_upstream.output}}",
          body: [],
          item_var: "item",
          index_var: "iteration",
        },
      };
    case "if_then_else":
      return {
        id,
        depends_on: [],
        kind,
        if_then_else: {
          condition: "{{nodes.some_upstream.output}}",
          then_body: [],
          else_body: [],
        },
      };
    case "interactive":
      return { id, depends_on: [], kind, interactive: true };
  }
}

/** Mint a unique slug-style id not already used in the workflow. */
export function nextNodeId(
  existing: ReadonlyArray<{ id: string }>,
  kind: NodeKind,
): string {
  const used = new Set(existing.map((n) => n.id));
  const stem =
    kind === "interactive"
      ? "approve"
      : kind === "for_each"
        ? "foreach"
        : kind === "if_then_else"
          ? "branch"
          : kind;
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? stem : `${stem}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now().toString(36)}`;
}
