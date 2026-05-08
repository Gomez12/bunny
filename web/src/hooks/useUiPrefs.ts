/**
 * useUiPrefs — sync global UI preferences (theme, activeProject, activeTab,
 * newsTemplate) with the server.
 *
 * - Reads from localStorage synchronously on first render (prevents FOUC for
 *   theme and avoids a loading flash for navigation state).
 * - On mount, reconciles with the server (server wins). If the server row is
 *   empty and localStorage has values, pushes them to the server once
 *   (one-time migration from pure-localStorage era).
 * - setPref(key, value): writes localStorage immediately + debounces a server
 *   PUT (500 ms) so rapid changes don't spam the API.
 * - Network failures are silenced — localStorage already reflects the intent.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchGlobalUiPrefs,
  updateGlobalUiPrefs,
  type GlobalUiPrefs,
} from "../api";

const DEBOUNCE_MS = 500;

const LS_KEYS: Record<keyof GlobalUiPrefs, string> = {
  theme: "bunny.theme",
  activeProject: "bunny.activeProject",
  activeTab: "bunny.activeTab",
  newsTemplate: "bunny.webNews.template",
};

function readFromLocalStorage(): GlobalUiPrefs {
  const out: GlobalUiPrefs = {};
  const theme = localStorage.getItem(LS_KEYS.theme);
  if (theme === "light" || theme === "dark") out.theme = theme;
  const ap = localStorage.getItem(LS_KEYS.activeProject);
  if (ap) out.activeProject = ap;
  const tab = localStorage.getItem(LS_KEYS.activeTab);
  if (tab) out.activeTab = tab;
  const tpl = localStorage.getItem(LS_KEYS.newsTemplate);
  if (tpl === "list" || tpl === "newspaper") out.newsTemplate = tpl;
  return out;
}

function writeToLocalStorage(prefs: GlobalUiPrefs): void {
  if (prefs.theme) localStorage.setItem(LS_KEYS.theme, prefs.theme);
  if (prefs.activeProject) localStorage.setItem(LS_KEYS.activeProject, prefs.activeProject);
  if (prefs.activeTab) localStorage.setItem(LS_KEYS.activeTab, prefs.activeTab);
  if (prefs.newsTemplate) localStorage.setItem(LS_KEYS.newsTemplate, prefs.newsTemplate);
}

export interface UseUiPrefsResult {
  prefs: GlobalUiPrefs;
  synced: boolean;
  setPref: <K extends keyof GlobalUiPrefs>(key: K, value: GlobalUiPrefs[K]) => void;
}

export function useUiPrefs(initialServerPrefs?: GlobalUiPrefs): UseUiPrefsResult {
  const [prefs, setPrefs] = useState<GlobalUiPrefs>(() => {
    const local = readFromLocalStorage();
    // If the caller already has server prefs (from the boot fetch), merge them
    // in immediately so there's no second reconcile needed.
    if (initialServerPrefs && Object.keys(initialServerPrefs).length > 0) {
      writeToLocalStorage(initialServerPrefs);
      return { ...local, ...initialServerPrefs };
    }
    return local;
  });
  const [synced, setSynced] = useState(!!initialServerPrefs);
  const pendingRef = useRef<Partial<GlobalUiPrefs>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (initialServerPrefs) return; // already reconciled in useState initialiser

    void (async () => {
      try {
        const serverPrefs = await fetchGlobalUiPrefs();
        const localPrefs = readFromLocalStorage();
        const isEmpty = Object.keys(serverPrefs).length === 0;

        if (isEmpty && Object.keys(localPrefs).length > 0) {
          // Migration: push localStorage values to server once.
          const migrated = await updateGlobalUiPrefs(localPrefs);
          writeToLocalStorage(migrated);
          setPrefs((prev) => ({ ...prev, ...migrated }));
        } else if (!isEmpty) {
          writeToLocalStorage(serverPrefs);
          setPrefs((prev) => ({ ...prev, ...serverPrefs }));
        }
      } catch {
        // Stay with localStorage values.
      } finally {
        setSynced(true);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setPref = useCallback(
    <K extends keyof GlobalUiPrefs>(key: K, value: GlobalUiPrefs[K]) => {
      if (value !== undefined && LS_KEYS[key]) {
        localStorage.setItem(LS_KEYS[key], String(value));
      }
      setPrefs((prev) => ({ ...prev, [key]: value }));
      pendingRef.current = { ...pendingRef.current, [key]: value };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        const patch = pendingRef.current;
        pendingRef.current = {};
        try {
          await updateGlobalUiPrefs(patch);
        } catch {
          // Silenced — localStorage already updated.
        }
      }, DEBOUNCE_MS);
    },
    [],
  );

  return { prefs, synced, setPref };
}
