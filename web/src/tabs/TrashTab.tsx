import { useCallback, useEffect, useRef, useState } from "react";
import {
  hardDeleteTrashed,
  listTrash,
  restoreTrashed,
  type TrashItem,
  type TrashKind,
} from "../api";
import {
  ICON_DEFAULTS,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "../lib/icons";

const KIND_LABEL: Record<TrashKind, string> = {
  document: "Document",
  whiteboard: "Whiteboard",
  contact: "Contact",
  kb_definition: "Definition",
  code_project: "Code project",
  workflow: "Workflow",
};

/** Seconds a "Confirm?" state stays armed before reverting. */
const CONFIRM_WINDOW_MS = 4000;

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export default function TrashTab() {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      const data = await listTrash();
      setItems(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const rowKey = (item: TrashItem) => `${item.kind}:${item.id}`;

  function armConfirm(key: string) {
    setConfirmKey(key);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => {
      setConfirmKey((curr) => (curr === key ? null : curr));
    }, CONFIRM_WINDOW_MS);
  }

  async function handleRestore(item: TrashItem) {
    const key = rowKey(item);
    setBusy(key);
    setBanner(null);
    try {
      await restoreTrashed(item.kind, item.id);
      setItems((prev) => prev?.filter((x) => rowKey(x) !== key) ?? null);
      setBanner(`Restored "${item.name}".`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "name_conflict") {
        setBanner(
          `Cannot restore "${item.name}" — another live ${KIND_LABEL[
            item.kind
          ].toLowerCase()} already uses this name in project "${item.project}". Rename the live one first.`,
        );
      } else {
        setBanner(`Restore failed: ${msg}`);
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleHardDelete(item: TrashItem) {
    const key = rowKey(item);
    if (confirmKey !== key) {
      armConfirm(key);
      return;
    }
    setConfirmKey(null);
    setBusy(key);
    setBanner(null);
    try {
      await hardDeleteTrashed(item.kind, item.id);
      setItems((prev) => prev?.filter((x) => rowKey(x) !== key) ?? null);
      setBanner(`Permanently deleted "${item.name}".`);
    } catch (e) {
      setBanner(
        `Delete failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="trash">
      <header className="trash__header">
        <h2>Trash</h2>
        <p className="trash__hint">
          Soft-deleted documents, whiteboards, contacts, and knowledge-base
          definitions live here. Restore puts them back where they came from;
          delete forever removes the row and cascades to its translations.
          Click <strong>Delete forever</strong> twice within a few seconds to
          confirm.
        </p>
        <button className="trash__reload" onClick={() => void reload()}>
          <RefreshCw {...ICON_DEFAULTS} />
          Reload
        </button>
      </header>

      {banner && (
        <div className="trash__banner" role="status">
          {banner}
          <button
            type="button"
            className="trash__banner-close"
            aria-label="Dismiss"
            onClick={() => setBanner(null)}
          >
            ×
          </button>
        </div>
      )}

      {items === null && (
        <div className="trash__loading">
          <Loader2 {...ICON_DEFAULTS} className="trash__spinner" />
          Loading…
        </div>
      )}

      {error && <div className="trash__error">Error: {error}</div>}

      {items && items.length === 0 && (
        <div className="trash__empty">The bin is empty.</div>
      )}

      {items && items.length > 0 && (
        <table className="trash__table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Name</th>
              <th>Project</th>
              <th>Deleted</th>
              <th>By</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const key = rowKey(item);
              const isBusy = busy === key;
              const isArmed = confirmKey === key;
              return (
                <tr key={key}>
                  <td>
                    <span className={`trash__kind trash__kind--${item.kind}`}>
                      {KIND_LABEL[item.kind]}
                    </span>
                  </td>
                  <td className="trash__name">{item.name}</td>
                  <td>{item.project}</td>
                  <td>{fmtTs(item.deletedAt)}</td>
                  <td>{item.deletedBy ?? "—"}</td>
                  <td className="trash__actions">
                    <button
                      type="button"
                      className="trash__action trash__action--restore"
                      onClick={() => void handleRestore(item)}
                      disabled={isBusy}
                      title="Restore"
                    >
                      <RotateCcw {...ICON_DEFAULTS} />
                      Restore
                    </button>
                    <button
                      type="button"
                      className={`trash__action trash__action--delete${
                        isArmed ? " trash__action--armed" : ""
                      }`}
                      onClick={() => void handleHardDelete(item)}
                      disabled={isBusy}
                      title={isArmed ? "Click again to confirm" : "Delete forever"}
                    >
                      <Trash2 {...ICON_DEFAULTS} />
                      {isArmed ? "Confirm?" : "Delete forever"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
