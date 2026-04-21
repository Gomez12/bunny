# Files (workspace)

## What it is

Per-project file area under `<projectDir>/workspace/`, seeded with `input/` and `output/` by `ensureProjectDir`. Agents read/write via `list_workspace_files`, `read_workspace_file`, `write_workspace_file`. Humans browse via the **Files** tab.

Every path goes through `safeWorkspacePath`, which rejects absolute paths, `..`-traversal, and symlink escapes. `input/` and `output/` are **protected roots** — delete/move on the root refuses; their contents are freely editable.

## Data model

No DB table — state is the filesystem. The project directory under `$BUNNY_HOME/projects/<name>/workspace/` *is* the data.

## HTTP API

- `GET /api/projects/:p/workspace/list?path=…`
- `GET /api/projects/:p/workspace/file?path=…&encoding=utf8|base64|raw`
- `POST /api/projects/:p/workspace/file` — JSON or multipart, 100 MB cap.
- `POST /api/projects/:p/workspace/mkdir`
- `POST /api/projects/:p/workspace/move`
- `DELETE /api/projects/:p/workspace?path=…`

Reads = `canSeeProject`, mutations = `canEditProject`.

## Code paths

- `src/memory/workspace_fs.ts` — `listWorkspace`, `readWorkspaceFile`, `writeWorkspaceFile`, `mkdirWorkspace`, `moveWorkspaceEntry`, `deleteWorkspaceEntry`, `resolveForDownload`, `safeWorkspacePath`.
- `src/memory/project_assets.ts:ensureProjectDir` — seeds `input/` + `output/`.
- `src/tools/workspace.ts` — three closure-bound agent tools. Names in `WORKSPACE_TOOL_NAMES`.
- `src/server/workspace_routes.ts`.

## UI

- `web/src/tabs/FilesTab.tsx` — breadcrumb nav, drag-and-drop upload zone, inline rename / mkdir / delete, lock icon on `input`/`output` roots.
- Downloads are plain `<a href>` to the `encoding=raw` endpoint.

## Extension hooks

- **Translation:** no.
- **Trash:** no (filesystem-level deletes are hard).
- **Notifications:** no.
- **Scheduler:** no.
- **Tools:** three closure-bound tools — `list_workspace_files`, `read_workspace_file`, `write_workspace_file`.

## Agent tools

Same closure pattern as board + web tools. Spliced into the per-run registry by `buildRunRegistry` in `src/agent/loop.ts`; whitelists work identically.

| Tool | Purpose | Notes |
| --- | --- | --- |
| `list_workspace_files(path?)` | Recursive listing. | Returns entries with kind (file/dir) + size + mtime. |
| `read_workspace_file(path, encoding?)` | utf8 (default) or base64. | Capped at 64 KB utf8 / 5 MB base64. Overflow returns `truncated: true`, `returnedBytes`, `totalBytes`. |
| `write_workspace_file(path, content, encoding?)` | utf8 or base64. | Creates intermediate directories. |

## Protected roots

- `input/` and `output/` are seeded on project create; delete + move on these roots refuses.
- Contents inside them are freely editable.
- The UI shows a lock icon next to `input/` and `output/` entries.

## Path safety

`safeWorkspacePath(project, userPath)`:

1. Reject absolute paths (`/…`).
2. Resolve against the workspace root.
3. Reject anything whose resolved path escapes the root (`..` traversal).
4. Resolve symlinks; reject if the target escapes.

Return the resolved absolute path. Every read / write / list / delete goes through this helper.

## Key invariants

- **Every path passes `safeWorkspacePath`.** No exceptions.
- **`input/` and `output/` cannot be deleted or moved as roots.**
- **Reads are capped.** 64 KB utf8, 5 MB base64. Overflow signals `truncated`.
- **Writes are capped at 100 MB** (HTTP endpoint).

## Gotchas

- The workspace root is determined by `ensureProjectDir` — legacy projects that pre-date the `input/` / `output/` seed get backfilled on first read. This is idempotent.
- `encoding=raw` bypasses JSON wrapping — used by the UI for downloads.
- Moving a file into a protected root is allowed (`input/` and `output/` are directories, after all). Moving *the root itself* is not.
- `mkdirWorkspace` uses `recursive: true` — if the parent doesn't exist, it's created.

## Related

- [ADR 0012 — Project workspaces](../../adr/0012-project-workspaces.md)
- [`../concepts/projects-as-scope.md`](../concepts/projects-as-scope.md) — workspace is part of the project on disk.
- [`./documents.md`](./documents.md) — images land inside the workspace.
