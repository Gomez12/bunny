import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createNewsTopic,
  deleteNewsTopic,
  fetchNewsItems,
  fetchNewsTopics,
  regenerateNewsTopicTerms,
  runNewsTopicNow,
  updateNewsTopic,
  type AuthUser,
  type NewsItem,
  type NewsTopic,
} from "../api";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import TopicDialog, {
  type TopicDialogValue,
} from "../components/TopicDialog";
import NewsTemplateList from "../components/news/NewsTemplateList";
import NewsTemplateNewspaper from "../components/news/NewsTemplateNewspaper";
import {
  Play,
  Pencil,
  Trash2,
  RefreshCw,
  Plus,
  Loader2,
  AlertCircle,
} from "../lib/icons";

type TemplateId = "list" | "newspaper";

const TEMPLATES: Array<{ id: TemplateId; label: string }> = [
  { id: "list", label: "List" },
  { id: "newspaper", label: "Newspaper" },
];

const TEMPLATE_STORAGE_KEY = "bunny.webNews.template";
const POLL_INTERVAL_MS = 5_000;

type Props = {
  project: string;
  currentUser: AuthUser;
};

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; topic: NewsTopic };

function readStoredTemplate(): TemplateId {
  const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
  return raw === "newspaper" ? "newspaper" : "list";
}

