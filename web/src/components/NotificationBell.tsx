/**
 * Bell button in the sidebar user chip. Clicking it navigates to the
 * Notifications tab (a full bunny tab with sidebar list + detail pane,
 * see `web/src/tabs/NotificationsTab.tsx`) instead of opening a floating
 * popover — the popover was getting clipped by the overlay boundary.
 *
 * The first click still triggers `onRequestPermission` so the browser
 * permission prompt fires from a real user gesture.
 */

import { useRef } from "react";
import { Bell, BellRing } from "../lib/icons";

interface Props {
  unreadCount: number;
  isActive: boolean;
  onOpen: () => void;
  onRequestPermission: () => void;
}

export default function NotificationBell({
  unreadCount,
  isActive,
  onOpen,
  onRequestPermission,
}: Props) {
  const askedRef = useRef(false);

  const badge =
    unreadCount <= 0 ? null : unreadCount > 9 ? "9+" : String(unreadCount);
  const hasUnread = unreadCount > 0;

  function handleClick() {
    if (!askedRef.current) {
      askedRef.current = true;
      onRequestPermission();
    }
    onOpen();
  }

  return (
    <button
      type="button"
      className={`notifications__bell ${hasUnread ? "notifications__bell--pulse" : ""} ${isActive ? "notifications__bell--active" : ""}`}
      onClick={handleClick}
      aria-label={
        hasUnread
          ? `Notifications (${unreadCount} unread)`
          : "Notifications"
      }
      aria-current={isActive ? "page" : undefined}
      title={
        hasUnread
          ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
          : "Notifications"
      }
    >
      {hasUnread ? (
        <BellRing size={14} strokeWidth={1.75} />
      ) : (
        <Bell size={14} strokeWidth={1.75} />
      )}
      {badge && <span className="notifications__badge">{badge}</span>}
    </button>
  );
}
