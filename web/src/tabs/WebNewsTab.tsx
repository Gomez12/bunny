import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectUiPrefs } from "../hooks/useProjectUiPrefs";
import { useUiPrefs } from "../hooks/useUiPrefs";
import {
  createNewsTopic,
  deleteNewsTopic,
  fetchNewsItems,
  fetchNewsReactions,
  fetchNewsTopics,
  regenerateNewsTopicTerms,
  removeNewsReaction,
  runNewsTopicNow,
  setNewsReaction,
  updateNewsTopic,
  type AuthUser,
  type NewsItem,
  type NewsTopic,
  type NewsReaction,
} from "../api";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import HistoryButton from "../components/HistoryButton";
import TopicDialog, {
  type TopicDialogValue,
} from "../components/TopicDialog";
import FeedDialog from "../components/news/FeedDialog";
import SiteDialog from "../components/news/SiteDialog";
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
  Rss,
  Globe,
} from "../lib/icons";

type TemplateId = "list" | "newspaper";

const TEMPLATES: Array<{ id: TemplateId; label: string }> = [
  { id: "list", label: "List" },
  { id: "newspaper", label: "Newspaper" },
];

const TEMPLATE_STORAGE_KEY = "bunny.webNews.template";
const POLL_INTERVAL_MS = 5_000;

