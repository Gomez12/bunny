# ADR 0012 — Project workspaces (on-disk file area)

## Status

Accepted — 2026-04-15

## Context

Projects already own a directory on disk (`$BUNNY_HOME/projects/<name>/`)
holding `systemprompt.toml`. Users repeatedly wanted to hand agents *files*
— raw inputs (docs, spreadsheets, screenshots) and a place for the agent to
drop generated artefacts. So far the only way to do that was to paste the
content into chat, which doesn't scale, isn't portable between runs, and
loses binary data. We want a single, per-project file area that is:

1. **Visible on disk** — plain files in `<projectDir>/workspace/`, so users
   can browse/edit with their editor of choice, back it up, or zip a
   project including its files.
2. **Reachable from the web UI** — browse, upload (drag-and-drop), download,
   rename, delete, mkdir — without shelling into the project directory.
3. **Reachable from agents** — three tools (`list_workspace_files`,
   `read_workspace_file`, `write_workspace_file`) so the model can read an
   input and drop its output right next to it.
4. **Strictly sandboxed** — no path traversal, no `..`, no symlink escape.
   An agent in project *alpha* must not touch project *beta* or anything
   else on the filesystem.

## Decision

### On disk

`<projectDir>/workspace/` is the workspace root, seeded with `input/` and
`output/` by `ensureProjectDir` (idempotent — backfills legacy projects on
first access). `src/memory/project_assets.ts` exports
`workspaceDir(name)`; `src/memory/workspace_fs.ts` owns the read/write
primitives (`listWorkspace`, `readWorkspaceFile`, `writeWorkspaceFile`,
`mkdirWorkspace`, `moveWorkspaceEntry`, `deleteWorkspaceEntry`,
`resolveForDownload`). Every helper funnels through `safeWorkspacePath`,
which rejects absolute paths, `..`-traversal, and symlink escapes.

`input/` and `output/` are **protected roots** — `delete` and `move` refuse
to touch them directly, but their contents are freely editable. Extra
subdirectories created by the user have no such protection.

### Agent tools

Closure-bound, same pattern as board tools (ADR 0010). `makeWorkspaceTools({
project })` returns descriptors for the three tools above; `buildRunRegistry`
in `src/agent/loop.ts` splices them into the per-run registry. Whitelisting
an agent to specific tool names works exactly as for board tools. Read
output is capped (64 KB UTF-8 / 5 MB base64) so a wayward read cannot blow
up the model's context; the response signals `truncated: true` with
`returnedBytes` / `totalBytes`. Binary files are supported via
`encoding: "base64"` on both `read_workspace_file` and
`write_workspace_file`.

### HTTP surface

Mounted from `src/server/routes.ts` between board and scheduled-task
routes:

- `GET  /api/projects/:p/workspace/list?path=…`
- `GET  /api/projects/:p/workspace/file?path=…&encoding=utf8|base64|raw`
- `POST /api/projects/:p/workspace/file` — JSON `{path, content, encoding?}`
  or multipart form with one or more `file` parts + optional `path` target dir
- `POST /api/projects/:p/workspace/mkdir` `{path}`
- `POST /api/projects/:p/workspace/move`  `{from, to}`
- `DELETE /api/projects/:p/workspace?path=…`

Reads require `canSeeProject`, any mutation requires `canEditProject`.
Upload cap: 100 MB per file.

### Web UI

New **Files** tab between Board and Tasks. Breadcrumb navigation, drag-and-
drop upload zone, inline rename, mkdir, delete. `input/` and `output/`
render with a lock icon and disabled delete/rename. Downloads are plain
`<a href>` to the `encoding=raw` endpoint so the browser handles streaming
and `Content-Disposition`.

## Consequences

- Projects become self-contained: one directory holds the system prompt,
  its full chat DB (via `$BUNNY_HOME`), and its working files. Zip a
  project dir and you've got a portable bundle.
- The sandbox is enforced *only* by `safeWorkspacePath`. Any future code
  that reads/writes inside `workspace/` MUST go through the helpers in
  `workspace_fs.ts` — never join paths ad-hoc.
- The protected-root rule is deliberately conservative. If a user wants a
  different layout they can create extra subdirectories; `input/` and
  `output/` are just the always-present defaults for agents that expect a
  canonical place to read from and write to.
