import { useCallback, useEffect, useState } from "react";
import type { AuthUser, CodeProject, Script, ScriptLanguage } from "../../api";
import {
  createScript,
  deleteScript,
  listScripts,
  patchScript,
  promoteScript,
} from "../../api";
import ScriptDialog from "../../components/ScriptDialog";
import ConfirmDialog from "../../components/ConfirmDialog";
import ScriptEditorView from "./scripts/ScriptEditorView";
import ScriptChatView from "./scripts/ScriptChatView";
import ScriptVersionsView from "./scripts/ScriptVersionsView";
import EmptyState from "../../components/EmptyState";
import { Code, History, MessageCircle, ICON_DEFAULTS } from "../../lib/icons";

type ScriptFeatureId = "editor" | "chat" | "versions";

const SCRIPT_KEY = (cpId: number) => `bunny.activeScript.${cpId}`;
const FEATURE_KEY = "bunny.activeScriptFeature";
const VALID_SCRIPT_FEATURES: ScriptFeatureId[] = ["editor", "chat", "versions"];

function resolveScriptFeature(): ScriptFeatureId {
  const s = localStorage.getItem(FEATURE_KEY);
  return s && (VALID_SCRIPT_FEATURES as string[]).includes(s)
    ? (s as ScriptFeatureId)
    : "editor";
}

interface Props {
  codeProject: CodeProject;
  currentUser: AuthUser;
}

/**
 * Scripts sub-view inside the Code tab. Shown when feature = "scripts" in
 * CodeTab. The code project is already selected via CodeRail — no picker here.
 */
