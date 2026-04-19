/**
 * Notifications tab — standard bunny two-pane layout (list sidebar + detail
 * pane) replacing the earlier popover that was getting clipped by the main
 * content area.
 *
 * State (items, unreadCount, hasMore, …) lives in `useNotifications` at the
 * App shell level; this tab is purely a consumer + renderer. Clicking a row
 * marks it read and selects it; the detail pane exposes an "Open
 * conversation" CTA that navigates the deep-link.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, AtSign, Check, ExternalLink, Trash2 } from "../lib/icons";
import EmptyState from "../components/EmptyState";
import type { NotificationDto } from "../api";

interface Props {
  items: NotificationDto[];
  unreadCount: number;
  hasMore: boolean;
  onMarkRead: (id: number) => Promise<void>;
  onMarkAllRead: () => Promise<void>;
  onDismiss: (id: number) => Promise<void>;
  onLoadMore: () => Promise<void>;
  onNavigate: (deepLink: string) => void;
  /** Pass-through so that panel interactions count as a user gesture for the
   *  browser's Notification.requestPermission prompt. */
  onRequestPermission: () => void;
}

function fullTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function kindIcon(kind: string) {
  if (kind === "mention_blocked") {
    return <AlertCircle size={16} strokeWidth={1.75} />;
  }
  return <AtSign size={16} strokeWidth={1.75} />;
}

function kindLabel(kind: string): string {
  if (kind === "mention") return "Mention";
  if (kind === "mention_blocked") return "Mention not delivered";
  return kind;
}

