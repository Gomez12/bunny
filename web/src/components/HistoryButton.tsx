import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { History } from "../lib/icons";
import { countEntityVersions } from "../api";
import EntityHistoryModal from "./EntityHistoryModal";

interface Props {
  /** Registered VersionableKind on the server (e.g. "document"). */
  kind: string;
  /** Stringified id. Integer ids are coerced; slug ids pass through. */
  entityId: string | number;
  /** Display title shown in the modal header. */
  entityName?: string;
  /** Fires after a successful restore so the parent can re-fetch the live row. */
  onRestored?: () => void;
  /** Optional title override for the tooltip. */
  ariaLabel?: string;
}

/**
 * Small icon button that opens the per-entity version history modal.
 *
 * Renders a lucide `History` icon at 14 px with a subtle dot when the entity
 * has ≥ 1 stored version. The count endpoint is admin-gated (matches the
 * `/api/versions/*` surface) — non-admin sessions get a `403` we silently
 * absorb so the button just renders without the dot.
 */
export default function HistoryButton({
  kind,
  entityId,
  entityName,
  onRestored,
  ariaLabel,
}: Props) {
  const { t } = useTranslation();
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCount(null);
    countEntityVersions(kind, entityId)
      .then(({ count: n }) => {
        if (!cancelled) setCount(n);
      })
      .catch(() => {
        // 403 (non-admin) or 400 (unknown kind) — leave count at null and let
        // the button render in its neutral state.
      });
    return () => {
      cancelled = true;
    };
  }, [kind, entityId]);

  const hasVersions = count !== null && count > 0;
  const cls = [
    "history-button",
    hasVersions ? "history-button--has-versions" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <button
        type="button"
        className={cls}
        aria-label={ariaLabel ?? t("history.showAria")}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        title={
          hasVersions
            ? t("history.titleWithCount", { count })
            : t("history.title")
        }
      >
        <History size={14} />
      </button>
      {open && (
        <EntityHistoryModal
          kind={kind}
          entityId={entityId}
          entityName={entityName}
          onClose={() => setOpen(false)}
          onRestored={() => {
            // Refresh the dot indicator after the pre_restore row lands.
            countEntityVersions(kind, entityId)
              .then(({ count: n }) => setCount(n))
              .catch(() => {});
            onRestored?.();
          }}
        />
      )}
    </>
  );
}