export default function CodeScriptsView({ codeProject, currentUser }: Props) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [tempScripts, setTempScripts] = useState<Script[]>([]);
  const [activeScriptId, setActiveScriptIdRaw] = useState<number | null>(() => {
    const raw = localStorage.getItem(SCRIPT_KEY(codeProject.id));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  const [activeFeature, setActiveFeatureRaw] =
    useState<ScriptFeatureId>(resolveScriptFeature);
  const [showTemp, setShowTemp] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createIsTemp, setCreateIsTemp] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState<Script | null>(null);
  const [renameTarget, setRenameTarget] = useState<Script | null>(null);

  const activeScript =
    [...scripts, ...tempScripts].find((s) => s.id === activeScriptId) ?? null;

  const setActiveScriptId = useCallback(
    (id: number | null) => {
      if (id == null) localStorage.removeItem(SCRIPT_KEY(codeProject.id));
      else localStorage.setItem(SCRIPT_KEY(codeProject.id), String(id));
      setActiveScriptIdRaw(id);
    },
    [codeProject.id],
  );

  const setActiveFeature = useCallback((f: ScriptFeatureId) => {
    localStorage.setItem(FEATURE_KEY, f);
    setActiveFeatureRaw(f);
  }, []);

  const reload = useCallback(async () => {
    const [regular, all] = await Promise.all([
      listScripts(codeProject.id),
      listScripts(codeProject.id, { includeTemp: true }),
    ]);
    setScripts(regular.scripts);
    setTempScripts(all.scripts.filter((s) => s.isTemp));
  }, [codeProject.id]);

  // Load scripts whenever code project changes
  useEffect(() => {
    void reload().then(() => {
      // Restore last active script for this project
      const raw = localStorage.getItem(SCRIPT_KEY(codeProject.id));
      if (raw) setActiveScriptIdRaw(Number(raw) || null);
      else setActiveScriptIdRaw(null);
    });
  }, [codeProject.id, reload]);

  async function handleCreate(values: {
    name: string;
    description: string;
    language: ScriptLanguage;
    isTemp: boolean;
  }) {
    setCreateError(undefined);
    try {
      const { script } = await createScript(codeProject.id, values);
      await reload();
      setActiveScriptId(script.id);
      setActiveFeature("editor");
      setCreateOpen(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setCreateError(msg.includes("name_conflict") ? "Name already exists" : msg);
    }
  }

  async function handleDeleteConfirm() {
    if (!confirmDelete) return;
    await deleteScript(confirmDelete.id);
    setConfirmDelete(null);
    if (activeScriptId === confirmDelete.id) setActiveScriptId(null);
    await reload();
  }

  function updateLocal(updated: Script) {
    setScripts((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    setTempScripts((prev) =>
      prev.map((s) => (s.id === updated.id ? updated : s)),
    );
  }

  const FEATURE_BUTTONS: { id: ScriptFeatureId; label: string; Icon: typeof Code }[] = [
    { id: "editor", label: "Editor", Icon: Code },
    { id: "chat", label: "Chat", Icon: MessageCircle },
    { id: "versions", label: "Versions", Icon: History },
  ];

  return (
    <div className="code-scripts">
      {/* Script list sidebar */}
      <aside className="code-scripts__sidebar">
        <div className="code-scripts__sidebar-header">
          <span>Scripts</span>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => { setCreateIsTemp(false); setCreateOpen(true); }}
            title="New script"
          >
            +
          </button>
        </div>

        <ul className="code-scripts__list">
          {scripts.length === 0 && !showTemp && (
            <li className="code-scripts__empty">No scripts yet.</li>
          )}
          {scripts.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={`code-scripts__item${activeScript?.id === s.id ? " code-scripts__item--active" : ""}`}
                onClick={() => { setActiveScriptId(s.id); setActiveFeature("editor"); }}
                title={s.name}
              >
                {s.name}
                <span className="code-scripts__item-lang">{s.language}</span>
              </button>
            </li>
          ))}
        </ul>

        {/* Temp scripts */}
        <div className="code-scripts__temp-row">
          <button
            type="button"
            className="btn btn--ghost"
            style={{ fontSize: "11px" }}
            onClick={() => setShowTemp((v) => !v)}
          >
            {showTemp ? "Hide scratch" : "Show scratch"}
          </button>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => {
              void createScript(codeProject.id, { isTemp: true }).then(
                async ({ script }) => {
                  await reload();
                  setActiveScriptId(script.id);
                  setActiveFeature("editor");
                  setShowTemp(true);
                },
              );
            }}
            title="New scratch script"
          >
            ⚡
          </button>
        </div>
        {showTemp && (
          <ul className="code-scripts__list code-scripts__list--temp">
            {tempScripts.length === 0 && (
              <li className="code-scripts__empty">No scratch scripts.</li>
            )}
            {tempScripts.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`code-scripts__item code-scripts__item--temp${activeScript?.id === s.id ? " code-scripts__item--active" : ""}`}
                  onClick={() => { setActiveScriptId(s.id); setActiveFeature("editor"); }}
                  title={`(scratch) ${s.name}`}
                >
                  {s.name}
                  <span className="code-scripts__item-lang">{s.language}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Feature tabs for active script */}
        {activeScript && (
          <div className="code-scripts__feature-tabs">
            {FEATURE_BUTTONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                className={`code-scripts__feature-btn${activeFeature === id ? " code-scripts__feature-btn--active" : ""}`}
                onClick={() => setActiveFeature(id)}
                title={label}
              >
                <Icon {...ICON_DEFAULTS} size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* Main content */}
      <div className="code-scripts__main">
        {!activeScript ? (
          <EmptyState
            title="No script selected"
            description="Create a script or pick one from the list."
            action={
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => { setCreateIsTemp(false); setCreateOpen(true); }}
              >
                New script
              </button>
            }
          />
        ) : activeFeature === "editor" ? (
          <ScriptEditorView
            script={activeScript}
            codeProject={codeProject}
            onScriptChange={updateLocal}
            onPromote={async (id) => {
              await promoteScript(id);
              await reload();
            }}
            onDelete={(s) => setConfirmDelete(s)}
            onRename={(s) => setRenameTarget(s)}
            onOpenChat={() => setActiveFeature("chat")}
          />
        ) : activeFeature === "chat" ? (
          <ScriptChatView
            script={activeScript}
            currentUser={currentUser}
          />
        ) : (
          <ScriptVersionsView
            script={activeScript}
            onRestored={(updated) => {
              updateLocal(updated);
              setActiveFeature("editor");
            }}
          />
        )}
      </div>

      {/* Create dialog */}
      {createOpen && (
        <ScriptDialog
          mode="create"
          initialIsTemp={createIsTemp}
          onConfirm={handleCreate}
          onClose={() => { setCreateOpen(false); setCreateError(undefined); }}
          error={createError}
        />
      )}

      {/* Rename dialog */}
      {renameTarget && (
        <ScriptDialog
          mode="edit"
          initialName={renameTarget.name}
          initialDescription={renameTarget.description}
          initialLanguage={renameTarget.language}
          onConfirm={async (values) => {
            await patchScript(renameTarget.id, values);
            await reload();
            setRenameTarget(null);
          }}
          onClose={() => setRenameTarget(null)}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete script"
        message={confirmDelete ? `Delete "${confirmDelete.name}"? This moves it to Trash.` : ""}
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
