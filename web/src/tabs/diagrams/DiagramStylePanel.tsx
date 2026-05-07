import { useEffect, useRef } from "react";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { X } from "../../lib/icons";

const PALETTE = [
  "#ffffff", "#f3f4f6", "#9ca3af", "#6b7280", "#374151", "#111827",
  "#eff6ff", "#93c5fd", "#3b82f6", "#2563eb", "#1d4ed8", "#0ea5e9",
  "#f0fdf4", "#86efac", "#22c55e", "#16a34a", "#fef3c7", "#f59e0b",
  "#fef2f2", "#fca5a5", "#ef4444", "#7c3aed", "#ec4899", "#f97316",
];

const SHAPES_SUPPORTING_RADIUS = ["rectangle", "cylinder", "cloud", "actor"];

interface Props {
  x: number;
  y: number;
  targetType: "node" | "edge";
  nodeId?: string;
  edgeId?: string;
  nodes: Node[];
  edges: Edge[];
  onNodesChange: (nodes: Node[]) => void;
  onEdgesChange: (edges: Edge[]) => void;
  onDuplicate?: () => void;
  onDelete: () => void;
  onEditLabel?: () => void;
  onClose: () => void;
}

function ColorPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
}) {
  return (
    <div className="dn-style-panel__section">
      <div className="dn-style-panel__label">{label}</div>
      <div className="dn-style-panel__colors">
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            className={`dn-style-panel__swatch${value === c ? " dn-style-panel__swatch--active" : ""}`}
            style={{ background: c, borderColor: c === "#ffffff" ? "#e5e7eb" : c }}
            onClick={() => onChange(c)}
            title={c}
          />
        ))}
        <input
          type="color"
          className="dn-style-panel__custom-color"
          value={value ?? "#6b7280"}
          onChange={(e) => onChange(e.target.value)}
          title="Custom color"
        />
      </div>
    </div>
  );
}

