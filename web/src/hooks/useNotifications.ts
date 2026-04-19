/**
 * useNotifications — owns the notification state for the current user.
 *
 * - Fetches the first page on mount; reconciles incoming SSE events.
 * - Opens `/api/notifications/stream` once and keeps it alive for the
 *   session; cleans up on unmount.
 * - Exposes `markRead`, `markAllRead`, `dismiss`, `loadMore` + an OS-toast
 *   permission helper that is safe to call from any user gesture
 *   (Notification.requestPermission requires one).
 * - Toasts fire ONLY when the target session differs from the one the user
 *   is currently viewing, so pinging someone while they already have the
 *   thread open doesn't spam them.
 *
 * See ADR 0027.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteNotification as apiDelete,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  openNotificationStream,
  type NotificationDto,
  type ServerEvent,
} from "../api";
import { osToast } from "../lib/osToast";

export interface ToastPayload {
  id: number;
  title: string;
  body: string;
  deepLink: string;
}

export interface NotificationsState {
  items: NotificationDto[];
  unreadCount: number;
  loaded: boolean;
  hasMore: boolean;
}

export interface UseNotificationsOpts {
  /** The session the user is currently viewing, if any. When a
   *  `notification_created` event arrives whose `sessionId` matches, the
   *  in-app + OS toasts are suppressed so we don't re-notify on a thread
   *  they're already reading. */
  activeSessionId: string | null;
}

export interface UseNotificationsApi extends NotificationsState {
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismiss: (id: number) => Promise<void>;
  loadMore: () => Promise<void>;
  /** Pop an inline toast + trigger the OS toast. Callers use this for new
   *  SSE-pushed events; polling/refresh paths also call it if they want. */
  toasts: ToastPayload[];
  clearToast: (id: number) => void;
  /** Ask for OS-notification permission. Safe to call from any click handler;
   *  no-ops if already granted / denied. */
  requestOSPermission: () => void;
}

const INITIAL_PAGE_SIZE = 50;

export function useNotifications(
  opts: UseNotificationsOpts,
): UseNotificationsApi {
  const { activeSessionId } = opts;

  const [state, setState] = useState<NotificationsState>({
    items: [],
    unreadCount: 0,
    loaded: false,
    hasMore: false,
  });
  const [toasts, setToasts] = useState<ToastPayload[]>([]);

  const activeSessionRef = useRef<string | null>(activeSessionId);
  useEffect(() => {
    activeSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  const pushToast = useCallback((t: ToastPayload) => {
    setToasts((prev) => [...prev, t]);
  }, []);
  const clearToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const applyCreated = useCallback(
    (n: NotificationDto) => {
      setState((prev) => ({
        ...prev,
        items: mergeUnique([n], prev.items),
        unreadCount: prev.unreadCount + (n.readAt == null ? 1 : 0),
      }));
      if (n.sessionId && activeSessionRef.current === n.sessionId) return;
      pushToast({
        id: n.id,
        title: n.title,
        body: n.body,
        deepLink: n.deepLink,
      });
      void osToast({
        title: n.title,
        body: n.body,
      });
    },
    [pushToast],
  );

  const applyRead = useCallback((ids: number[], readAt: number) => {
    setState((prev) => {
      const all = ids.length === 0;
      const idSet = new Set(ids);
      let decrement = 0;
      const items = prev.items.map((n) => {
        if (n.readAt != null) return n;
        if (!all && !idSet.has(n.id)) return n;
        decrement += 1;
        return { ...n, readAt };
      });
      const unreadCount = all ? 0 : Math.max(0, prev.unreadCount - decrement);
      return { ...prev, items, unreadCount };
    });
  }, []);

  // Initial fetch + SSE subscription.
  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | null = null;

    (async () => {
      try {
        const page = await listNotifications({ limit: INITIAL_PAGE_SIZE });
        if (!alive) return;
        setState({
          items: page.items,
          unreadCount: page.unreadCount,
          loaded: true,
          hasMore: page.items.length === INITIAL_PAGE_SIZE,
        });
      } catch {
        if (!alive) return;
        setState({ items: [], unreadCount: 0, loaded: true, hasMore: false });
      }
    })();

    const { abort } = openNotificationStream((ev: ServerEvent) => {
      if (!alive) return;
      if (ev.type === "notification_created") {
        applyCreated(ev.notification);
      } else if (ev.type === "notification_read") {
        applyRead(ev.ids, ev.readAt);
      }
    });
    unsub = abort;

    return () => {
      alive = false;
      unsub?.();
    };
  }, [applyCreated, applyRead]);

  const markRead = useCallback(async (id: number) => {
    // Optimistic update — the server also broadcasts a notification_read so
    // other tabs see the change.
    setState((prev) => {
      const target = prev.items.find((n) => n.id === id);
      if (!target || target.readAt != null) return prev;
      return {
        ...prev,
        items: prev.items.map((n) =>
          n.id === id ? { ...n, readAt: Date.now() } : n,
        ),
        unreadCount: Math.max(0, prev.unreadCount - 1),
      };
    });
    try {
      await markNotificationRead(id);
    } catch {
      /* stream event will reconcile on next server broadcast */
    }
  }, []);

  const markAllRead = useCallback(async () => {
    const now = Date.now();
    setState((prev) => ({
      ...prev,
      items: prev.items.map((n) =>
        n.readAt == null ? { ...n, readAt: now } : n,
      ),
      unreadCount: 0,
    }));
    try {
      await markAllNotificationsRead();
    } catch {
      /* ignore */
    }
  }, []);

  const dismiss = useCallback(async (id: number) => {
    setState((prev) => {
      const target = prev.items.find((n) => n.id === id);
      const wasUnread = target?.readAt == null;
      return {
        ...prev,
        items: prev.items.filter((n) => n.id !== id),
        unreadCount: wasUnread
          ? Math.max(0, prev.unreadCount - 1)
          : prev.unreadCount,
      };
    });
    try {
      await apiDelete(id);
    } catch {
      /* ignore */
    }
  }, []);

  const loadMore = useCallback(async () => {
    const oldest = state.items[state.items.length - 1];
    if (!oldest) return;
    try {
      const page = await listNotifications({
        limit: INITIAL_PAGE_SIZE,
        before: oldest.id,
      });
      setState((prev) => ({
        ...prev,
        items: mergeUnique(prev.items, page.items),
        unreadCount: page.unreadCount,
        hasMore: page.items.length === INITIAL_PAGE_SIZE,
      }));
    } catch {
      /* ignore */
    }
  }, [state.items]);

  const requestOSPermission = useCallback(() => {
    void osToast.requestPermission();
  }, []);

  return {
    ...state,
    toasts,
    clearToast,
    markRead,
    markAllRead,
    dismiss,
    loadMore,
    requestOSPermission,
  };
}

function mergeUnique(
  first: NotificationDto[],
  second: NotificationDto[],
): NotificationDto[] {
  const seen = new Set<number>();
  const out: NotificationDto[] = [];
  for (const n of first) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  for (const n of second) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}
