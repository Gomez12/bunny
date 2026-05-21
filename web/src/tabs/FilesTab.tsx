import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ConfirmDialog from "../components/ConfirmDialog";
import {
  deleteWorkspaceEntry,
  listWorkspace,
  mkdirWorkspace,
  moveWorkspaceEntry,
  uploadWorkspaceFiles,
  workspaceDownloadUrl,
  type AuthUser,
  type WorkspaceEntry,
} from "../api";

interface Props {
  project: string;
  currentUser: AuthUser;
}

const PROTECTED = new Set(["input", "output"]);

import { formatSize } from "../lib/format";
import EmptyState from "../components/EmptyState";
import { Lock } from "../lib/icons";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export default function FilesTab({ project, currentUser }: Props) {
  const { t } = useTranslation();
  const [path, setPath] = useState<string>("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState<WorkspaceEntry | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canEdit = useMemo(() => {
    // Admin always edits; non-admins need to own the project. The FilesTab
    // gets no project DTO, so we optimistically assume non-admins can edit
    // and let the server reply 403; admin is a simple shortcut.
    return currentUser.role === "admin" || true;
  }, [currentUser]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { entries } = await listWorkspace(project, path);
      setEntries(entries);
    } catch (e) {
      setError((e as Error).message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [project, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const breadcrumbs = useMemo(() => {
    const parts = path ? path.split("/") : [];
    const crumbs: Array<{ label: string; path: string }> = [
      { label: t("tab.files.workspaceCrumb"), path: "" },
    ];
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      crumbs.push({ label: p, path: acc });
    }
    return crumbs;
  }, [path, t]);

  const goUp = () => {
    if (!path) return;
    const idx = path.lastIndexOf("/");
    setPath(idx === -1 ? "" : path.slice(0, idx));
  };

  const openEntry = (e: WorkspaceEntry) => {
    if (e.kind === "dir") setPath(e.path);
  };

  const handleFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    try {
      await uploadWorkspaceFiles(project, path, arr);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onDrop = (ev: React.DragEvent) => {
    ev.preventDefault();
    setDragOver(false);
    if (!canEdit) return;
    void handleFiles(ev.dataTransfer.files);
  };

  const onDelete = (e: WorkspaceEntry) => {
    setConfirmDeleteEntry(e);
  };

  const confirmDeleteEntryAction = async () => {
    const e = confirmDeleteEntry;
    setConfirmDeleteEntry(null);
    if (!e) return;
    try {
      await deleteWorkspaceEntry(project, e.path);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onRename = async (e: WorkspaceEntry) => {
    const next = prompt(t("tab.files.renamePrompt"), e.name);
    if (!next || next === e.name) return;
    const parent = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
    const to = parent ? `${parent}/${next}` : next;
    try {
      await moveWorkspaceEntry(project, e.path, to);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onNewFolder = async () => {
    const name = prompt(t("tab.files.newFolderPrompt"));
    if (!name) return;
    const rel = path ? `${path}/${name}` : name;
    try {
      await mkdirWorkspace(project, rel);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const isProtected = (e: WorkspaceEntry): boolean =>
    path === "" && e.kind === "dir" && PROTECTED.has(e.name);

  return (
    <section className="files-tab">
      <div className="files-toolbar">
        <nav className="files-breadcrumbs">
          {breadcrumbs.map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="files-crumb-sep">/</span>}
              <button
                className="files-crumb"
                onClick={() => setPath(c.path)}
                disabled={i === breadcrumbs.length - 1}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="files-actions">
          {path && (
            <button className="btn btn--ghost" onClick={goUp}>
              {t("tab.files.up")}
            </button>
          )}
          {canEdit && (
            <>
              <button className="btn btn--ghost" onClick={onNewFolder}>
                {t("tab.files.newFolder")}
              </button>
              <button
                className="btn btn--send"
                onClick={() => fileInputRef.current?.click()}
              >
                {t("tab.files.upload")}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.target.files) void handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          )}
        </div>
      </div>

      {error && <div className="files-error">{error}</div>}

      <div
        className={`files-dropzone ${dragOver ? "files-dropzone--over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (canEdit) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {loading ? (
          <div className="files-empty">{t("tab.files.loading")}</div>
        ) : entries.length === 0 ? (
          <EmptyState
            size="sm"
            title={t("tab.files.emptyTitle")}
            description={canEdit ? t("tab.files.emptyDescription") : undefined}
          />
        ) : (
          <table className="files-table">
            <thead>
              <tr>
                <th>{t("tab.files.column.name")}</th>
                <th>{t("tab.files.column.size")}</th>
                <th>{t("tab.files.column.modified")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const locked = isProtected(e);
                return (
                  <tr
                    key={e.path}
                    className={e.kind === "dir" ? "files-row-dir" : "files-row-file"}
                    onDoubleClick={() => openEntry(e)}
                  >
                    <td>
                      <button
                        className="files-name-btn"
                        onClick={() => openEntry(e)}
                        disabled={e.kind === "file"}
                      >
                        {e.kind === "dir" ? "📁" : "📄"} {e.name}
                        {locked && (
                          <Lock
                            size={12}
                            aria-label={t("tab.files.protected")}
                            style={{ marginLeft: 4, verticalAlign: "middle" }}
                          />
                        )}
                      </button>
                    </td>
                    <td>{e.kind === "dir" ? "—" : formatSize(e.size)}</td>
                    <td>{formatTime(e.mtime)}</td>
                    <td className="files-row-actions">
                      {e.kind === "file" && (
                        <a
                          className="btn btn--ghost btn--sm"
                          href={workspaceDownloadUrl(project, e.path)}
                        >
                          {t("tab.files.download")}
                        </a>
                      )}
                      {canEdit && !locked && (
                        <>
                          <button className="btn btn--sm" onClick={() => onRename(e)}>
                            {t("tab.files.rename")}
                          </button>
                          <button
                            className="btn btn--danger btn--sm"
                            onClick={() => onDelete(e)}
                          >
                            {t("common.delete")}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmDialog
        open={confirmDeleteEntry !== null}
        message={
          confirmDeleteEntry?.kind === "dir"
            ? t("tab.files.deleteConfirmDir", {
                name: confirmDeleteEntry?.name ?? "",
              })
            : t("tab.files.deleteConfirmFile", {
                name: confirmDeleteEntry?.name ?? "",
              })
        }
        confirmLabel={t("common.delete")}
        onConfirm={() => void confirmDeleteEntryAction()}
        onCancel={() => setConfirmDeleteEntry(null)}
      />
    </section>
  );
}
