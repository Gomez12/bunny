/**
 * Bell button rendered inside the sidebar user chip. Exposes the unread
 * count via a small badge; the badge stays visible even when the rail is
 * collapsed (overriding `.nav__user`'s hover-only opacity) because that is
 * the whole point of an at-a-glance unread counter.
 *
 * Clicking toggles the NotificationPanel; the first click also asks the OS
 * for notification permission (both the Web API and tauri-plugin-notification
 * require a user gesture).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellRing } from "../lib/icons";
import type { NotificationDto } from "../api";
import NotificationPanel from "./NotificationPanel";

interface Props {
  items: NotificationDto[];
  unreadCount: number;
  hasMore: boolean;
  onMarkRead: (id: number) => Promise<void>;
  onMarkAllRead: () => Promise<void>;
  onDismiss: (id: number) => Promise<void>;
  onLoadMore: () => Promise<void>;
  onRequestPermission: () => void;
  /** Called when a row is clicked with a deep-link; the caller navigates to
   *  the right tab + session. */
  onNavigate: (deepLink: string) => void;
}

export default function NotificationBell({
  items,
  unreadCount,
  hasMore,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
  onLoadMore,
  onRequestPermission,
  onNavigate,
}: Props) {
  const [open, setOpen] = useState(false);
  const askedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const badge = useMemo(() => {
    if (unreadCount <= 0) return null;
    return unreadCount > 9 ? "9+" : String(unreadCount);
  }, [unreadCount]);

  function handleToggle() {
    setOpen((v) => !v);
    if (!askedRef.current) {
      askedRef.current = true;
      onRequestPermission();
    }
  }

  return (
    <div ref={rootRef} className="notifications">
      <button
        type="button"
        className={`notifications__bell ${unreadCount > 0 ? "notifications__bell--pulse" : ""}`}
        onClick={handleToggle}
        aria-label={
          unreadCount > 0
            ? `Notifications (${unreadCount} unread)`
            : "Notifications"
        }
        title={
          unreadCount > 0
            ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
            : "Notifications"
        }
      >
        {unreadCount > 0 ? (
          <BellRing size={14} strokeWidth={1.75} />
        ) : (
          <Bell size={14} strokeWidth={1.75} />
        )}
        {badge && <span className="notifications__badge">{badge}</span>}
      </button>
      {open && (
        <NotificationPanel
          items={items}
          unreadCount={unreadCount}
          hasMore={hasMore}
          onMarkRead={onMarkRead}
          onMarkAllRead={onMarkAllRead}
          onDismiss={onDismiss}
          onLoadMore={onLoadMore}
          onNavigate={(link) => {
            setOpen(false);
            onNavigate(link);
          }}
        />
      )}
    </div>
  );
}
