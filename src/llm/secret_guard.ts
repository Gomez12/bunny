/**
 * Guard that prevents user-typed content containing a forbidden secret value
 * from reaching the LLM. Applied synchronously at every manual chat entry
 * point before any queue activity. See ADR 0039.
 */

import type { Database } from "bun:sqlite";
import { loadForbiddenSecretValues } from "../memory/code_project_secrets.ts";

export interface SecretGuardResult {
  blocked: boolean;
  reason: string;
}

/**
 * Returns `blocked: true` when `content` contains a value that is marked
 * llm_forbidden across any non-deleted code project. The reason message is
 * intentionally generic — it never reveals which secret or its value.
 *
 * Empty/whitespace-only values are skipped to prevent false positives.
 * Short-circuits on the first match.
 */
export function checkSecretGuard(
  db: Database,
  content: string,
): SecretGuardResult {
  const forbidden = loadForbiddenSecretValues(db);
  for (const val of forbidden) {
    if (val.trim() === "") continue;
    if (content.includes(val)) {
      return {
        blocked: true,
        reason:
          "Your message contains a value that is marked as forbidden for LLM use. " +
          "Please remove the sensitive content before sending.",
      };
    }
  }
  return { blocked: false, reason: "" };
}
