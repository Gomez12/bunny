# Scripts

Per-code-project single-file scripts. Saved in the DB (versioned) and on disk (`workspace/code/<cp>/scripts/<name>.<ext>`).

## Tables

- `scripts` — main entity (`code_project_id`, `name`, `content`, `language`, `is_temp`, `file_hash`)
- `script_versions` — content snapshots per script

## Disk layout

```
workspace/code/<cp-name>/
  scripts/
    <name>.<ext>        ← regular scripts
    temp/
      <name>.<ext>      ← temp scripts (is_temp=1)
  scripts-tmp/
    <id>.<ext>          ← execution temp files (cleaned up after run)
```

## Languages

C#, JavaScript, TypeScript, Python, SQL, Bash, PowerShell, Go.

## Runtime configuration

In `bunny.config.toml`:
```toml
[scripts]
dotnet_path = "/usr/local/share/dotnet/dotnet"
python_path = "/usr/bin/python3"
powershell_path = "/usr/local/bin/pwsh"
go_path = "/usr/local/go/bin/go"
# bun_path = ""  # leave empty to use current Bun process
exec_timeout_ms = 30000
max_output_bytes = 10485760
max_versions_per_script = 50
sync_cron = "*/5 * * * *"
```

Or configure via Settings → Script Runtimes (admin only).

## Version history

Versions are created on:
- Editor blur (user tabbed away or clicked elsewhere)
- 30 s idle after last keystroke
- Explicit version restore

Auto-save (2 s) does NOT create versions.

## Temp scripts

- `is_temp = 1` — hidden from main list by default
- No name required (auto-generates `scratch-<date>-<random>`)
- Stored in `scripts/temp/`
- Promote to regular via `POST /api/scripts/:id/promote`

## Disk sync

The `scripts.sync_scan` handler (cron `cfg.scripts.syncCron`) walks all code projects and:
1. Detects external edits (disk hash ≠ stored hash) → updates DB + creates version
2. Restores missing disk files from DB content
3. Auto-imports new files dropped into the `scripts/` directory

On-open check: `GET /api/scripts/:id` always checks disk; returns `diskDiffers: true` if the file was edited externally.

## Entry points

- `src/memory/scripts.ts` — CRUD + path helpers
- `src/server/scripts_routes.ts` — HTTP routes + SSE execution + chat
- `src/scripts/sync_handler.ts` — scheduled disk-sync
- `src/agent/sse_events.ts` — `SseScriptRun*` event types
- `src/prompts/registry.ts` — `scripts.chat` prompt
- `web/src/tabs/ScriptsTab.tsx` — main shell
- `web/src/tabs/scripts/ScriptEditorView.tsx` — Monaco editor + run
- `web/src/tabs/scripts/ScriptChatView.tsx` — LLM chat
- `web/src/tabs/scripts/ScriptVersionsView.tsx` — version history
- `web/src/components/ScriptsRail.tsx` — secondary rail
- `web/src/components/ScriptDialog.tsx` — create/edit dialog

See [ADR 0037](../../adr/0037-scripts-subsystem.md).
