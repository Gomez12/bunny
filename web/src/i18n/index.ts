/**
 * i18n bootstrap for the web frontend.
 *
 * Initialises `i18next` with two locales (English + Dutch) and the
 * browser language detector. English is the primary fallback per
 * `AGENTS.md` §i18n.
 *
 * Conventions (documented in `docs/dev/plans/i18n-introduction.md`):
 *
 *   - Flat dot-path keys in a single namespace
 *     (e.g. `nav.items.dashboard`, `common.ok`, `tab.projects.title`).
 *   - Static keys only. Dynamic keys (`t(variable)` or template literals)
 *     are skipped by `bun run i18n:check` — keep them rare.
 *   - aria-label strings live under `<area>.a11y.<purpose>` so they read
 *     differently from visible labels.
 *
 * Locale bundles are imported eagerly. Both files are tiny (~1 kB). Once
 * either grows past ~50 kB, switch to dynamic `import()` + a loading
 * fallback (see the plan doc's "Risks" section).
 */
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import nl from "./locales/nl.json";

export const SUPPORTED_LOCALES = ["en", "nl"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      nl: { translation: nl },
    },
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LOCALES,
    nonExplicitSupportedLngs: true, // map "nl-NL" → "nl"
    interpolation: {
      // React already escapes; double-escaping breaks Dutch quotes.
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "bunny.locale",
    },
  });

export default i18n;
