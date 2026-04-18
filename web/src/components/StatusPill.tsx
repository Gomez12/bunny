/**
 * Generic status pill. Reuses the `.kb-chip` base-class with a status modifier
 * so it blends with the existing KB status chips. Used by `<LanguageTabs>` and
 * anywhere else that needs a small coloured status badge.
 */

export type PillStatus =
  | "up-to-date"
  | "translating"
  | "stale"
  | "pending"
  | "failed"
  | "source"
  | "orphaned";

const LABELS: Record<PillStatus, string> = {
  "up-to-date": "Up to date",
  translating: "Translating…",
  stale: "Stale",
  pending: "Pending",
  failed: "Failed",
  source: "Source",
  orphaned: "Orphaned",
};

const MODIFIERS: Record<PillStatus, string> = {
  "up-to-date": "ok",
  translating: "generating",
  stale: "cleared",
  pending: "cleared",
  failed: "error",
  source: "active",
  orphaned: "error",
};

interface Props {
  status: PillStatus;
  label?: string;
  title?: string;
}

export default function StatusPill({ status, label, title }: Props) {
  const modifier = MODIFIERS[status];
  return (
    <span
      className={`kb-chip kb-chip--${modifier}`}
      title={title ?? LABELS[status]}
    >
      {label ?? LABELS[status]}
    </span>
  );
}
