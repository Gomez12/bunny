import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import Modal from "./Modal";
import type { ScriptLanguage } from "../api";

const LANGUAGE_VALUES: ScriptLanguage[] = [
  "javascript",
  "typescript",
  "csharp",
  "python",
  "bash",
  "powershell",
  "go",
  "sql",
];

function languageLabel(value: ScriptLanguage, t: TFunction): string {
  switch (value) {
    case "javascript":
      return t("dialog.script.language.javascript");
    case "typescript":
      return t("dialog.script.language.typescript");
    case "csharp":
      return t("dialog.script.language.csharp");
    case "python":
      return t("dialog.script.language.python");
    case "bash":
      return t("dialog.script.language.bash");
    case "powershell":
      return t("dialog.script.language.powershell");
    case "go":
      return t("dialog.script.language.go");
    case "sql":
      return t("dialog.script.language.sql");
  }
}

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
  const { t } = useTranslation();
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
      <Modal.Header
        title={
          mode === "create"
            ? t("dialog.script.titleCreate")
            : t("dialog.script.titleEdit")
        }
      />
      <form onSubmit={handleSubmit}>
        <Modal.Body>
          <div className="form-group">
            <label className="form-label" htmlFor="script-name">
              {t("dialog.script.nameLabel")} {nameRequired && <span aria-hidden="true">*</span>}
            </label>
            <input
              id="script-name"
              className="form-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder={
                isTemp
                  ? t("dialog.script.namePlaceholderTemp")
                  : t("dialog.script.namePlaceholder")
              }
              required={nameRequired}
              pattern={nameRequired ? "[a-z0-9][a-z0-9_\\-]{0,63}" : undefined}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="script-lang">
              {t("dialog.script.languageLabel")}
            </label>
            <select
              id="script-lang"
              className="form-input"
              value={language}
              onChange={(e) => setLanguage(e.target.value as ScriptLanguage)}
            >
              {LANGUAGE_VALUES.map((value) => (
                <option key={value} value={value}>
                  {languageLabel(value, t)}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="script-description">
              {t("dialog.script.descriptionLabel")}
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
                {t("dialog.script.scratchLabel")}
              </label>
            </div>
          )}

          {error && (
            <p style={{ color: "var(--color-error)", marginTop: "8px" }}>{error}</p>
          )}
        </Modal.Body>
        <Modal.Footer>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn--primary">
            {mode === "create" ? t("common.create") : t("common.save")}
          </button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
