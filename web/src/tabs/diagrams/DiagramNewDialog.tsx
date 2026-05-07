import { useRef, useState } from "react";
import { X } from "../../lib/icons";

const DIAGRAM_TYPES = [
  { id: "network", label: "Network", description: "Network topology, infrastructure" },
  { id: "flowchart", label: "Flowchart", description: "Process flows, decision trees" },
  { id: "orgchart", label: "Org Chart", description: "Organisational hierarchy" },
  { id: "architecture", label: "Architecture", description: "System / software architecture" },
  { id: "er", label: "ER Diagram", description: "Entity-relationship data models" },
  { id: "sequence", label: "Sequence", description: "Interaction sequences" },
  { id: "mindmap", label: "Mind Map", description: "Brainstorming, topic maps" },
  { id: "class", label: "Class Diagram", description: "UML class structure" },
  { id: "bpmn", label: "BPMN", description: "Business process notation" },
  { id: "custom", label: "Custom", description: "Free-form, no constraints" },
];

interface Props {
  onClose: () => void;
  onCreate: (name: string, diagramType: string, intent: string) => void;
  busy?: boolean;
}

export default function DiagramNewDialog({ onClose, onCreate, busy }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState("custom");
  const [intent, setIntent] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    onCreate(name.trim(), type, intent.trim());
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal__header">
          <span className="modal__title">New Diagram</span>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <form className="modal__body" onSubmit={handleSubmit}>
          <div className="form-field">
            <label className="form-field__label" htmlFor="diag-name">Name</label>
            <input
              id="diag-name"
              ref={nameRef}
              autoFocus
              className="form-field__input"
              placeholder="My diagram"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="form-field">
            <label className="form-field__label">Diagram type</label>
            <div className="diag-type-grid">
              {DIAGRAM_TYPES.map((dt) => (
                <button
                  key={dt.id}
                  type="button"
                  className={`diag-type-card${type === dt.id ? " diag-type-card--active" : ""}`}
                  onClick={() => setType(dt.id)}
                >
                  <span className="diag-type-card__label">{dt.label}</span>
                  <span className="diag-type-card__desc">{dt.description}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="form-field">
            <label className="form-field__label" htmlFor="diag-intent">
              Intent <span className="form-field__optional">(optional — AI will generate a first draft)</span>
            </label>
            <textarea
              id="diag-intent"
              className="form-field__input"
              placeholder={`e.g. "Office network with router, 2 switches, 5 workstations"`}
              rows={3}
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
            />
          </div>

          <div className="modal__actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn--accent" disabled={!name.trim() || busy}>
              {busy ? <span className="spinner" /> : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
