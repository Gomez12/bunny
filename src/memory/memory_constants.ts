/**
 * Constants shared across the memory + soul subsystem (ADR 0034).
 *
 * Lives in its own module so the user/agent project-memory tables, the soul
 * helpers on `users`, the refresh handler, and the HTTP routes can all
 * import the cap from one place without importing each other.
 */

/** Hard cap (in UTF-16 code units) for any memory or soul field body. */
export const MEMORY_FIELD_CHAR_LIMIT = 4000;
