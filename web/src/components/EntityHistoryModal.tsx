import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import Modal from "./Modal";
import ConfirmDialog from "./ConfirmDialog";
import {
  getEntityVersion,
  listEntityVersions,
  restoreEntityVersion,
  type EntityVersionDetail,
  type EntityVersionMeta,
} from "../api";
import { formatRelative } from "../lib/format";

interface Props {
  kind: string;
  entityId: string | number;
  entityName?: string;
  onClose: () => void;
  onRestored?: () => void;
}

function sourceLabel(source: string, t: TFunction): string {
  switch (source) {
    case "save":
      return t("history.source.save");
    case "pre_delete":
      return t("history.source.preDelete");
    case "pre_restore":
      return t("history.source.preRestore");
    case "restore":
      return t("history.source.restore");
    case "manual":
      return t("history.source.manual");
    case "backfill":
      return t("history.source.backfill");
    default:
      return source;
  }
}

/**
 * Per-entity history modal — wraps `<Modal size="md">` with a sidebar
 * timeline on the left and the selected snapshot's pretty-printed JSON on the
 * right. Restore fires a confirm step before calling the API.
 *
 * Per-kind renderers are out of scope here (Phase 4). The JSON fallback keeps
 * the modal useful for every registered kind on day one.
 */
export default function EntityHistoryModal({
  kind,
  entityId,
  entityName,
  onClose,
  onRestored,
}: Props) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<EntityVersionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<EntityVersionDetail | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listEntityVersions(kind, entityId)
      .then(({ versions: v }) => {
        if (cancelled) return;
        setVersions(v);
        // Default to the newest version, mirroring ScriptVersionsView.
        setSelectedVersion(v[0]?.version ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, entityId]);

  useEffect(() => {
    if (selectedVersion == null) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    getEntityVersion(kind, entityId, selectedVersion)
      .then(({ version: v }) => {
        if (!cancelled) setSelected(v);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, entityId, selectedVersion]);

  async function handleRestore() {
    if (selectedVersion == null) return;
    setRestoring(true);
    setError(null);
    try {
      await restoreEntityVersion(kind, entityId, selectedVersion);
      onRestored?.();
      // Re-fetch the list so the new pre_restore row shows up immediately.
      const { versions: v } = await listEntityVersions(kind, entityId);
      setVersions(v);
      setSelectedVersion(v[0]?.version ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRestoring(false);
      setConfirmOpen(false);
    }
  }

  return (
    <>
      <Modal
        onClose={onClose}
        size="md"
        className="entity-history-modal"
        disableBackdropClose={confirmOpen || restoring}
      >
        <Modal.Header
          title={
            entityName
              ? t("history.headerWithName", { name: entityName })
              : t("history.headerNoName")
          }
        />
        <Modal.Body className="entity-history-modal__body">
          {loading ? (
            <div className="loading-state">{t("history.loadingList")}</div>
          ) : versions.length === 0 ? (
            <p style={{ padding: "16px", opacity: 0.6 }}>
              {t("history.emptyMessage")}
            </p>
          ) : (
            <div className="entity-history-modal__split">
              <nav
                className="entity-history-modal__sidebar"
                aria-label={t("history.sidebarAria")}
              >
                <ul>
                  {versions.map((v) => {
                    const isActive = v.version === selectedVersion;
                    return (
                      <li key={v.id}>
                        <button
                          type="button"
                          className={`entity-history-modal__item ${
                            isActive
                              ? "entity-history-modal__item--active"
                              : ""
                          }`}
                          onClick={() => setSelectedVersion(v.version)}
                          aria-current={isActive ? "true" : undefined}
                        >
                          <span className="entity-history-modal__version">
                            {t("history.versionPrefix", { n: v.version })}
                          </span>
                          <span className="entity-history-modal__time">
                            {formatRelative(v.createdAt)}
                          </span>
                          <span className="entity-history-modal__source">
                            {sourceLabel(v.source, t)}
                          </span>
                          {v.flags.length > 0 && (
                            <span
                              className="entity-history-modal__flags"
                              title={v.flags.join(", ")}
                            >
                              {v.flags.join(",")}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </nav>
              <div className="entity-history-modal__detail">
                {detailLoading ? (
                  <div className="loading-state">{t("history.loadingDetail")}</div>
                ) : selected ? (
                  <>
                    <header className="entity-history-modal__detail-head">
                      <strong>{t("history.detailHeading", { n: selected.version })}</strong>
                      <span style={{ opacity: 0.6, marginLeft: 8 }}>
                        {selected.createdBy
                          ? t("history.detailMetaWithUser", {
                              source: sourceLabel(selected.source, t),
                              when: formatRelative(selected.createdAt),
                              user: selected.createdBy,
                            })
                          : t("history.detailMeta", {
                              source: sourceLabel(selected.source, t),
                              when: formatRelative(selected.createdAt),
                            })}
                      </span>
                    </header>
                    {selected.snapshot === null ? (
                      <p style={{ opacity: 0.6 }}>
                        {selected.flags.includes("oversized")
                          ? t("history.snapshotOversized")
                          : t("history.snapshotUnavailable")}
                      </p>
                    ) : (
                      <pre className="entity-history-modal__json">
                        {JSON.stringify(selected.snapshot, null, 2)}
                      </pre>
                    )}
                  </>
                ) : (
                  <p style={{ opacity: 0.6 }}>{t("history.pickPrompt")}</p>
                )}
              </div>
            </div>
          )}
          {error && (
            <p className="form-error" style={{ marginTop: 12 }}>
              {error}
            </p>
          )}
        </Modal.Body>
        <Modal.Footer>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setConfirmOpen(true)}
            disabled={
              selected === null ||
              selected.snapshot === null ||
              restoring
            }
          >
            {restoring ? t("history.restoring") : t("history.restoreThis")}
          </button>
        </Modal.Footer>
      </Modal>
      <ConfirmDialog
        open={confirmOpen}
        title={t("history.confirmTitle")}
        message={
          <Trans
            i18nKey="history.confirmMessage"
            components={{ code: <code /> }}
          />
        }
        confirmLabel={t("history.confirmLabel")}
        onConfirm={handleRestore}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
