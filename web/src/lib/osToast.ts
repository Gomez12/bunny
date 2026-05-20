/**
 * OS-level toast shim.
 *
 * Uses the Web Notification API in both plain browsers and the Electron
 * desktop client (Chromium provides the same `window.Notification` surface
 * there).
 *
 * Permission is never requested on its own schedule — call
 * `osToast.requestPermission()` from a user-gesture handler (bell click,
 * mark-all-read, row click). The Web Notification API needs a gesture on
 * desktop browsers and some mobile engines.
 *
 * Silent no-op when permission is denied. Never throws — the caller can
 * `void osToast({ … })` without guards.
 */

interface OsToastInput {
  title: string;
  body?: string;
  /** Optional click handler wired to the Web Notification's `onclick`. */
  onClick?: () => void;
}

async function ensurePermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    const res = await Notification.requestPermission();
    return res === "granted";
  } catch {
    return false;
  }
}

async function show(input: OsToastInput): Promise<void> {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const n = new Notification(input.title, { body: input.body });
    if (input.onClick) {
      n.onclick = () => {
        input.onClick?.();
        n.close();
      };
    }
  } catch {
    /* never throw */
  }
}

export const osToast: ((input: OsToastInput) => Promise<void>) & {
  requestPermission: () => Promise<boolean>;
} = Object.assign(show, {
  requestPermission: ensurePermission,
});
