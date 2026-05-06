# Script Runtimes

The Scripts tab can execute scripts using external runtimes. Bun/JavaScript always works. Other languages require a configured executable path.

## Configuration

In `bunny.config.toml`:

```toml
[scripts]
# C# — requires .NET 10+ for file-based run (dotnet run file.cs)
# For older .NET: install dotnet-script (`dotnet tool install -g dotnet-script`)
dotnet_path = "/usr/local/share/dotnet/dotnet"

# Python
python_path = "/usr/bin/python3"

# PowerShell (cross-platform)
powershell_path = "/usr/local/bin/pwsh"

# Go — "go run file.go" (go 1.21+)
go_path = "/usr/local/go/bin/go"

# Bun override — leave empty to use the current Bun process (always available)
# bun_path = ""

exec_timeout_ms = 30000        # 30 seconds
max_output_bytes = 10485760    # 10 MiB stdout+stderr combined
max_versions_per_script = 50
sync_cron = "*/5 * * * *"
```

Or configure via the web UI: Settings → Script Runtimes (admin only, takes effect without restart).

## Per-language notes

| Language | Execution | Notes |
|----------|-----------|-------|
| JavaScript | `bun run <file>` | Always available (current Bun process) |
| TypeScript | `bun run <file>` | Always available (Bun handles TS natively) |
| C# | `dotnet run <file>` | .NET 10+ required for file-based run without a project file |
| Python | `python3 <file>` | Configure `python_path` |
| Bash | `bash <file>` | Usually on PATH on macOS/Linux |
| PowerShell | `pwsh -File <file>` | Configure `powershell_path` or ensure `pwsh` is on PATH |
| Go | `go run <file>` | Configure `go_path` or ensure `go` is on PATH |
| SQL | — | Not executable; requires a database connection (V1) |

## Runtime not configured

If a script's language has no configured runtime, clicking Run returns HTTP 422 with:

```json
{ "error": "runtime_not_configured", "language": "csharp", "hint": "Configure the runtime path in Settings → Script Runtimes" }
```

The editor shows a banner linking to Settings.

## Security

Scripts run with the same permissions as the Bunny process. The working directory is `workspace/code/<code-project-name>/`. The execution is not sandboxed. Only configure runtimes on trusted installations.
