/**
 * Shared state + polling for entity translations.
 *
 * Each translatable dialog (KB definition, document, contact) drives its
 * language tabstrip from this hook so ordering, polling cadence, and the
 * "Translate now" action stay consistent. The hook does NOT render any UI.
 *
 * Language ordering:
 *   1. `user.preferredLanguage` when it's in `project.languages`.
 *   2. The rest of `project.languages`, preserving the server-provided order.
 *
 * The source tab is highlighted visually (`<LanguageTabs>` uses `sourceLang`),
 * not reordered — users expect their own language first, even if someone else
 * authored the source in a different one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthUser,
  TranslationDto,
  TranslationKind,
} from "../api";
import { fetchTranslations, triggerTranslate } from "../api";
import { resolveActiveLang } from "../lib/resolveActiveLang";

const POLL_MS = 5_000;

export interface UseTranslationsResult {
  loading: boolean;
  /** Server-reported project languages, ordered with the user preference first. */
  languages: string[];
  /** The language currently displayed in the parent UI. */
  activeLang: string;
  setActiveLang: (lang: string) => void;
  /** Full sidecar rows (excludes the source language). */
  translations: TranslationDto[];
  /** The translation row matching `activeLang`, if any. */
  activeTranslation: TranslationDto | undefined;
  /** Is the active tab the entity's source language? */
  isSourceActive: boolean;
  err: string | null;
  /** Triggering = `POST /translations/:kind/:id/:lang` in-flight. */
  triggering: boolean;
  refresh: () => Promise<void>;
  translate: (lang?: string) => Promise<void>;
}

export function useTranslations(
  kind: TranslationKind,
  entityId: number | null,
  projectName: string,
  user: AuthUser | null | undefined,
  originalLang: string | null,
): UseTranslationsResult {
  const [translations, setTranslations] = useState<TranslationDto[]>([]);
  const [rawLanguages, setRawLanguages] = useState<string[]>([]);
  const [defaultLanguage, setDefaultLanguage] = useState<string>("");
  const [activeLang, setActiveLang] = useState<string>(originalLang ?? "");
  const [activeLangInitialised, setActiveLangInitialised] = useState(false);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Re-initialise when the caller swaps entity.
  useEffect(() => {
    setActiveLangInitialised(false);
    setActiveLang(originalLang ?? "");
    setTranslations([]);
    setRawLanguages([]);
    setErr(null);
    setLoading(true);
  }, [entityId, originalLang]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (entityId === null) {
      setLoading(false);
      return;
    }
    try {
      const res = await fetchTranslations(projectName, kind, entityId);
      if (!mountedRef.current) return;
      setTranslations(res.translations);
      setRawLanguages(res.projectLanguages);
      setDefaultLanguage(res.defaultLanguage);
      if (!activeLangInitialised) {
        const initial = resolveActiveLang({
          user: user ?? null,
          project: {
            languages: res.projectLanguages,
            defaultLanguage: res.defaultLanguage,
          },
          entity: { originalLang },
        });
        setActiveLang(initial);
        setActiveLangInitialised(true);
      }
      setErr(null);
    } catch (e) {
      if (mountedRef.current) {
        setErr(e instanceof Error ? e.message : "Failed to load translations");
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [
    entityId,
    projectName,
    kind,
    user,
    originalLang,
    activeLangInitialised,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (entityId === null) return;
    const needsPoll = translations.some(
      (t) => t.status === "pending" || t.status === "translating",
    );
    if (!needsPoll) return;
    const id = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [entityId, translations, refresh]);

  // Reorder languages so the user's preferred language (if supported) comes
  // first. Source language keeps its natural slot — it's visually flagged, not
  // reordered.
  const languages = useMemo(() => {
    if (rawLanguages.length === 0) return [];
    const pref = user?.preferredLanguage ?? null;
    if (!pref || !rawLanguages.includes(pref)) return [...rawLanguages];
    return [pref, ...rawLanguages.filter((l) => l !== pref)];
  }, [rawLanguages, user?.preferredLanguage]);

  const activeTranslation = useMemo(
    () => translations.find((t) => t.lang === activeLang),
    [translations, activeLang],
  );

  const translate = useCallback(
    async (lang?: string) => {
      if (entityId === null) return;
      const target = lang ?? activeLang;
      if (!target || target === originalLang) return;
      setTriggering(true);
      setErr(null);
      try {
        await triggerTranslate(projectName, kind, entityId, target);
        setTranslations((prev) =>
          prev.map((t) =>
            t.lang === target ? { ...t, status: "pending", error: null } : t,
          ),
        );
        await refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Translation request failed");
      } finally {
        setTriggering(false);
      }
    },
    [entityId, projectName, kind, activeLang, originalLang, refresh],
  );

  const isSourceActive =
    originalLang !== null && activeLang === originalLang;

  // defaultLanguage is tracked so consumers can fallback on mount; currently
  // unused publicly but kept in state for future admin affordances.
  void defaultLanguage;

  return {
    loading,
    languages,
    activeLang,
    setActiveLang,
    translations,
    activeTranslation,
    isSourceActive,
    err,
    triggering,
    refresh,
    translate,
  };
}