export default function NotificationsTab({
  items,
  unreadCount,
  hasMore,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
  onLoadMore,
  onNavigate,
  onRequestPermission,
}: Props) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [filter, setFilter] = useState<"all" | "unread">("all");

  // Request OS-notification permission on first interaction with the tab.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (asked) return;
    setAsked(true);
    onRequestPermission();
  }, [asked, onRequestPermission]);

  const filtered = useMemo(
    () =>
      filter === "unread" ? items.filter((n) => n.readAt == null) : items,
    [filter, items],
  );

  // Auto-select the first item when nothing is selected, or when the
  // previously-selected row was dismissed. Keep the selection sticky otherwise
  // so a new incoming notification doesn't yank the user to it.
  useEffect(() => {
    if (filtered.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (activeId === null || !filtered.some((n) => n.id === activeId)) {
      setActiveId(filtered[0]!.id);
    }
  }, [filtered, activeId]);

  const active = useMemo(
    () => items.find((n) => n.id === activeId) ?? null,
    [items, activeId],
  );

  async function handleSelect(n: NotificationDto) {
    setActiveId(n.id);
    if (n.readAt == null) {
      await onMarkRead(n.id).catch(() => undefined);
    }
  }

  return (
    <div className="notif-tab">
      <aside className="notif-tab__list" aria-label="Notifications">
        <header className="notif-tab__list-header">
          <div className="notif-tab__list-title">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <span className="notif-tab__count">{unreadCount}</span>
            )}
          </div>
          {unreadCount > 0 && (
            <button
              type="button"
              className="notif-tab__list-action"
              onClick={() => void onMarkAllRead()}
            >
              Mark all read
            </button>
          )}
        </header>

        <div className="notif-tab__filter" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={filter === "all"}
            className={`notif-tab__filter-btn ${filter === "all" ? "notif-tab__filter-btn--active" : ""}`}
            onClick={() => setFilter("all")}
          >
            All
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "unread"}
            className={`notif-tab__filter-btn ${filter === "unread" ? "notif-tab__filter-btn--active" : ""}`}
            onClick={() => setFilter("unread")}
          >
            Unread
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="notif-tab__list-empty">
            {filter === "unread"
              ? "No unread notifications."
              : "You're all caught up."}
          </div>
        ) : (
          <ul className="notif-tab__list-items">
            {filtered.map((n) => {
              const unread = n.readAt == null;
              const isActive = n.id === activeId;
              return (
                <li
                  key={n.id}
                  className={`notif-tab__item ${isActive ? "notif-tab__item--active" : ""} ${unread ? "notif-tab__item--unread" : ""}`}
                >
                  <button
                    type="button"
                    className="notif-tab__item-btn"
                    onClick={() => void handleSelect(n)}
                  >
                    <span className="notif-tab__item-icon">
                      {kindIcon(n.kind)}
                    </span>
                    <span className="notif-tab__item-main">
                      <span className="notif-tab__item-title">{n.title}</span>
                      {n.body && (
                        <span className="notif-tab__item-body">{n.body}</span>
                      )}
                      <span className="notif-tab__item-meta">
                        {relativeTime(n.createdAt)}
                        {n.project ? ` · ${n.project}` : ""}
                      </span>
                    </span>
                    {unread && (
                      <span
                        className="notif-tab__item-dot"
                        aria-label="Unread"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {hasMore && (
          <footer className="notif-tab__list-footer">
            <button
              type="button"
              className="notif-tab__list-action"
              onClick={() => void onLoadMore()}
            >
              Load more
            </button>
          </footer>
        )}
      </aside>

      <main className="notif-tab__detail">
        {active ? (
          <NotificationDetail
            notification={active}
            onNavigate={onNavigate}
            onMarkRead={onMarkRead}
            onDismiss={onDismiss}
          />
        ) : (
          <div className="notif-tab__detail-empty">
            <EmptyState
              title="You're all caught up"
              description="When someone mentions you in a chat, it shows up here."
            />
          </div>
        )}
      </main>
    </div>
  );
}

interface DetailProps {
  notification: NotificationDto;
  onNavigate: (deepLink: string) => void;
  onMarkRead: (id: number) => Promise<void>;
  onDismiss: (id: number) => Promise<void>;
}

function NotificationDetail({
  notification: n,
  onNavigate,
  onMarkRead,
  onDismiss,
}: DetailProps) {
  const actorName = n.actorDisplayName || n.actorUsername || "unknown";
  const unread = n.readAt == null;

  return (
    <article className="notif-tab__article">
      <header className="notif-tab__article-header">
        <div className="notif-tab__article-kind">
          {kindIcon(n.kind)}
          <span>{kindLabel(n.kind)}</span>
        </div>
        <div className="notif-tab__article-actions">
          {unread && (
            <button
              type="button"
              className="notif-tab__article-action"
              onClick={() => void onMarkRead(n.id)}
              title="Mark read"
              aria-label="Mark read"
            >
              <Check size={14} /> <span>Mark read</span>
            </button>
          )}
          <button
            type="button"
            className="notif-tab__article-action notif-tab__article-action--danger"
            onClick={() => void onDismiss(n.id)}
            title="Dismiss"
            aria-label="Dismiss"
          >
            <Trash2 size={14} /> <span>Dismiss</span>
          </button>
        </div>
      </header>

      <h2 className="notif-tab__article-title">{n.title}</h2>

      {n.body && <p className="notif-tab__article-body">{n.body}</p>}

      <dl className="notif-tab__article-meta">
        {n.actorUsername && (
          <>
            <dt>From</dt>
            <dd>
              {actorName}
              {n.actorUsername !== actorName && (
                <span className="notif-tab__article-muted">
                  {" "}
                  @{n.actorUsername}
                </span>
              )}
            </dd>
          </>
        )}
        {n.project && (
          <>
            <dt>Project</dt>
            <dd>{n.project}</dd>
          </>
        )}
        <dt>When</dt>
        <dd>
          {relativeTime(n.createdAt)}{" "}
          <span className="notif-tab__article-muted">
            · {fullTimestamp(n.createdAt)}
          </span>
        </dd>
      </dl>

      {n.deepLink && (
        <div className="notif-tab__article-cta">
          <button
            type="button"
            className="notif-tab__primary"
            onClick={() => onNavigate(n.deepLink)}
          >
            <ExternalLink size={14} />
            <span>
              {n.kind === "mention_blocked"
                ? "Open the conversation"
                : "Open conversation"}
            </span>
          </button>
        </div>
      )}
    </article>
  );
}
