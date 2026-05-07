import { useCallback, useEffect, useState } from "react";
import Modal from "../../components/Modal";
import ConfirmDialog from "../../components/ConfirmDialog";
import type { AuthUser, CodeProject, CodeProjectSecret } from "../../api";
import {
  createCodeProjectSecret,
  deleteCodeProjectSecret,
  listCodeProjectSecrets,
  updateCodeProjectSecret,
} from "../../api";
import {
  Eye,
  EyeOff,
  ICON_DEFAULTS,
  KeyRound,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
} from "../../lib/icons";

interface Props {
  codeProject: CodeProject;
  currentUser: AuthUser;
}

interface FormState {
  name: string;
  description: string;
  value: string;
  isViewable: boolean;
  llmForbidden: boolean;
}

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  value: "",
  isViewable: false,
  llmForbidden: false,
};

export default function CodeSecretsView({ codeProject, currentUser }: Props) {
  const [secrets, setSecrets] = useState<CodeProjectSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Add / edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CodeProjectSecret | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showFormValue, setShowFormValue] = useState(false);

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<CodeProjectSecret | null>(null);

  // Which secret values are currently revealed in the table
  const [revealedIds, setRevealedIds] = useState<Set<number>>(new Set());

  const isAdmin = currentUser.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setSecrets(await listCodeProjectSecrets(codeProject.id));
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, [codeProject.id]);

  useEffect(() => { void load(); }, [load]);

  function openAdd() {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setShowFormValue(false);
    setModalOpen(true);
  }

  function openEdit(s: CodeProjectSecret) {
    setEditTarget(s);
    setForm({
      name: s.name,
      description: s.description,
      value: s.value ?? "",
      isViewable: s.isViewable,
      llmForbidden: s.llmForbidden,
    });
    setFormError(null);
    setShowFormValue(false);
    setModalOpen(true);
  }

  async function handleSave() {
    setFormError(null);
    if (!NAME_RE.test(form.name.trim())) {
      setFormError(
        "Name must start with an uppercase letter and contain only uppercase letters, digits, and underscores (e.g. DB_PASSWORD).",
      );
      return;
    }
    if (!form.value.trim()) {
      setFormError("Value must not be empty.");
      return;
    }
    setSaving(true);
    try {
      if (editTarget) {
        const updated = await updateCodeProjectSecret(codeProject.id, editTarget.id, {
          name: form.name.trim(),
          description: form.description,
          value: form.value,
          isViewable: form.isViewable,
          llmForbidden: form.llmForbidden,
        });
        setSecrets((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      } else {
        const created = await createCodeProjectSecret(codeProject.id, {
          name: form.name.trim(),
          description: form.description,
          value: form.value,
          isViewable: form.isViewable,
          llmForbidden: form.llmForbidden,
        });
        setSecrets((prev) => [...prev, created]);
      }
      setModalOpen(false);
    } catch (e) {
      setFormError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(s: CodeProjectSecret) {
    try {
      await deleteCodeProjectSecret(codeProject.id, s.id);
      setSecrets((prev) => prev.filter((x) => x.id !== s.id));
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setDeleteTarget(null);
    }
  }

  function toggleReveal(id: number) {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="code-graph">
      <header className="code-graph__header">
        <div className="code-graph__title">
          <KeyRound {...ICON_DEFAULTS} />
          <span>Secrets</span>
        </div>
        {isAdmin && (
          <div className="code-graph__actions">
            <button type="button" className="btn btn--primary" onClick={openAdd}>
              <Plus size={14} /> Add secret
            </button>
          </div>
        )}
      </header>

      <p style={{ margin: 0, fontSize: 13, color: "var(--text-dim)" }}>
        Reference secrets in scripts as <code>{"{{secret:NAME}}"}</code> or{" "}
        <code>process.env.NAME</code>. Values are substituted at run time and never
        sent to the LLM.
      </p>

      {loadError && (
        <div className="tasks__error">{loadError}</div>
      )}

      {loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 13 }}>
          <span className="spinner" style={{ width: 16, height: 16 }} /> Loading…
        </div>
      )}

      {!loading && secrets.length === 0 && !loadError && (
        <div className="tasks-empty" style={{ textAlign: "left", padding: 0 }}>
          No secrets yet.{" "}
          {isAdmin && (
            <>Add one and reference it as <code>{"{{secret:MY_SECRET}}"}</code>.</>
          )}
        </div>
      )}

      {secrets.length > 0 && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <table className="tasks-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Value</th>
                <th>Flags</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => {
                const canReveal = isAdmin || s.isViewable;
                const revealed = revealedIds.has(s.id);
                return (
                  <tr key={s.id}>
                    <td>
                      <code>{s.name}</code>
                    </td>
                    <td style={{ color: "var(--text-dim)" }}>
                      {s.description || "—"}
                    </td>
                    <td>
                      {s.value === null ? (
                        <span style={{ color: "var(--text-faint)", letterSpacing: 2 }}>
                          ••••••••
                        </span>
                      ) : canReveal ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 12,
                              letterSpacing: revealed ? 0 : 2,
                            }}
                          >
                            {revealed ? s.value : "••••••••"}
                          </span>
                          <button
                            type="button"
                            className="btn btn--icon"
                            onClick={() => toggleReveal(s.id)}
                            title={revealed ? "Hide" : "Show"}
                          >
                            {revealed ? (
                              <EyeOff size={13} strokeWidth={1.75} />
                            ) : (
                              <Eye size={13} strokeWidth={1.75} />
                            )}
                          </button>
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-faint)", letterSpacing: 2 }}>
                          ••••••••
                        </span>
                      )}
                    </td>
                    <td>
                      <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                        {s.llmForbidden && (
                          <span
                            className="run-log__chip"
                            title="Value is forbidden from reaching the LLM"
                            style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "default" }}
                          >
                            <ShieldAlert size={11} strokeWidth={1.75} />
                            LLM-forbidden
                          </span>
                        )}
                        {!s.isViewable && (
                          <span
                            className="run-log__chip"
                            title="Value is hidden from non-admins"
                            style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "default" }}
                          >
                            <Eye size={11} strokeWidth={1.75} />
                            Private
                          </span>
                        )}
                      </span>
                    </td>
                    {isAdmin && (
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          className="btn btn--icon"
                          onClick={() => openEdit(s)}
                          title="Edit"
                        >
                          <Pencil size={13} strokeWidth={1.75} />
                        </button>
                        <button
                          type="button"
                          className="btn btn--icon"
                          onClick={() => setDeleteTarget(s)}
                          title="Delete"
                          style={{ marginLeft: 4 }}
                        >
                          <Trash2 size={13} strokeWidth={1.75} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / Edit modal */}
      {modalOpen && (
        <Modal onClose={() => setModalOpen(false)}>
          <Modal.Header title={editTarget ? "Edit secret" : "Add secret"} />
          <Modal.Body>
            <div className="form-group">
              <label className="form-label" htmlFor="secret-name">
                Name
              </label>
              <input
                id="secret-name"
                className="form-input"
                placeholder="DB_PASSWORD"
                value={form.name}
                disabled={Boolean(editTarget)}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value.toUpperCase() }))
                }
                autoFocus
              />
              <span style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                Uppercase letters, digits, underscores — e.g. <code>DB_PASSWORD</code>
              </span>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="secret-desc">
                Description
              </label>
              <input
                id="secret-desc"
                className="form-input"
                placeholder="Optional description"
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="secret-value">
                Value
              </label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  id="secret-value"
                  className="form-input"
                  type={showFormValue ? "text" : "password"}
                  placeholder="Secret value"
                  value={form.value}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, value: e.target.value }))
                  }
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setShowFormValue((v) => !v)}
                  title={showFormValue ? "Hide" : "Show"}
                  style={{ flexShrink: 0 }}
                >
                  {showFormValue ? (
                    <EyeOff size={14} strokeWidth={1.75} />
                  ) : (
                    <Eye size={14} strokeWidth={1.75} />
                  )}
                </button>
              </div>
            </div>

            <div className="form-group" style={{ gap: 10 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.isViewable}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, isViewable: e.target.checked }))
                  }
                />
                <span style={{ fontSize: 13 }}>
                  Viewable — non-admins can read the value
                </span>
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.llmForbidden}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, llmForbidden: e.target.checked }))
                  }
                />
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13 }}>
                  <ShieldAlert size={13} strokeWidth={1.75} />
                  LLM-forbidden — any chat message containing this value is blocked
                </span>
              </label>
            </div>

            {formError && (
              <p className="project-form__hint project-form__hint--error">
                {formError}
              </p>
            )}
          </Modal.Body>
          <Modal.Footer>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setModalOpen(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? "Saving…" : editTarget ? "Save" : "Add"}
            </button>
          </Modal.Footer>
        </Modal>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete secret"
        message={
          deleteTarget
            ? `Delete "${deleteTarget.name}"? This cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={() => deleteTarget && void handleDelete(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