function loadHiddenTopics(project: string, userId: string): Set<number> {
  try {
    const raw = localStorage.getItem(`bunny.news.hiddenTopics.${project}.${userId}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((n): n is number => typeof n === "number"));
  } catch {
    return new Set();
  }
}

function saveHiddenTopics(project: string, userId: string, hidden: Set<number>) {
  localStorage.setItem(`bunny.news.hiddenTopics.${project}.${userId}`, JSON.stringify([...hidden]));
}

type Props = {
  project: string;
  currentUser: AuthUser;
};

type DialogState =
  | { kind: "closed" }
  | { kind: "create-topic" }
  | { kind: "create-feed" }
  | { kind: "create-site" }
  | { kind: "edit"; topic: NewsTopic };

function topicTypeBadge(t: NewsTopic): React.ReactNode {
  if (t.topicType === "rss_feed") {
    return <span className="news-type-badge news-type-badge--rss" title="RSS/Atom feed"><Rss size={10} /> RSS</span>;
  }
  if (t.topicType === "site_monitor") {
    return <span className="news-type-badge news-type-badge--site" title="Site monitor"><Globe size={10} /> Site</span>;
  }
  return null;
}

function readStoredTemplate(): TemplateId {
  const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
  return raw === "newspaper" ? "newspaper" : "list";
}

export default function WebNewsTab({ project, currentUser }: Props) {
  const { prefs: projectPrefs, setPref: setProjectPref } = useProjectUiPrefs(project);
  const { prefs: globalPrefs, setPref: setGlobalPref } = useUiPrefs();

  const [topics, setTopics] = useState<NewsTopic[]>([]);
  const [items, setItems] = useState<NewsItem[]>([]);
  const [template, setTemplateRaw] = useState<TemplateId>(() =>
    globalPrefs.newsTemplate ?? readStoredTemplate(),
  );
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmDeleteTopic, setConfirmDeleteTopic] = useState<NewsTopic | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [hiddenTopicIds, setHiddenTopicIds] = useState<Set<number>>(
    () => new Set(projectPrefs.hiddenTopicIds ?? loadHiddenTopics(project, currentUser.id)),
  );

  // Reset hidden topics when project changes.
  useEffect(() => {
    const fromServer = projectPrefs.hiddenTopicIds;
    setHiddenTopicIds(
      fromServer != null
        ? new Set(fromServer)
        : loadHiddenTopics(project, currentUser.id),
    );
  }, [project, currentUser.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Adopt server-preferred news template once it arrives.
  useEffect(() => {
    if (globalPrefs.newsTemplate) {
      setTemplateRaw(globalPrefs.newsTemplate);
    }
  }, [globalPrefs.newsTemplate]);

  const toggleTopicVisibility = (topicId: number) => {
    setHiddenTopicIds((prev) => {
      const next = new Set(prev);
      if (next.has(topicId)) {
        next.delete(topicId);
      } else {
        next.add(topicId);
      }
      saveHiddenTopics(project, currentUser.id, next);
      setProjectPref("hiddenTopicIds", [...next]);
      return next;
    });
  };

  const [reactions, setReactions] = useState<Record<number, NewsReaction>>({});

  const setTemplate = (t: TemplateId) => {
    localStorage.setItem(TEMPLATE_STORAGE_KEY, t);
    setTemplateRaw(t);
    setGlobalPref("newsTemplate", t);
  };

  const refresh = useCallback(async () => {
    try {
      const [t, i, r] = await Promise.all([
        fetchNewsTopics(project),
        fetchNewsItems(project, { limit: 200 }),
        fetchNewsReactions(project),
      ]);
      setTopics(t);
      setItems(i);
      setReactions(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project]);

  const handleReact = async (itemId: number, reaction: NewsReaction | null) => {
    // Optimistic update
    setReactions((prev) => {
      const next = { ...prev };
      if (reaction === null) {
        delete next[itemId];
      } else {
        next[itemId] = reaction;
      }
      return next;
    });
    try {
      if (reaction === null) {
        await removeNewsReaction(project, itemId);
      } else {
        await setNewsReaction(project, itemId, reaction);
      }
    } catch {
      // Revert on error
      void refresh();
    }
  };

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

  const handleFeedOrSiteDone = async () => {
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

  // Items shown in the news view: topic must be system-enabled AND user-visible.
  const visibleItems = useMemo(() => {
    const enabledIds = new Set(enabledTopics.map((t) => t.id));
    return items.filter(
      (i) => enabledIds.has(i.topicId) && !hiddenTopicIds.has(i.topicId),
    );
  }, [items, enabledTopics, hiddenTopicIds]);

  // Sidebar shows all topics that have any items (regardless of user-hidden state),
  // plus topics that have never been run yet. Use all items (not just visibleItems)
  // so hidden topics still appear in the sidebar and can be re-enabled.
  const sidebarTopics = useMemo(() => {
    const enabledIds = new Set(enabledTopics.map((t) => t.id));
    const topicsWithAnyItems = new Set(
      items.filter((i) => enabledIds.has(i.topicId)).map((i) => i.topicId),
    );
    return topics.filter((t) => topicsWithAnyItems.has(t.id) || !t.lastRunAt);
  }, [topics, items, enabledTopics]);

  return (
    <div className="news-tab">
      <aside className="news-tab__sidebar">
        <header className="news-tab__sidebar-header">
          <h2>Topics</h2>
          <div className="news-tab__add-menu">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => setDialog({ kind: "create-topic" })}
              title="Keyword topic — agent searches the web"
            >
              <Plus size={14} /> Topic
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setDialog({ kind: "create-feed" })}
              title="RSS/Atom feed"
            >
              <Rss size={14} />
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setDialog({ kind: "create-site" })}
              title="Site monitor — check a page for changes"
            >
              <Globe size={14} />
            </button>
          </div>
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
            {sidebarTopics.map((topic) => {
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
                <li
                  key={topic.id}
                  className={`news-tab__topic${hiddenTopicIds.has(topic.id) ? " news-tab__topic--hidden" : ""}`}
                >
                  <div className="news-tab__topic-main">
                    <input
                      type="checkbox"
                      className="news-topic-toggle"
                      checked={!hiddenTopicIds.has(topic.id)}
                      onChange={() => toggleTopicVisibility(topic.id)}
                      title={
                        hiddenTopicIds.has(topic.id)
                          ? "Show in news view"
                          : "Hide from news view"
                      }
                    />
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
                      <strong>
                        {topicTypeBadge(topic)}
                        {topic.name}
                      </strong>
                      <small>
                        {topic.topicType === "rss_feed"
                          ? topic.feedUrl ?? "—"
                          : topic.topicType === "site_monitor"
                            ? topic.siteUrl ?? "—"
                            : `${topic.terms.length} term${topic.terms.length === 1 ? "" : "s"}`}{" "}
                        · {topic.agent}
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
                      {topic.topicType === "keyword_search" && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--xs"
                          onClick={() => handleRegenerate(topic)}
                          title="Regenerate terms on next run"
                        >
                          <RefreshCw size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        onClick={() => setDialog({ kind: "edit", topic })}
                        title="Edit"
                      >
                        <Pencil size={14} />
                      </button>
                      <HistoryButton
                        kind="web_news_topic"
                        entityId={topic.id}
                        entityName={topic.name}
                      />
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
          <NewsTemplateNewspaper items={visibleItems} topics={enabledTopics} reactions={reactions} onReact={handleReact} />
        ) : (
          <NewsTemplateList items={visibleItems} topics={enabledTopics} reactions={reactions} onReact={handleReact} />
        )}
      </section>

      {dialog.kind === "create-topic" && (
        <TopicDialog
          project={project}
          onCancel={() => setDialog({ kind: "closed" })}
          onSubmit={handleCreate}
        />
      )}
      {dialog.kind === "create-feed" && (
        <FeedDialog
          project={project}
          onCancel={() => setDialog({ kind: "closed" })}
          onDone={() => void handleFeedOrSiteDone()}
        />
      )}
      {dialog.kind === "create-site" && (
        <SiteDialog
          project={project}
          onCancel={() => setDialog({ kind: "closed" })}
          onDone={() => void handleFeedOrSiteDone()}
        />
      )}
      {dialog.kind === "edit" && dialog.topic.topicType === "rss_feed" && (
        <FeedDialog
          project={project}
          initial={dialog.topic}
          onCancel={() => setDialog({ kind: "closed" })}
          onDone={() => void handleFeedOrSiteDone()}
        />
      )}
      {dialog.kind === "edit" && dialog.topic.topicType === "site_monitor" && (
        <SiteDialog
          project={project}
          initial={dialog.topic}
          onCancel={() => setDialog({ kind: "closed" })}
          onDone={() => void handleFeedOrSiteDone()}
        />
      )}
      {dialog.kind === "edit" && dialog.topic.topicType === "keyword_search" && (
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
