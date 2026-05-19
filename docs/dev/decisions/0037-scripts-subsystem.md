# ADR 0037 — Scripts Subsystem

**Date:** 2026-05-06  
**Status:** Accepted

## Context

Users wanted a lightweight scripting environment inside Bunny: write single-file scripts, save and reload them, run them via external runtimes, and use the LLM to generate or improve them. The PRD (Portable ScriptPad) described a full portable .NET scripting environment; this ADR captures the subset integrated into Bunny.

## Decisions

### 1. Scripts are scoped to code-projects

Scripts live inside code-project directories (`workspace/code/<code-project-name>/scripts/<name>.<ext>`). This keeps them out of the top-level workspace (avoiding naming conflicts), naturally groups them with related code, and reuses the existing `code_projects` ownership model.

Temp scripts live in a `scripts/temp/` subdirectory.

### 2. Dual-store: DB + disk

Content is stored in both the database (versioned, searchable) and on disk (easy to copy/edit externally). The DB is the primary source for the web UI; the disk is the canonical external-edit surface. SHA-256 hashes detect external edits. The on-open check (`GET /api/scripts/:id`) compares the disk hash to `file_hash` and returns `diskDiffers: true` when they diverge.

### 3. Version history

The `script_versions` table snapshots content on:
- Editor blur (via `createVersion: true` in `PATCH /api/scripts/:id`)
- 30 s of idle after typing (debounced in `ScriptEditorView`)
- Explicit version restore

Auto-save (2 s debounce) does NOT create versions. This prevents the version history from filling up with noise on every keystroke.

Versions are pruned to `cfg.scripts.maxVersionsPerScript` (default 50) on every insert.

### 4. Temp scripts

`is_temp = 1` scripts are hidden from the main list by default, stored in `scripts/temp/`, and can be created without a name (auto-generated as `scratch-<yyyymmdd-HHmmss>-<random3>`). Promoting a temp script moves the disk file and clears the flag.

### 5. Runtime execution via configured paths

Bun/JavaScript works by default (`process.execPath`). All other runtimes (dotnet, python, pwsh, go) require a path in `bunny.config.toml` under `[scripts]` or via the Settings → Script Runtimes UI. If a runtime is not configured, the run endpoint returns 422 with a hint. SQL execution is not supported in v1.

### 6. Monaco editor with built-in IntelliSense

`@monaco-editor/react` provides the editor. JS/TS get full IntelliSense (Monaco's built-in TypeScript service). Other languages get syntax highlighting and keyword completions. Full LSP integration (OmniSharp for C#, pylsp for Python, gopls for Go) is V1.

### 7. LLM chat via existing `useSSEChat` hook

The chat feature uses the same `useSSEChat` hook and `ChatStreamer` pattern as the Code tab chat. `streamScriptChat` follows the exact same signature as `streamCodeChat`.

### 8. Disk-sync scheduled handler

`scripts.sync_scan` (default `*/5 * * * *`) walks all code projects, detects external edits, restores missing files, and auto-imports new files dropped into the scripts directory.

### 9. Trash integration

Scripts extend the existing `TrashEntityDef` via a new optional `scopeColumn` field. Since the UNIQUE constraint is on `(code_project_id, name)` rather than `(project, name)`, the restore conflict check needed to use `code_project_id` — a 3-line extension to `trash.ts`.

## Consequences

- `@monaco-editor/react` adds ~2 MB gzip to the frontend bundle.
- Scripts only work inside code projects — users must create a code project before using Scripts.
- External edits to disk files are picked up within 5 minutes (or immediately on next GET).
- C#/.NET execution requires the user to configure a dotnet path and install .NET 10+.
