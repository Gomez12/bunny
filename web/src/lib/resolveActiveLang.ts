/**
 * Pure helper for deciding which language tab is initially active when a user
 * opens an entity dialog.
 *
 * Fallback chain:
 *   1. `user.preferredLanguage` — iff set AND present in `project.languages`.
 *   2. `project.defaultLanguage` — iff set AND present in `project.languages`.
 *   3. `entity.originalLang` — only if the project still lists it.
 *   4. `project.languages[0]` — last-resort; the picker will always return
 *      *some* language that the project supports.
 *
 * This function NEVER returns a language that isn't in `project.languages`, so
 * callers can trust it for the `activeLang` state in `<LanguageTabs>`.
 */

export interface ActiveLangInput {
  user: { preferredLanguage: string | null } | null | undefined;
  project: { languages: string[]; defaultLanguage: string };
  entity: { originalLang: string | null };
}

export function resolveActiveLang({
  user,
  project,
  entity,
}: ActiveLangInput): string {
  const pref = user?.preferredLanguage ?? null;
  if (pref && project.languages.includes(pref)) return pref;
  if (
    project.defaultLanguage &&
    project.languages.includes(project.defaultLanguage)
  ) {
    return project.defaultLanguage;
  }
  if (entity.originalLang && project.languages.includes(entity.originalLang)) {
    return entity.originalLang;
  }
  return project.languages[0] ?? "en";
}
