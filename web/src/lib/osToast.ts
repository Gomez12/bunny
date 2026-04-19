/**
 * OS-level toast shim.
 *
 * Feature-detects the Tauri runtime (`window.__TAURI__` is set when
 * `withGlobalTauri: true` is configured in tauri.conf.json) and routes to
 * the native notification plugin there. In plain browsers / PWAs falls back
 * to the Web Notification API.
 *
 * Permission is never requested on its own schedule — call
 * `osToast.requestPermission()` from a user-gesture handler (bell click,
 * mark-all-read, row click). Both the Web Notification API and
 * `tauri-plugin-notification` need a gesture on desktop browsers and some
 * mobile engines.
 *
 * Silent no-op when permission is denied. Never throws — the caller can
 * `void osToast({ … })` without guards.
 */

interface OsToastInput {
  title: string;
  body?: string;
  /** Optional click handler. In Tauri there is no webview-level click
   *  callback for native notifications yet; this is only wired for the
   *  Web Notification path. */
  onClick?: () => void;
}

type TauriNotificationModule = {
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<"granted" | "denied" | "default">;
  sendNotification: (opts: { title: string; body?: string }) => void;
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

let tauriMod: Promise<TauriNotificationModule | null> | null = null;

function loadTauri(): Promise<TauriNotificationModule | null> {
  if (!tauriMod) {
    tauriMod = isTauri()
      ? import("@tauri-apps/plugin-notification")
          .then((m) => m as unknown as TauriNotificationModule)
          .catch(() => null)
      : Promise.resolve(null);
  }
  return tauriMod;
}

async function ensurePermission(): Promise<boolean> {
  if (isTauri()) {
    const mod = await loadTauri();
    if (!mod) return false;
    if (await mod.isPermissionGranted()) return true;
    const res = await mod.requestPermission();
    return res === "granted";
  }
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
    if (isTauri()) {
      const mod = await loadTauri();
      if (!mod) return;
      if (!(await mod.isPermissionGranted())) return; // don't prompt silently
      mod.sendNotification({ title: input.title, body: input.body });
      return;
    }
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
  isTauri: () => boolean;
} = Object.assign(show, {
  requestPermission: ensurePermission,
  isTauri,
});