export default function WebNewsTab({ project, currentUser }: Props) {
  const [topics, setTopics] = useState<NewsTopic[]>([]);
  const [items, setItems] = useState<NewsItem[]>([]);
  const [template, setTemplateRaw] = useState<TemplateId>(readStoredTemplate);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmDeleteTopic, setConfirmDeleteTopic] = useState<NewsTopic | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setTemplate = (t: TemplateId) => {
    localStorage.setItem(TEMPLATE_STORAGE_KEY, t);
    setTemplateRaw(t);
  };

  const refresh = useCallback(async () => {
    try {
      const [t, i] = await Promise.all([
        fetchNewsTopics(project),
        fetchNewsItems(project, { limit: 200 }),
      ]);
      setTopics(t);
      setItems(i);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Lightweight polling while any topic is running. Stops when everything idles.
  useEffect(() => {
    const anyRunning = topics.some((t) => t.runStatus === "running");
    if (!anyRunning) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    if (pollTimerRef.current) return;
    pollTimerRef.current = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [topics, refresh]);

  const handleCreate = async (value: TopicDialogValue) => {
    await createNewsTopic(project, value);
    setDialog({ kind: "closed" });
    await refresh();
  };

  const handleEdit = async (topic: NewsTopic, value: TopicDialogValue) => {
    await updateNewsTopic(project, topic.id, value);
    setDialog({ kind: "closed" });
    await refresh();
  };

  const handleDelete = (topic: NewsTopic) => {
    setConfirmDeleteTopic(topic);
  };

  const confirmDeleteTopicAction = async () => {
    const topic = confirmDeleteTopic;
    setConfirmDeleteTopic(null);
    if (!topic) return;
    await deleteNewsTopic(project, topic.id);
    await refresh();
  };

  const handleRunNow = async (topic: NewsTopic) => {
    try {
      await runNewsTopicNow(project, topic.id);
      // Optimistic flip to running so the status dot updates before poll kicks in.
      setTopics((curr) =>
        curr.map((t) =>
          t.id === topic.id ? { ...t, runStatus: "running" as const } : t,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRegenerate = async (topic: NewsTopic) => {
    try {
      await regenerateNewsTopicTerms(project, topic.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const enabledTopics = useMemo(
    () => topics.filter((t) => t.enabled),
    [topics],
  );
  const visibleItems = useMemo(() => {
    const enabledIds = new Set(enabledTopics.map((t) => t.id));
    return items.filter((i) => enabledIds.has(i.topicId));
  }, [items, enabledTopics]);

  return (
    <div className="news-tab">
      <aside className="news-tab__sidebar">
        <header className="news-tab__sidebar-header">
          <h2>Topics</h2>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => setDialog({ kind: "create" })}
          >
            <Plus size={14} /> New topic
          </button>
        </header>

        {loading ? (
          <div className="news-tab__loading">
            <Loader2 size={16} /> Loading…
          </div>
        ) : topics.length === 0 ? (
          <EmptyState
            size="sm"
            title="No topics yet"
            description="Create a topic to let an agent periodically gather news about it."
          />
        ) : (
          <ul className="news-tab__topics">
            {topics.map((topic) => {
              const canEdit =
                currentUser.role === "admin" ||
                topic.createdBy === currentUser.id;
              const statusClass =
                topic.runStatus === "running"
                  ? "news-status-dot--running"
                  : topic.lastRunStatus === "error"
                    ? "news-status-dot--error"
                    : "news-status-dot--idle";
              return (
                <li key={topic.id} className="news-tab__topic">
                  <div className="news-tab__topic-main">
                    <span
                      className={`news-status-dot ${statusClass}`}
                      title={
                        topic.runStatus === "running"
                          ? "Running…"
                          : topic.lastRunStatus === "error"
                            ? "Last run failed"
                            : "Idle"
                      }
                    />
                    <div className="news-tab__topic-text">
                      <strong>{topic.name}</strong>
                      <small>
                        {topic.terms.length} term
                        {topic.terms.length === 1 ? "" : "s"} · {topic.agent}
                      </small>
                      {topic.lastRunAt && (
                        <small>
                          last run{" "}
                          {new Date(topic.lastRunAt).toLocaleString()}
                        </small>
                      )}
                      {topic.lastRunError && (
                        <small className="news-tab__topic-error">
                          <AlertCircle size={12} /> {topic.lastRunError}
                        </small>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="news-tab__topic-actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        onClick={() => handleRunNow(topic)}
                        disabled={topic.runStatus === "running"}
                        title="Run now"
                      >
                        <Play size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        onClick={() => handleRegenerate(topic)}
                        title="Regenerate terms on next run"
                      >
                        <RefreshCw size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        onClick={() => setDialog({ kind: "edit", topic })}
                        title="Edit"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        onClick={() => handleDelete(topic)}
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className="news-tab__main">
        <header className="news-tab__header">
          <h1>News</h1>
          <div className="news-tab__template-picker" role="tablist">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`btn btn--ghost btn--sm ${
                  template === t.id ? "btn--active" : ""
                }`}
                onClick={() => setTemplate(t.id)}
                aria-pressed={template === t.id}
              >
                {t.label}
              </button>
            ))}
          </div>
        </header>

        {error && (
          <div className="news-tab__error">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        {visibleItems.length === 0 ? (
          <EmptyState
            title="No news yet"
            description={
              topics.length === 0
                ? "Create a topic and run it to see items here."
                : "Click the ▶ button on a topic to fetch the first batch."
            }
          />
        ) : template === "newspaper" ? (
          <NewsTemplateNewspaper items={visibleItems} topics={enabledTopics} />
        ) : (
          <NewsTemplateList items={visibleItems} topics={enabledTopics} />
        )}
      </section>

      {dialog.kind === "create" && (
        <TopicDialog
          project={project}
          onCancel={() => setDialog({ kind: "closed" })}
          onSubmit={handleCreate}
        />
      )}
      {dialog.kind === "edit" && (
        <TopicDialog
          project={project}
          initial={dialog.topic}
          onCancel={() => setDialog({ kind: "closed" })}
          onSubmit={(v) => handleEdit(dialog.topic, v)}
        />
      )}

      <ConfirmDialog
        open={confirmDeleteTopic !== null}
        message={`Delete topic "${confirmDeleteTopic?.name}"? This also removes its items.`}
        confirmLabel="Delete"
        onConfirm={() => void confirmDeleteTopicAction()}
        onCancel={() => setConfirmDeleteTopic(null)}
      />
    </div>
  );
}
