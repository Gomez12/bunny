import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Plus, BookOpen, Loader2, Trash2, Mic } from "../lib/icons";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import type { AuthUser } from "../api";
import DiaryEntryView from "./diary/DiaryEntryView";

interface DiaryEntry {
  id: number;
  project: string;
  userId: string;
  title: string;
  audioPath: string | null;
  audioDurationS: number | null;
  audioSizeB: number | null;
  language: string;
  transcription: string | null;
  rawTranscription: string | null;
  transcriptionStatus: string;
  transcriptionError: string | null;
  transcribedAt: number | null;
  correctionStatus: string;
  createdAt: number;
  updatedAt: number;
}

interface Props {
  project: string;
  currentUser: AuthUser;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("nl-NL", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function DiaryTab({
  project,
  currentUser: _currentUser,
}: Props) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<DiaryEntry[]>([]);

  const statusLabel = (status: string): string => {
    switch (status) {
      case "idle":
        return t("tab.diary.status.idle");
      case "transcribing":
        return t("tab.diary.status.transcribing");
      case "done":
        return t("tab.diary.status.done");
      case "error":
        return t("tab.diary.status.error");
      default:
        return status;
    }
  };
  const [loading, setLoading] = useState(true);
  const [activeEntry, setActiveEntry] = useState<DiaryEntry | null>(null);
  const [creating, setCreating] = useState(false);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project)}/diary`,
        { credentials: "include" },
      );
      if (res.ok) {
        const { entries: list } = (await res.json()) as {
          entries: DiaryEntry[];
        };
        setEntries(list);
      }
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    void loadEntries();
    setActiveEntry(null);
  }, [loadEntries]);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project)}/diary`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "" }),
          credentials: "include",
        },
      );
      if (res.ok) {
        const { entry } = (await res.json()) as { entry: DiaryEntry };
        setEntries((prev) => [entry, ...prev]);
        setActiveEntry(entry);
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(t("tab.diary.deleteConfirm"))) return;
    const res = await fetch(`/api/diary/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      setEntries((prev) => prev.filter((en) => en.id !== id));
      if (activeEntry?.id === id) setActiveEntry(null);
    }
  }

  function handleEntryUpdate(updated: DiaryEntry) {
    setEntries((prev) =>
      prev.map((en) => (en.id === updated.id ? updated : en)),
    );
    if (activeEntry?.id === updated.id) setActiveEntry(updated);
  }

  if (activeEntry) {
    return (
      <DiaryEntryView
        entry={activeEntry}
        onBack={() => setActiveEntry(null)}
        onUpdate={handleEntryUpdate}
      />
    );
  }

  return (
    <div className="diary-tab">
      <PageHeader
        title={
          <span className="page-header__title-with-icon">
            <BookOpen size={18} />
            {t("tab.diary.title")}
          </span>
        }
        actions={
          <button
            className="btn btn--send btn--sm"
            onClick={() => void handleCreate()}
            disabled={creating}
          >
            {creating ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Plus size={13} />
            )}
            {t("tab.diary.newEntry")}
          </button>
        }
      />

      {loading ? (
        <div className="diary-tab__loading">
          <Loader2 size={20} className="spin" />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          title={t("tab.diary.emptyTitle")}
          description={t("tab.diary.emptyDescription")}
        />
      ) : (
        <ul className="diary-tab__list">
          {entries.map((en) => (
            <li
              key={en.id}
              className="diary-item"
              role="button"
              tabIndex={0}
              onClick={() => setActiveEntry(en)}
              onKeyDown={(e) => e.key === "Enter" && setActiveEntry(en)}
            >
              <div className="diary-item__icon">
                <Mic size={16} />
              </div>
              <div className="diary-item__body">
                <div className="diary-item__title">
                  {en.title ? (
                    en.title
                  ) : (
                    <span className="diary-item__title--empty">
                      {t("tab.diary.untitled")}
                    </span>
                  )}
                </div>
                <div className="diary-item__meta">
                  <span className="diary-item__date">
                    {formatDate(en.createdAt)}
                  </span>
                  <span
                    className={`diary-badge diary-badge--${en.transcriptionStatus}`}
                  >
                    {statusLabel(en.transcriptionStatus)}
                  </span>
                  <span className="diary-badge diary-badge--lang">
                    {en.language}
                  </span>
                </div>
              </div>
              <button
                className="btn btn--ghost btn--icon btn--sm diary-item__delete"
                title={t("tab.diary.deleteEntryTitle")}
                onClick={(e) => void handleDelete(en.id, e)}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
