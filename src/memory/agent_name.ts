/**
 * Shared agent-name regex, importable from backend and web. Same rules as
 * project names: lowercase ascii, digits, `-` or `_`, 1-63 chars, must start
 * with a letter or digit. Agent names are the DB PK and directory name, so
 * they are immutable after creation.
 */

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
