import { useState } from "react";
import Modal from "./Modal";
import type { ScriptLanguage } from "../api";

const LANGUAGES: { value: ScriptLanguage; label: string }[] = [
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "csharp", label: "C# / .NET" },
  { value: "python", label: "Python" },
  { value: "bash", label: "Bash / Shell" },
  { value: "powershell", label: "PowerShell" },
  { value: "go", label: "Go" },
  { value: "sql", label: "SQL" },
];

interface Props {
  mode: "create" | "edit";
  initialName?: string;
  initialDescription?: string;
  initialLanguage?: ScriptLanguage;
  initialIsTemp?: boolean;
  onConfirm: (values: {
    name: string;
    description: string;
    language: ScriptLanguage;
    isTemp: boolean;
  }) => void;
  onClose: () => void;
  error?: string;
}

export default function ScriptDialog({
  mode,
  initialName = "",
  initialDescription = "",
  initialLanguage = "javascript",
  initialIsTemp = false,
  onConfirm,
  onClose,
  error,
}: Props) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [language, setLanguage] = useState<ScriptLanguage>(initialLanguage);
  const [isTemp, setIsTemp] = useState(initialIsTemp);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onConfirm({ name, description, language, isTemp });
  }

  const nameRequired = !isTemp;

  return (
    <Modal onClose={onClose}>
      <Modal.Header title={mode === "create" ? "New script" : "Edit script"} />
      <form onSubmit={handleSubmit}>
        <Modal.Body>
          <div className="form-group">
            <label className="form-label" htmlFor="script-name">
              Name {nameRequired && <span aria-hidden="true">*</span>}
            </label>
            <input
              id="script-name"
              className="form-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder={isTemp ? "auto-generated if empty" : "my-script"}
              required={nameRequired}
              pattern={nameRequired ? "[a-z0-9][a-z0-9_\\-]{0,63}" : undefined}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="script-lang">
              Language
            </label>
            <select
              id="script-lang"
              className="form-input"
              value={language}
              onChange={(e) => setLanguage(e.target.value as ScriptLanguage)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="script-description">
              Description
            </label>
            <input
              id="script-description"
              className="form-input"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {mode === "create" && (
            <div className="form-group" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                id="script-temp"
                type="checkbox"
                checked={isTemp}
                onChange={(e) => setIsTemp(e.target.checked)}
              />
              <label htmlFor="script-temp" className="form-label" style={{ marginBottom: 0 }}>
                Scratch script (temp — hidden by default, no name required)
              </label>
            </div>
          )}

          {error && (
            <p style={{ color: "var(--color-error)", marginTop: "8px" }}>{error}</p>
          )}
        </Modal.Body>
        <Modal.Footer>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary">
            {mode === "create" ? "Create" : "Save"}
          </button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
