/**
 * Top-right stack of in-app toasts. Each toast auto-dismisses after 5 s
 * unless the user is hovering. Click-through fires the `onClick` handler
 * (typically a deep-link navigation) and removes the toast.
 */

import { useEffect, useRef } from "react";
import { AtSign, AlertCircle, X } from "../lib/icons";
import type { ToastPayload } from "../hooks/useNotifications";

interface Props {
  toasts: ToastPayload[];
  onDismiss: (id: number) => void;
  onClickToast: (deepLink: string) => void;
}

const AUTO_DISMISS_MS = 5_000;

export default function ToastStack({ toasts, onDismiss, onClickToast }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <Toast
          key={t.id}
          toast={t}
          onDismiss={onDismiss}
          onClickToast={onClickToast}
        />
      ))}
    </div>
  );
}

function Toast({
  toast,
  onDismiss,
  onClickToast,
}: {
  toast: ToastPayload;
  onDismiss: (id: number) => void;
  onClickToast: (deepLink: string) => void;
}) {
  const hoveredRef = useRef(false);
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    function schedule() {
      timeoutId = setTimeout(() => {
        if (hoveredRef.current) {
          schedule();
          return;
        }
        onDismiss(toast.id);
      }, AUTO_DISMISS_MS);
    }
    schedule();
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [toast.id, onDismiss]);

  return (
    <div
      className="toast"
      role="status"
      onMouseEnter={() => {
        hoveredRef.current = true;
      }}
      onMouseLeave={() => {
        hoveredRef.current = false;
      }}
    >
      <button
        type="button"
        className="toast__main"
        onClick={() => {
          if (toast.deepLink) onClickToast(toast.deepLink);
          onDismiss(toast.id);
        }}
      >
        <span className="toast__icon">
          {toast.title.toLowerCase().includes("not delivered") ? (
            <AlertCircle size={16} strokeWidth={1.75} />
          ) : (
            <AtSign size={16} strokeWidth={1.75} />
          )}
        </span>
        <span className="toast__body">
          <span className="toast__title">{toast.title}</span>
          {toast.body && <span className="toast__desc">{toast.body}</span>}
        </span>
      </button>
      <button
        type="button"
        className="toast__close"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
      >
        <X size={12} />
      </button>
    </div>
  );
}
