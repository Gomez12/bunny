import { useRef, useState } from "react";
import { Plus, Search, Trash2, Loader2, ArrowRight } from "../../lib/icons";
import { ICON_MAP } from "./DiagramNode";
import type { DiagramLibraryItem } from "../../api";
import type { ServerEvent } from "../../api";

const DIAGRAM_TYPE_LABELS: Record<string, string> = {
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

interface Props {
  items: DiagramLibraryItem[];
  activeDiagramType: string;
  project: string;
  canEdit: boolean;
  onDeleteItem: (id: number) => void;
  onItemGenerated: (item: DiagramLibraryItem) => void;
  generateFn: (project: string, body: { diagramType: string; request: string }) => Promise<Response>;
}

export default function DiagramNodeLibrary({
  items,
  activeDiagramType,
  project,
  canEdit,
  onDeleteItem,
  onItemGenerated,
  generateFn,
}: Props) {
  const [search, setSearch] = useState("");
  const [aiInput, setAiInput] = useState("");
  const [aiStreaming, setAiStreaming] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showAiInput, setShowAiInput] = useState(false);
  const aiInputRef = useRef<HTMLInputElement>(null);

  const filtered = items.filter((it) =>
    !search || it.name.toLowerCase().includes(search.toLowerCase()),
  );

  // Group: active type first, then others, seeded first within each group
  const grouped: Array<{ type: string; label: string; items: DiagramLibraryItem[] }> = [];
  const typeOrder = [activeDiagramType, "custom", ...Object.keys(DIAGRAM_TYPE_LABELS).filter(
    (t) => t !== activeDiagramType && t !== "custom",
  )];

  for (const type of typeOrder) {
    const typeItems = filtered.filter((it) => it.diagramType === type);
    if (typeItems.length > 0) {
      grouped.push({
        type,
        label: DIAGRAM_TYPE_LABELS[type] ?? type,
        items: typeItems,
      });
    }
  }

  const handleDragStart = (e: React.DragEvent, item: DiagramLibraryItem) => {
    e.dataTransfer.setData("application/bunny-diagram-node", JSON.stringify(item));
    e.dataTransfer.effectAllowed = "copy";
  };

  const handleFloatingDragStart = (e: React.DragEvent, type: "floatingArrow" | "floatingLine") => {
    e.dataTransfer.setData("application/bunny-diagram-node", JSON.stringify({ _type: type }));
    e.dataTransfer.effectAllowed = "copy";
  };

  const handleGenerateNode = async () => {
    const req = aiInput.trim();
    if (!req || aiStreaming) return;

    setAiStreaming(true);
    setAiError(null);

    try {
      const res = await generateFn(project, { diagramType: activeDiagramType, request: req });
      if (!res.ok || !res.body) {
        setAiError("Generation failed");
        return;
      }

      let accumulated = "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            const ev = JSON.parse(raw) as ServerEvent;
            if (ev.type === "content") accumulated += ev.text ?? "";
          } catch {}
        }
      }

      const match = accumulated.match(/```json\s*([\s\S]*?)```/);
      if (!match) {
        setAiError("No JSON found in response");
        return;
      }

      const parsed = JSON.parse(match[1]!) as {
        name?: string;
        description?: string;
        shape?: string;
        icon_name?: string | null;
        color?: string;
        width?: number;
        height?: number;
        handle_sides?: string[];
      };

      if (!parsed.name) {
        setAiError("Invalid response from AI");
        return;
      }

      // Save the generated item via create API
      const { createDiagramLibraryItem } = await import("../../api");
      const item = await createDiagramLibraryItem(project, {
        diagramType: activeDiagramType,
        name: parsed.name,
        description: parsed.description,
        shape: parsed.shape,
        iconName: parsed.icon_name ?? null,
        color: parsed.color,
        width: parsed.width,
        height: parsed.height,
        handleSides: parsed.handle_sides,
      });

      onItemGenerated(item);
      setAiInput("");
      setShowAiInput(false);
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiStreaming(false);
    }
  };

  return (
    <div className="dn-library">
      <div className="dn-library__head">
        <span className="dn-library__title">Node Library</span>
        {canEdit && (
          <button
            type="button"
            className="btn dn-library__add-btn"
            title="Add node via AI"
            onClick={() => {
              setShowAiInput((v) => !v);
              setTimeout(() => aiInputRef.current?.focus(), 50);
            }}
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      {showAiInput && (
        <div className="dn-library__ai-input-row">
          <input
            ref={aiInputRef}
            className="dn-library__ai-input"
            placeholder={`Describe a node for ${DIAGRAM_TYPE_LABELS[activeDiagramType] ?? activeDiagramType}…`}
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleGenerateNode();
              if (e.key === "Escape") setShowAiInput(false);
            }}
            disabled={aiStreaming}
          />
          <button
            type="button"
            className="btn btn--accent dn-library__ai-send"
            onClick={() => void handleGenerateNode()}
            disabled={aiStreaming || !aiInput.trim()}
          >
            {aiStreaming ? <Loader2 size={13} className="spinner" /> : "Generate"}
          </button>
          {aiError && <div className="dn-library__ai-error">{aiError}</div>}
        </div>
      )}

      <div className="dn-library__search-row">
        <Search size={13} />
        <input
          className="dn-library__search"
          placeholder="Search nodes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="dn-library__groups">
        {/* Floating connectors — always shown at top */}
        {!search && (
          <div className="dn-library__group">
            <div className="dn-library__group-label">Connectors</div>
            {(["floatingArrow", "floatingLine"] as const).map((type) => (
              <div
                key={type}
                className="dn-library__item"
                draggable
                onDragStart={(e) => handleFloatingDragStart(e, type)}
                title={type === "floatingArrow" ? "Drag to add a floating arrow" : "Drag to add a floating line"}
              >
                <span className="dn-library__item-preview dn-library__item-preview--connector">
                  <ArrowRight size={12} strokeWidth={1.75} style={type === "floatingLine" ? { opacity: 0.5 } : undefined} />
                </span>
                <span className="dn-library__item-name">
                  {type === "floatingArrow" ? "Arrow" : "Line"}
                </span>
              </div>
            ))}
          </div>
        )}

        {grouped.length === 0 ? (
          <div className="dn-library__empty">No nodes found</div>
        ) : (
          grouped.map((group) => (
            <div key={group.type} className="dn-library__group">
              <div className="dn-library__group-label">{group.label}</div>
              {group.items.map((item) => {
                const IconComponent = item.iconName ? ICON_MAP[item.iconName] : null;
                return (
                  <div
                    key={item.id}
                    className={`dn-library__item${item.isSeeded ? "" : " dn-library__item--custom"}`}
                    draggable
                    onDragStart={(e) => handleDragStart(e, item)}
                    title={`Drag onto canvas — ${item.description || item.name}`}
                  >
                    <span
                      className={`dn-library__item-preview dn-library__item-preview--${item.shape}`}
                      style={{ "--dn-color": item.color } as React.CSSProperties}
                    >
                      {IconComponent && <IconComponent size={11} strokeWidth={1.75} />}
                    </span>
                    <span className="dn-library__item-name">{item.name}</span>
                    {!item.isSeeded && canEdit && (
                      <button
                        type="button"
                        className="dn-library__item-del"
                        onClick={() => onDeleteItem(item.id)}
                        title="Remove from library"
                        aria-label={`Remove ${item.name}`}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
