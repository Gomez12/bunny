/**
 * Shared skill-name regex. Same rules as agent/project names: lowercase ascii,
 * digits, `-` or `_`, 1-63 chars, must start with a letter or digit. Skill
 * names are the DB PK and directory name, so they are immutable after creation.
 */

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
