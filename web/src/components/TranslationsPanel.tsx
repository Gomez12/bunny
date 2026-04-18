/**
 * Translations panel. Drops into any entity dialog (KB definition, document,
 * contact, board card) as a section below the source-editable form.
 *
 * - Shows `<LanguageTabs>` with the entity's `originalLang` marked "Source"
 *   and all other project languages as translation tabs.
 * - When the active tab is the source, renders a subtle hint that the form
 *   above owns the editable copy.
 * - When the active tab is a translation, renders the sidecar row's fields
 *   read-only (using `<MarkdownContent>` for long `content_md` documents,
 *   plain pre-wrapped text otherwise) plus a "Translate now" button that
 *   flips the row back to `pending` and nudges the scheduler.
 *
 * Polling: while any translation is in `pending` or `translating`, we refresh
 * the translations list every 5 seconds so the UI reflects the scheduler's
 * progress without needing a project-scope SSE broadcast.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthUser,
  TranslationDto,
  TranslationKind,
} from "../api";
import { fetchTranslations, triggerTranslate } from "../api";
import { resolveActiveLang } from "../lib/resolveActiveLang";
import LanguageTabs from "./LanguageTabs";
import MarkdownContent from "./MarkdownContent";

interface Props {
  kind: TranslationKind;
  entityId: number;
  projectName: string;
  currentUser: AuthUser;
  originalLang: string;
  /** When true, the active tab starts on the user's preferred language
   *  instead of the source. Matches the design-default #5 from the plan. */
  initialLangFromPreference?: boolean;
  /** Optional: renders fields with markdown when the sidecar field name
   *  matches — e.g. `content_md` for documents. */
  markdownFields?: readonly string[];
}

const POLL_MS = 5000;

export default function TranslationsPanel({
  kind,
  entityId,
  projectName,
  currentUser,
  originalLang,
  initialLangFromPreference = true,
  markdownFields = [],
}: Props) {
  const [translations, setTranslations] = useState<TranslationDto[]>([]);
  const [projectLanguages, setProjectLanguages] = useState<string[]>([originalLang]);
  const [activeLang, setActiveLang] = useState<string>(originalLang);
  const [activeLangInitialised, setActiveLangInitialised] = useState(false);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetchTranslations(projectName, kind, entityId);
      if (!mountedRef.current) return;
      setTranslations(res.translations);
      setProjectLanguages(res.projectLanguages);
      if (!activeLangInitialised && initialLangFromPreference) {
        setActiveLang(
          resolveActiveLang({
            user: currentUser,
            project: {
              languages: res.projectLanguages,
              defaultLanguage: res.defaultLanguage,
            },
            entity: { originalLang },
          }),
        );
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
    projectName,
    kind,
    entityId,
    activeLangInitialised,
    initialLangFromPreference,
    currentUser,
    originalLang,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while any translation is transient.
  useEffect(() => {
    const needsPoll = translations.some(
      (t) => t.status === "pending" || t.status === "translating",
    );
    if (!needsPoll) return;
    const id = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [translations, refresh]);

  const activeTranslation = useMemo(
    () => translations.find((t) => t.lang === activeLang),
    [translations, activeLang],
  );

  const isSourceActive = activeLang === originalLang;

  const handleTranslate = async () => {
    if (isSourceActive || !activeLang) return;
    setTriggering(true);
    setErr(null);
    try {
      await triggerTranslate(projectName, kind, entityId, activeLang);
      // Optimistic: flip the row to pending locally so the user sees motion.
      setTranslations((prev) =>
        prev.map((t) =>
          t.lang === activeLang
            ? { ...t, status: "pending", error: null }
            : t,
        ),
      );
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Translation request failed");
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="kb-dialog__field">
      <label>Translations</label>
      <LanguageTabs
        languages={projectLanguages}
        sourceLang={originalLang}
        activeLang={activeLang}
        translations={translations}
        onChange={setActiveLang}
      />
      {loading ? (
        <div className="lang-readonly lang-readonly--empty">Loading…</div>
      ) : isSourceActive ? (
        <div className="lang-readonly lang-readonly--empty">
          This is the source language — edit in the form above. Translations to
          the other project languages will update automatically within a few
          minutes.
        </div>
      ) : (
        <TranslationBody
          translation={activeTranslation}
          markdownFields={markdownFields}
          onTranslate={handleTranslate}
          triggering={triggering}
        />
      )}
      {err && <div className="lang-readonly__error">{err}</div>}
    </div>
  );
}

function TranslationBody({
  translation,
  markdownFields,
  onTranslate,
  triggering,
}: {
  translation: TranslationDto | undefined;
  markdownFields: readonly string[];
  onTranslate: () => void;
  triggering: boolean;
}) {
  const hasContent =
    !!translation &&
    Object.values(translation.fields).some((v) => v && v.trim() !== "");

  const statusLabel = !translation
    ? "Not translated yet"
    : translation.status === "ready"
      ? "Up to date"
      : translation.status === "translating"
        ? "Translating…"
        : translation.status === "error"
          ? `Failed: ${translation.error ?? "unknown error"}`
          : "Queued — waiting for translator";

  return (
    <div>
      <div className="lang-readonly__header">
        <span>{statusLabel}</span>
        <button
          type="button"
          className="lang-readonly__translate-btn"
          onClick={onTranslate}
          disabled={triggering || translation?.status === "translating"}
        >
          {triggering ? "Sending…" : "Translate now"}
        </button>
      </div>
      {!hasContent ? (
        <div className="lang-readonly lang-readonly--empty">
          No translated content yet. Click "Translate now" to run it immediately,
          or wait for the next scheduled tick.
        </div>
      ) : (
        <div>
          {Object.entries(translation!.fields).map(([key, value]) => {
            const v = value ?? "";
            const isMarkdown = markdownFields.includes(key);
            return (
              <div key={key} style={{ marginBottom: 8 }}>
                <div
                  style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}
                >
                  {key}
                </div>
                {isMarkdown && v.trim() ? (
                  <div className="lang-readonly">
                    <MarkdownContent text={v} />
                  </div>
                ) : (
                  <div className="lang-readonly">{v || "\u00A0"}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
