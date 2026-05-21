import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import EmptyState from "../../components/EmptyState";
import DefinitionDialog from "../../components/DefinitionDialog";
import HistoryButton from "../../components/HistoryButton";
import LangBadge from "../../components/LangBadge";
import {
  fetchDefinitions,
  createDefinition,
  updateDefinition,
  deleteDefinition,
  type Definition,
  type DefinitionInput,
  type AuthUser,
} from "../../api";
import { svgToDataUrl } from "../../lib/svg";

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; definition: Definition };

type Props = {
  project: string;
  currentUser: AuthUser;
};

export default function DefinitionsTab({ project, currentUser }: Props) {
  const { t } = useTranslation();
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [error, setError] = useState<string | null>(null);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [search]);

  const refresh = useCallback(async () => {
    try {
      const { definitions: list } = await fetchDefinitions(project, {
        q: debouncedSearch || undefined,
      });
      setDefinitions(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [project, debouncedSearch]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Keep the dialog's definition in sync with the list when generate / clear /
  // active-description calls refresh the backing row. Without this the dialog
  // renders stale data until the user closes and reopens it.
  useEffect(() => {
    if (dialog.kind !== "edit") return;
    const fresh = definitions.find((d) => d.id === dialog.definition.id);
    if (fresh && fresh.updatedAt !== dialog.definition.updatedAt) {
      setDialog({ kind: "edit", definition: fresh });
    }
  }, [definitions, dialog]);

  const canEdit = (d: Definition) =>
    currentUser.role === "admin" || d.createdBy === currentUser.id;

  const activeText = (d: Definition): string => {
    if (d.activeDescription === "short" && d.llmShort) return d.llmShort;
    if (d.activeDescription === "long" && d.llmLong) return d.llmLong;
    if (d.manualDescription) return d.manualDescription;
    if (d.llmShort) return d.llmShort;
    if (d.llmLong) return d.llmLong;
    return "";
  };

  const handleCreate = async (input: DefinitionInput) => {
    const created = await createDefinition(project, input);
    await refresh();
    setDialog({ kind: "edit", definition: created });
  };

  const handleSave = (target: Definition) => async (patch: DefinitionInput) => {
    const updated = await updateDefinition(project, target.id, patch);
    await refresh();
    if (dialog.kind === "edit" && dialog.definition.id === target.id) {
      setDialog({ kind: "edit", definition: updated });
    }
  };

  const handleDelete = async (d: Definition) => {
    try {
      await deleteDefinition(project, d.id);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const statusChip = (d: Definition) => {
    if (d.llmStatus === "generating") {
      return (
        <span className="kb-chip kb-chip--generating">
          {t("tab.kb.definitions.status.generating")}
        </span>
      );
    }
    if (d.llmStatus === "error") {
      return (
        <span className="kb-chip kb-chip--error" title={d.llmError ?? undefined}>
          {t("tab.kb.definitions.status.error")}
        </span>
      );
    }
    if (d.llmCleared) {
      return (
        <span className="kb-chip kb-chip--cleared">
          {t("tab.kb.definitions.status.cleared")}
        </span>
      );
    }
    if (d.llmShort || d.llmLong) {
      return (
        <span className="kb-chip kb-chip--ok">
          {t("tab.kb.definitions.status.aiFilled")}
        </span>
      );
    }
    return (
      <span className="kb-chip kb-chip--idle">
        {t("tab.kb.definitions.status.notGenerated")}
      </span>
    );
  };

  const activeBadge = (d: Definition) => {
    if (d.activeDescription === "short") {
      return (
        <span className="kb-chip kb-chip--active">
          {t("tab.kb.definitions.active.short")}
        </span>
      );
    }
    if (d.activeDescription === "long") {
      return (
        <span className="kb-chip kb-chip--active">
          {t("tab.kb.definitions.active.long")}
        </span>
      );
    }
    return (
      <span className="kb-chip kb-chip--active">
        {t("tab.kb.definitions.active.manual")}
      </span>
    );
  };

  return (
    <div className="kb-tab">
      <div className="kb-tab__header">
        <div className="kb-tab__search-wrap">
          <input
            className="kb-tab__search"
            type="text"
            placeholder={t("tab.kb.definitions.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          className="btn btn--send"
          onClick={() => setDialog({ kind: "create" })}
        >
          {t("tab.kb.definitions.newDefinition")}
        </button>
      </div>

      {error && (
        <div className="kb-tab__error">
          {error}
          <button className="kb-tab__error-close" onClick={() => setError(null)}>&times;</button>
        </div>
      )}

      {definitions.length === 0 && !debouncedSearch ? (
        <EmptyState
          title={t("tab.kb.definitions.emptyTitle")}
          description={t("tab.kb.definitions.emptyDescription")}
          action={
            <button className="btn btn--send" onClick={() => setDialog({ kind: "create" })}>
              {t("tab.kb.definitions.newDefinition")}
            </button>
          }
        />
      ) : definitions.length === 0 ? (
        <EmptyState
          title={t("tab.kb.definitions.noMatchesTitle")}
          description={t("tab.kb.definitions.noMatchesDescription", {
            query: debouncedSearch,
          })}
          size="sm"
        />
      ) : (
        <div className="kb-grid">
          {definitions.map((d) => (
            <div
              key={d.id}
              className="kb-card"
              onClick={() => setDialog({ kind: "edit", definition: d })}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setDialog({ kind: "edit", definition: d });
                }
              }}
            >
              <div className="kb-card__header">
                <span className="kb-card__term">{d.term}</span>
                {d.originalLang && (
                  <LangBadge
                    lang={d.originalLang}
                    title={t("tab.kb.definitions.sourceLangTitle", {
                      lang: d.originalLang.toUpperCase(),
                    })}
                  />
                )}
                {d.isProjectDependent && (
                  <span
                    className="kb-chip kb-chip--project"
                    title={t("tab.kb.definitions.projectBadgeTitle")}
                  >
                    {t("tab.kb.definitions.projectBadge")}
                  </span>
                )}
              </div>
              {d.svgContent && (
                <div className="kb-card__illustration" aria-hidden="true">
                  <img src={svgToDataUrl(d.svgContent)} alt="" />
                </div>
              )}
              <div className="kb-card__chips">
                {activeBadge(d)}
                {statusChip(d)}
              </div>
              <p className="kb-card__preview">
                {activeText(d) || (
                  <em className="kb-card__preview--empty">
                    {t("tab.kb.definitions.noDescription")}
                  </em>
                )}
              </p>
              {canEdit(d) && (
                <div className="kb-card__actions" onClick={(e) => e.stopPropagation()}>
                  <HistoryButton
                    kind="kb_definition"
                    entityId={d.id}
                    entityName={d.term}
                  />
                  <button
                    className="kb-card__action-btn"
                    onClick={() => void handleDelete(d)}
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                  >
                    &times;
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {dialog.kind === "create" && (
        <DefinitionDialog
          project={project}
          currentUser={currentUser}
          mode="create"
          onClose={() => setDialog({ kind: "closed" })}
          onCreate={handleCreate}
        />
      )}
      {dialog.kind === "edit" && (
        <DefinitionDialog
          project={project}
          currentUser={currentUser}
          mode="edit"
          definition={dialog.definition}
          onClose={async () => {
            setDialog({ kind: "closed" });
            await refresh();
          }}
          onSave={handleSave(dialog.definition)}
          onRefreshed={async () => {
            await refresh();
          }}
        />
      )}
    </div>
  );
}