export default function DiagramStylePanel({
  x, y, targetType, nodeId, edgeId,
  nodes, edges,
  onNodesChange, onEdgesChange,
  onDuplicate, onDelete, onEditLabel, onClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Clamp position to viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pw = 248;
  const ph = 520; // estimated
  const left = Math.min(x, vw - pw - 8);
  const top = Math.min(y, vh - ph - 8);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    function onOutsideClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as globalThis.Node)) {
        onClose();
      }
    }
    // Delay so the right-click that opened us doesn't immediately close it
    const t = setTimeout(() => document.addEventListener("mousedown", onOutsideClick), 50);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onOutsideClick);
    };
  }, [onClose]);

  if (targetType === "node") {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const data = node.data as Record<string, unknown>;
    const shape = String(data.shape ?? "rectangle");

    function patchData(patch: Record<string, unknown>) {
      onNodesChange(
        nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n,
        ),
      );
    }

    const fillColor = data.fillColor as string | undefined;
    const strokeColor = data.strokeColor as string | undefined;
    const borderWidth = data.borderWidth as number | undefined;
    const borderStyle = data.borderStyle as string | undefined;
    const cornerRadius = data.cornerRadius as number | undefined;
    const textColor = data.textColor as string | undefined;
    const fontSize = data.fontSize as number | undefined;
    const fontWeight = data.fontWeight as string | undefined;
    const fontStyle = data.fontStyle as string | undefined;
    const textAlign = data.textAlign as string | undefined;
    const opacity = data.opacity as number | undefined;

    return (
      <div
        ref={panelRef}
        className="dn-style-panel"
        style={{ left, top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className="dn-style-panel__close" onClick={onClose} type="button" aria-label="Close">
          <X size={12} />
        </button>

        <ColorPicker label="Fill" value={fillColor} onChange={(v) => patchData({ fillColor: v })} />

        <div className="dn-style-panel__section">
          <ColorPicker label="Border color" value={strokeColor} onChange={(v) => patchData({ strokeColor: v })} />
          <div className="dn-style-panel__label" style={{ marginTop: 6 }}>Border width</div>
          <div className="dn-style-panel__row">
            {[1, 2, 3, 4, 6].map((w) => (
              <button
                key={w}
                type="button"
                className={`dn-style-panel__btn${borderWidth === w ? " dn-style-panel__btn--active" : ""}`}
                onClick={() => patchData({ borderWidth: w })}
              >
                {w}
              </button>
            ))}
          </div>
          <div className="dn-style-panel__label" style={{ marginTop: 6 }}>Border style</div>
          <div className="dn-style-panel__row">
            {([["solid", "—"], ["dashed", "╌"], ["dotted", "···"]] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                className={`dn-style-panel__btn${(borderStyle ?? "solid") === val ? " dn-style-panel__btn--active" : ""}`}
                onClick={() => patchData({ borderStyle: val })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {SHAPES_SUPPORTING_RADIUS.includes(shape) && (
          <div className="dn-style-panel__section">
            <div className="dn-style-panel__label">Corner radius</div>
            <div className="dn-style-panel__slider-row">
              <input
                type="range"
                className="dn-style-panel__slider"
                min={0} max={24} step={2}
                value={cornerRadius ?? 6}
                onChange={(e) => patchData({ cornerRadius: Number(e.target.value) })}
              />
              <span className="dn-style-panel__slider-val">{cornerRadius ?? 6}px</span>
            </div>
          </div>
        )}

        <div className="dn-style-panel__section">
          <ColorPicker label="Text color" value={textColor} onChange={(v) => patchData({ textColor: v })} />
          <div className="dn-style-panel__label" style={{ marginTop: 6 }}>Font size</div>
          <div className="dn-style-panel__row">
            {[10, 12, 14, 16, 18, 20].map((s) => (
              <button
                key={s}
                type="button"
                className={`dn-style-panel__btn${(fontSize ?? 11) === s ? " dn-style-panel__btn--active" : ""}`}
                onClick={() => patchData({ fontSize: s })}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="dn-style-panel__row" style={{ marginTop: 6 }}>
            <button
              type="button"
              className={`dn-style-panel__btn${fontWeight === "bold" ? " dn-style-panel__btn--active" : ""}`}
              style={{ fontWeight: "bold" }}
              onClick={() => patchData({ fontWeight: fontWeight === "bold" ? "normal" : "bold" })}
            >B</button>
            <button
              type="button"
              className={`dn-style-panel__btn${fontStyle === "italic" ? " dn-style-panel__btn--active" : ""}`}
              style={{ fontStyle: "italic" }}
              onClick={() => patchData({ fontStyle: fontStyle === "italic" ? "normal" : "italic" })}
            >I</button>
            <div className="dn-style-panel__sep-v" />
            {(["left", "center", "right"] as const).map((align) => (
              <button
                key={align}
                type="button"
                className={`dn-style-panel__btn${(textAlign ?? "center") === align ? " dn-style-panel__btn--active" : ""}`}
                onClick={() => patchData({ textAlign: align })}
              >
                {align === "left" ? "←" : align === "center" ? "=" : "→"}
              </button>
            ))}
          </div>
        </div>

        <div className="dn-style-panel__section">
          <div className="dn-style-panel__label">Opacity — {Math.round((opacity ?? 1) * 100)}%</div>
          <div className="dn-style-panel__slider-row">
            <input
              type="range"
              className="dn-style-panel__slider"
              min={10} max={100} step={10}
              value={Math.round((opacity ?? 1) * 100)}
              onChange={(e) => patchData({ opacity: Number(e.target.value) / 100 })}
            />
          </div>
        </div>

        <div className="dn-style-panel__actions">
          {onDuplicate && (
            <button type="button" className="dn-style-panel__action" onClick={() => { onDuplicate(); onClose(); }}>
              Duplicate
            </button>
          )}
          <button type="button" className="dn-style-panel__action dn-style-panel__action--danger" onClick={() => { onDelete(); onClose(); }}>
            Delete
          </button>
        </div>
      </div>
    );
  }

  // Edge mode
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) return null;

  function patchEdge(patch: Partial<Edge>) {
    onEdgesChange(
      edges.map((e) => (e.id === edgeId ? { ...e, ...patch } : e)),
    );
  }

  function patchEdgeStyle(stylePatch: React.CSSProperties) {
    onEdgesChange(
      edges.map((e) =>
        e.id === edgeId ? { ...e, style: { ...e.style, ...stylePatch } } : e,
      ),
    );
  }

  function patchLabelStyle(patch: Record<string, unknown>) {
    onEdgesChange(
      edges.map((e) =>
        e.id === edgeId
          ? { ...e, labelStyle: { ...(e.labelStyle as object ?? {}), ...patch } }
          : e,
      ),
    );
  }

  const strokeColor = (edge.style?.stroke as string) ?? "#9ca3af";
  const strokeWidth = (edge.style?.strokeWidth as number) ?? 1;
  const dashArray = (edge.style?.strokeDasharray as string) ?? "";
  const hasEndArrow = !!edge.markerEnd;
  const hasStartArrow = !!edge.markerStart;
  const labelStyle = (edge.labelStyle ?? {}) as Record<string, unknown>;
  const labelColor = labelStyle.fill as string | undefined;
  const labelSize = labelStyle.fontSize as number | undefined;
  const labelWeight = labelStyle.fontWeight as string | undefined;
  const labelItalic = labelStyle.fontStyle as string | undefined;

  const DASH_OPTIONS: Array<[string, string, string]> = [
    ["", "—", "Solid"],
    ["6 4", "╌", "Dashed"],
    ["2 4", "···", "Dotted"],
    ["12 4", "- -", "Long dash"],
  ];

  const EDGE_TYPES: Array<[string, string]> = [
    ["default", "Curved"],
    ["straight", "Straight"],
    ["step", "Step"],
    ["smoothstep", "Smooth"],
  ];

  return (
    <div
      ref={panelRef}
      className="dn-style-panel"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button className="dn-style-panel__close" onClick={onClose} type="button" aria-label="Close">
        <X size={12} />
      </button>

      <ColorPicker
        label="Line color"
        value={strokeColor}
        onChange={(v) => patchEdgeStyle({ stroke: v })}
      />

      <div className="dn-style-panel__section">
        <div className="dn-style-panel__label">Line width</div>
        <div className="dn-style-panel__row">
          {[1, 2, 3, 4, 6].map((w) => (
            <button
              key={w}
              type="button"
              className={`dn-style-panel__btn${strokeWidth === w ? " dn-style-panel__btn--active" : ""}`}
              onClick={() => patchEdgeStyle({ strokeWidth: w })}
            >
              {w}
            </button>
          ))}
        </div>
        <div className="dn-style-panel__label" style={{ marginTop: 6 }}>Line style</div>
        <div className="dn-style-panel__row">
          {DASH_OPTIONS.map(([val, icon, title]) => (
            <button
              key={val || "solid"}
              type="button"
              className={`dn-style-panel__btn${dashArray === val ? " dn-style-panel__btn--active" : ""}`}
              onClick={() => patchEdgeStyle({ strokeDasharray: val || undefined })}
              title={title}
            >
              {icon}
            </button>
          ))}
        </div>
      </div>

      <div className="dn-style-panel__section">
        <div className="dn-style-panel__label">Arrows</div>
        <div className="dn-style-panel__row">
          {([
            ["→ End", () => patchEdge({ markerEnd: { type: MarkerType.ArrowClosed }, markerStart: undefined })],
            ["← Start", () => patchEdge({ markerStart: { type: MarkerType.ArrowClosed }, markerEnd: undefined })],
            ["↔ Both", () => patchEdge({ markerEnd: { type: MarkerType.ArrowClosed }, markerStart: { type: MarkerType.ArrowClosed } })],
            ["— None", () => patchEdge({ markerEnd: undefined, markerStart: undefined })],
          ] as Array<[string, () => void]>).map(([label, action]) => (
            <button
              key={label}
              type="button"
              className="dn-style-panel__btn"
              onClick={action}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="dn-style-panel__label" style={{ marginTop: 6 }}>Arrow style</div>
        <div className="dn-style-panel__row">
          {([
            ["Open", () => {
              if (hasEndArrow) patchEdge({ markerEnd: { type: MarkerType.Arrow } });
              if (hasStartArrow) patchEdge({ markerStart: { type: MarkerType.Arrow } });
            }],
            ["Closed", () => {
              if (hasEndArrow) patchEdge({ markerEnd: { type: MarkerType.ArrowClosed } });
              if (hasStartArrow) patchEdge({ markerStart: { type: MarkerType.ArrowClosed } });
            }],
          ] as Array<[string, () => void]>).map(([label, action]) => (
            <button key={label} type="button" className="dn-style-panel__btn" onClick={action}>{label}</button>
          ))}
        </div>
        <div className="dn-style-panel__label" style={{ marginTop: 6 }}>Edge type</div>
        <div className="dn-style-panel__row">
          {EDGE_TYPES.map(([val, label]) => (
            <button
              key={val}
              type="button"
              className={`dn-style-panel__btn${(edge.type ?? "default") === val ? " dn-style-panel__btn--active" : ""}`}
              onClick={() => patchEdge({ type: val })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="dn-style-panel__section">
        <label className="dn-style-panel__checkbox-row">
          <input
            type="checkbox"
            checked={!!edge.animated}
            onChange={(e) => patchEdge({ animated: e.target.checked })}
          />
          <span className="dn-style-panel__label" style={{ margin: 0 }}>Animated flow</span>
        </label>
      </div>

      <div className="dn-style-panel__section">
        <ColorPicker
          label="Label color"
          value={labelColor}
          onChange={(v) => patchLabelStyle({ fill: v })}
        />
        <div className="dn-style-panel__label" style={{ marginTop: 6 }}>Label size</div>
        <div className="dn-style-panel__row">
          {[10, 12, 14, 16, 18].map((s) => (
            <button
              key={s}
              type="button"
              className={`dn-style-panel__btn${(labelSize ?? 12) === s ? " dn-style-panel__btn--active" : ""}`}
              onClick={() => patchLabelStyle({ fontSize: s })}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="dn-style-panel__row" style={{ marginTop: 6 }}>
          <button
            type="button"
            className={`dn-style-panel__btn${labelWeight === "bold" ? " dn-style-panel__btn--active" : ""}`}
            style={{ fontWeight: "bold" }}
            onClick={() => patchLabelStyle({ fontWeight: labelWeight === "bold" ? "normal" : "bold" })}
          >B</button>
          <button
            type="button"
            className={`dn-style-panel__btn${labelItalic === "italic" ? " dn-style-panel__btn--active" : ""}`}
            style={{ fontStyle: "italic" }}
            onClick={() => patchLabelStyle({ fontStyle: labelItalic === "italic" ? "normal" : "italic" })}
          >I</button>
        </div>
      </div>

      <div className="dn-style-panel__actions">
        {onEditLabel && (
          <button type="button" className="dn-style-panel__action" onClick={() => { onEditLabel(); onClose(); }}>
            Edit label…
          </button>
        )}
        <button type="button" className="dn-style-panel__action dn-style-panel__action--danger" onClick={() => { onDelete(); onClose(); }}>
          Delete
        </button>
      </div>
    </div>
  );
}
