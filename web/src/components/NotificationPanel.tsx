/**
 * Dropdown panel that surfaces the notification list. Anchored by the bell
 * button via CSS absolute positioning. Each row click marks the row read
 * and fires the parent's `onNavigate` deep-link handler.
 */

import { AtSign, AlertCircle, Check, Trash2 } from "../lib/icons";
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
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === "mention_blocked") {
    return <AlertCircle size={16} strokeWidth={1.75} />;
  }
  return <AtSign size={16} strokeWidth={1.75} />;
}

export default function NotificationPanel({
  items,
  unreadCount,
  hasMore,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
  onLoadMore,
  onNavigate,
}: Props) {
  const hasItems = items.length > 0;

  return (
    <div
      className="notifications__panel"
      role="dialog"
      aria-label="Notifications"
    >
      <header className="notifications__panel-header">
        <span className="notifications__panel-title">Notifications</span>
        {unreadCount > 0 && (
          <button
            type="button"
            className="notifications__panel-link"
            onClick={() => void onMarkAllRead()}
          >
            Mark all read
          </button>
        )}
      </header>

      {hasItems ? (
        <ul className="notifications__list">
          {items.map((n) => {
            const unread = n.readAt == null;
            return (
              <li
                key={n.id}
                className={`notifications__item ${unread ? "notifications__item--unread" : ""}`}
              >
                <button
                  type="button"
                  className="notifications__row"
                  onClick={() => {
                    if (unread) void onMarkRead(n.id);
                    if (n.deepLink) onNavigate(n.deepLink);
                  }}
                  aria-label={`${n.title}, ${relativeTime(n.createdAt)}`}
                >
                  <span className="notifications__row-icon">
                    <KindIcon kind={n.kind} />
                  </span>
                  <span className="notifications__row-main">
                    <span className="notifications__row-title">{n.title}</span>
                    {n.body && (
                      <span className="notifications__row-body">{n.body}</span>
                    )}
                    <span className="notifications__row-meta">
                      {relativeTime(n.createdAt)}
                      {n.project ? ` · ${n.project}` : ""}
                    </span>
                  </span>
                </button>
                <div className="notifications__row-actions">
                  {unread && (
                    <button
                      type="button"
                      className="notifications__row-action"
                      title="Mark read"
                      aria-label="Mark read"
                      onClick={() => void onMarkRead(n.id)}
                    >
                      <Check size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="notifications__row-action"
                    title="Dismiss"
                    aria-label="Dismiss"
                    onClick={() => void onDismiss(n.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="notifications__empty">You're all caught up.</div>
      )}

      {hasMore && (
        <footer className="notifications__panel-footer">
          <button
            type="button"
            className="notifications__panel-link"
            onClick={() => void onLoadMore()}
          >
            Load more
          </button>
        </footer>
      )}
    </div>
  );
}
