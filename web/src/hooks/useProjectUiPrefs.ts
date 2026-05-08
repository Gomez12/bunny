/**
 * useProjectUiPrefs — sync per-project UI preferences with the server.
 *
 * Fetches from server on mount and on project change. Falls back to localStorage
 * if the fetch fails. Debounces server writes (500 ms). Migration: if the server
 * row is empty and localStorage has values, PUTs them once.
 *
 * Stays backward compatible with existing localStorage key names — writes them
 * too so any code still reading localStorage directly stays consistent.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchProjectUiPrefs,
  updateProjectUiPrefs,
  type ProjectUiPrefs,
} from "../api";

const DEBOUNCE_MS = 500;

function readProjectLocalStorage(project: string): ProjectUiPrefs {
  const out: ProjectUiPrefs = {};

  const cp = localStorage.getItem(`bunny.activeCodeProject.${project}`);
  if (cp) {
    const n = Number(cp);
    if (Number.isFinite(n)) out.activeCodeProjectId = n;
  }

  const dg = localStorage.getItem(`bunny.activeDiagram.${project}`);
  if (dg) {
    const n = Number(dg);
    if (Number.isFinite(n)) out.activeDiagramId = n;
  }

  const wf = localStorage.getItem(`bunny.activeWorkflow.${project}`);
  if (wf) {
    const n = Number(wf);
    if (Number.isFinite(n)) out.activeWorkflowId = n;
  }

  // Support old `bunny.news.hiddenTopics.<project>.<userId>` key format and
  // new `bunny.news.hiddenTopics.<project>` key.
  const prefix = `bunny.news.hiddenTopics.${project}`;
  const hiddenKey =
    localStorage.getItem(prefix) !== null
      ? prefix
      : Object.keys(localStorage).find((k) => k.startsWith(`${prefix}.`));
  if (hiddenKey) {
    try {
      const arr = JSON.parse(localStorage.getItem(hiddenKey)!) as unknown;
      if (Array.isArray(arr) && (arr as unknown[]).every((n) => typeof n === "number")) {
        out.hiddenTopicIds = arr as number[];
      }
    } catch {
      // ignore corrupt entry
    }
  }

  return out;
}

function writeProjectLocalStorage(project: string, prefs: ProjectUiPrefs): void {
  if (prefs.activeCodeProjectId != null)
    localStorage.setItem(
      `bunny.activeCodeProject.${project}`,
      String(prefs.activeCodeProjectId),
    );
  if (prefs.activeDiagramId != null)
    localStorage.setItem(
      `bunny.activeDiagram.${project}`,
      String(prefs.activeDiagramId),
    );
  if (prefs.activeWorkflowId != null)
    localStorage.setItem(
      `bunny.activeWorkflow.${project}`,
      String(prefs.activeWorkflowId),
    );
  // hiddenTopicIds uses the new project-only key (no userId suffix).
  if (prefs.hiddenTopicIds != null)
    localStorage.setItem(
      `bunny.news.hiddenTopics.${project}`,
      JSON.stringify(prefs.hiddenTopicIds),
    );
}

export interface UseProjectUiPrefsResult {
  prefs: ProjectUiPrefs;
  synced: boolean;
  setPref: <K extends keyof ProjectUiPrefs>(
    key: K,
    value: ProjectUiPrefs[K],
  ) => void;
}

export function useProjectUiPrefs(project: string): UseProjectUiPrefsResult {
  const [prefs, setPrefs] = useState<ProjectUiPrefs>(() =>
    readProjectLocalStorage(project),
  );
  const [synced, setSynced] = useState(false);
  const pendingRef = useRef<Partial<ProjectUiPrefs>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSynced(false);
    setPrefs(readProjectLocalStorage(project));

    void (async () => {
      try {
        const serverPrefs = await fetchProjectUiPrefs(project);
        const localPrefs = readProjectLocalStorage(project);
        const isEmpty = Object.keys(serverPrefs).length === 0;

        if (isEmpty && Object.keys(localPrefs).length > 0) {
          const migrated = await updateProjectUiPrefs(project, localPrefs);
          writeProjectLocalStorage(project, migrated);
          setPrefs(migrated);
        } else if (!isEmpty) {
          writeProjectLocalStorage(project, serverPrefs);
          setPrefs(serverPrefs);
        }
      } catch {
        // Stay with localStorage values.
      } finally {
        setSynced(true);
      }
    })();
  }, [project]);

  const setPref = useCallback(
    <K extends keyof ProjectUiPrefs>(key: K, value: ProjectUiPrefs[K]) => {
      // Write localStorage immediately for backward compat.
      if (key === "activeCodeProjectId" && typeof value === "number")
        localStorage.setItem(`bunny.activeCodeProject.${project}`, String(value));
      if (key === "activeDiagramId" && typeof value === "number")
        localStorage.setItem(`bunny.activeDiagram.${project}`, String(value));
      if (key === "activeWorkflowId" && typeof value === "number")
        localStorage.setItem(`bunny.activeWorkflow.${project}`, String(value));
      if (key === "hiddenTopicIds" && Array.isArray(value))
        localStorage.setItem(
          `bunny.news.hiddenTopics.${project}`,
          JSON.stringify(value),
        );

      setPrefs((prev) => ({ ...prev, [key]: value }));
      pendingRef.current = { ...pendingRef.current, [key]: value };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        const patch = pendingRef.current;
        pendingRef.current = {};
        try {
          await updateProjectUiPrefs(project, patch);
        } catch {
          // Silenced — localStorage already updated.
        }
      }, DEBOUNCE_MS);
    },
    [project],
  );

  return { prefs, synced, setPref };
}
