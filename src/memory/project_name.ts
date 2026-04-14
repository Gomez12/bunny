/**
 * Shared project-name regex, importable from both backend and web (vite's
 * `fs.allow: [".."]` lets `web/` reach across). Split out from `projects.ts`
 * so the frontend doesn't pull in `bun:sqlite`.
 */

export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
