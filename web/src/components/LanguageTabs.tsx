/**
 * Language-tabstrip used inside entity dialogs (KB definition, document,
 * contact, board card). The tab matching `sourceLang` is marked "Source" and
 * the parent dialog renders its editable UI. All other tabs are read-only and
 * show a status pill reflecting the underlying sidecar row.
 *
 * Presentational only — the parent owns `activeLang` state and the render of
 * the source vs. translation bodies.
 */

import type { TranslationDto } from "../api";
import LangBadge from "./LangBadge";
import StatusPill, { type PillStatus } from "./StatusPill";

interface Props {
  /** Ordered list of ISO 639-1 codes from the project. Source is included. */
  languages: string[];
  sourceLang: string;
  activeLang: string;
  translations: TranslationDto[];
  onChange: (lang: string) => void;
}

export function translationStatusToPill(
  t: TranslationDto | undefined,
): PillStatus {
  if (!t) return "pending";
  if (t.isOrphaned) return "orphaned";
  switch (t.status) {
    case "ready":
      return "up-to-date";
    case "translating":
      return "translating";
    case "error":
      return "failed";
    case "pending":
    default:
      return "stale";
  }
}

export default function LanguageTabs({
  languages,
  sourceLang,
  activeLang,
  translations,
  onChange,
}: Props) {
  const translationByLang = new Map<string, TranslationDto>();
  for (const t of translations) translationByLang.set(t.lang, t);
  return (
    <nav className="lang-tabs" role="tablist">
      {languages.map((lang) => {
        const isSource = lang === sourceLang;
        const isActive = lang === activeLang;
        const translation = translationByLang.get(lang);
        const pill: PillStatus = isSource
          ? "source"
          : translationStatusToPill(translation);
        return (
          <button
            key={lang}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`lang-tab${isActive ? " lang-tab--active" : ""}${isSource ? " lang-tab--source" : ""}`}
            onClick={() => onChange(lang)}
          >
            <LangBadge lang={lang} />
            <StatusPill status={pill} />
          </button>
        );
      })}
    </nav>
  );
}
