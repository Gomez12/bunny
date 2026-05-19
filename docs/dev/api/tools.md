# Tools

This document catalogues every tool the LLM can invoke during an agent turn.
It is a runtime reference — the authoritative source is the code under
`src/tools/` and the per-run assembly in
[`buildRunRegistry`](../src/agent/loop.ts) in `src/agent/loop.ts`.

## How tools are assembled

The agent loop distinguishes two kinds of tools:

1. **Static registry tools** — registered once at process startup against a
   shared singleton in [`src/tools/registry.ts`](../src/tools/registry.ts).
   The registrations live in [`src/tools/index.ts`](../src/tools/index.ts) and
   cover filesystem primitives (`read_file`, `list_dir`, `edit_file`) that are
   unaware of project, user, or run context.
2. **Dynamic, closure-bound tools** — built fresh for each `runAgent` call by
   `buildRunRegistry` in [`src/agent/loop.ts`](../src/agent/loop.ts). The
   closure captures the current `project`, `db`, `userId`, `webCfg`, allowed
   subagents, and available skills, so a tool invoked in project *alpha*
   cannot read / write project *beta*. The dynamic names are listed in
   `DYNAMIC_TOOL_NAMES`:

   - Workspace: `list_workspace_files`, `read_workspace_file`,
     `write_workspace_file` — [`src/tools/workspace.ts`](../src/tools/workspace.ts)
     (`WORKSPACE_TOOL_NAMES`).
   - Board: `board_list`, `board_get_card`, `board_create_card`,
     `board_update_card`, `board_move_card`, `board_archive_card` —
     [`src/tools/board.ts`](../src/tools/board.ts) (`BOARD_TOOL_NAMES`).
   - Web: `web_fetch`, `web_search`, `web_download` —
     [`src/tools/web.ts`](../src/tools/web.ts) (`WEB_TOOL_NAMES`).
   - Skills: `activate_skill` — only spliced in when the project has linked
     skills ([`src/tools/activate_skill.ts`](../src/tools/activate_skill.ts)).
   - Subagents: `call_agent` — only spliced in when the current agent has a
     non-empty `allowed_subagents`
     ([`src/tools/call_agent.ts`](../src/tools/call_agent.ts)).

An agent's `tools = [...]` whitelist filters both kinds; an agent with no
whitelist inherits every tool the current run would otherwise expose.
`GET /api/tools` lists the tools that can be checked in the agent editor.

---

## Filesystem tools (static)

These operate on the cwd where `bunny` was launched, guarded by a `safePath`
helper that rejects absolute paths and `..` traversal.

### `read_file`

Read the contents of a file at a given path.

| Parameter | Type   | Required | Notes                                   |
| --------- | ------ | -------- | --------------------------------------- |
| `path`    | string | yes      | Relative to the working directory.      |

Returns UTF-8 text. Large files are truncated; the response signals the
truncation so the LLM can reason about it. Source:
[`src/tools/fs_read.ts`](../src/tools/fs_read.ts).

### `list_dir`

List directory entries at a given path.

| Parameter     | Type    | Required | Notes                                                                |
| ------------- | ------- | -------- | -------------------------------------------------------------------- |
| `path`        | string  | no       | Directory to list (defaults to `"."`).                                |
| `show_hidden` | boolean | no       | Include dotfiles. Defaults to `false`.                                |

Directories are returned with a trailing `/`. Source:
[`src/tools/fs_list.ts`](../src/tools/fs_list.ts).

### `edit_file`

Replace an exact string in a file. The `old_string` must appear exactly once.

| Parameter    | Type   | Required | Notes                                        |
| ------------ | ------ | -------- | -------------------------------------------- |
| `path`       | string | yes      | Target file, relative to the working dir.    |
| `old_string` | string | yes      | Must match exactly once in the file.         |
| `new_string` | string | yes      | Replacement text.                            |

Fails if `old_string` is missing or ambiguous. Source:
[`src/tools/fs_edit.ts`](../src/tools/fs_edit.ts).

---

## Workspace tools (dynamic, project-scoped)

Operate inside `<projectDir>/workspace/`. Every path flows through
`safeWorkspacePath`, which rejects absolute paths, `..`-traversal, and symlink
escapes. `input/` and `output/` are protected roots: they cannot be deleted or
moved, but their contents are freely editable. Source:
[`src/tools/workspace.ts`](../src/tools/workspace.ts).

### `list_workspace_files`

| Parameter | Type   | Required | Notes                                     |
| --------- | ------ | -------- | ----------------------------------------- |
| `path`    | string | no       | Workspace-relative directory. `""` = root. |

Returns `{ path, entries: [...] }` with file / dir metadata.

### `read_workspace_file`

| Parameter  | Type   | Required | Notes                                                          |
| ---------- | ------ | -------- | -------------------------------------------------------------- |
| `path`     | string | yes      | Workspace-relative file path.                                   |
| `encoding` | string | no       | `"utf8"` (default, 64 KB cap) or `"base64"` (5 MB cap for binaries). |

If the cap is exceeded the response sets `truncated: true` and reports
`returnedBytes` / `totalBytes` so the LLM can paginate.

### `write_workspace_file`

| Parameter  | Type   | Required | Notes                                          |
| ---------- | ------ | -------- | ---------------------------------------------- |
| `path`     | string | yes      | Workspace-relative; missing parents auto-created. |
| `content`  | string | yes      | UTF-8 text or base64 bytes.                       |
| `encoding` | string | no       | `"utf8"` (default) or `"base64"`.                |

Overwrites if the target exists. Returns `{ path, bytesWritten }`.

---

## Board tools (dynamic, project-scoped)

Drive the project's kanban. Project + `db` + `userId` are captured in the
closure so an agent cannot address other projects. Source:
[`src/tools/board.ts`](../src/tools/board.ts).

| Tool                 | Required params                 | Optional params                                     | Behaviour                                                                 |
| -------------------- | -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `board_list`         | —                                | `include_archived: boolean`, `lane: string`         | Returns swimlanes + cards (active by default).                            |
| `board_get_card`     | `card_id: number`                | —                                                   | Full card row, with lane name resolved.                                   |
| `board_create_card`  | `title: string`                  | `description`, `lane` / `lane_id`, `assignee_agent` | Creates a card; validates `assignee_agent` is linked to the project.      |
| `board_update_card`  | `card_id: number`                | `title`, `description`, `assignee_agent`            | Partial update; empty-string `assignee_agent` clears the assignee.        |
| `board_move_card`    | `card_id: number`                | `lane` or `lane_id` (at least one)                  | Moves a card across swimlanes.                                            |
| `board_archive_card` | `card_id: number`                | —                                                   | Soft-archive (`archivedAt` timestamp); card is still queryable.           |

Agent-assignees must be whitelisted via `project_agents`; user-assignees are
not settable via tool calls (only via the UI / HTTP).

---

## Web tools (dynamic)

Give an agent internet access. Configured from `[web]` in
`bunny.config.toml` (SERP API key optional; env override
`SERP_API_KEY`). Source: [`src/tools/web.ts`](../src/tools/web.ts).

### `web_fetch`

| Parameter | Type   | Required | Notes                                 |
| --------- | ------ | -------- | ------------------------------------- |
| `url`     | string | yes      | Must start with `http://` or `https://`. |

Strips `<script>`, `<style>`, `<nav>`, `<footer>`, `<header>`, `<aside>`,
`<noscript>`, converts the rest to markdown via `node-html-markdown`, and
caps at ≈ 100 KB (`truncated: true` signals overflow). Timeout 30 s.

### `web_search`

| Parameter     | Type    | Required | Notes                               |
| ------------- | ------- | -------- | ----------------------------------- |
| `query`       | string  | yes      | Free-form search string.            |
| `max_results` | integer | no       | 1–10; defaults to 10.               |

Uses a SERP API when `cfg.web.serpApiKey` is set; otherwise falls back to
DuckDuckGo HTML scraping (5 retries, exponential back-off) and then Bing.
Returns `{ query, results: [...], source }` where `source` names which
backend answered.

### `web_download`

| Parameter | Type   | Required | Notes                                                    |
| --------- | ------ | -------- | -------------------------------------------------------- |
| `url`     | string | yes      | File URL.                                                |
| `path`    | string | yes      | Workspace-relative destination (same sandbox as `write_workspace_file`). |

Writes through `writeWorkspaceFile`; enforces a 100 MB cap and 30 s timeout.
Returns `{ url, path, size }`.

---

## Skill activation (dynamic, conditional)

Skills ship with the
[agentskills.io](https://agentskills.io) standard: a `SKILL.md` with YAML
frontmatter plus optional `scripts/`, `references/`, `assets/`. The catalog
(name + description per skill) is injected into the system prompt; the full
body is only loaded when the agent decides to activate one. Source:
[`src/tools/activate_skill.ts`](../src/tools/activate_skill.ts).

### `activate_skill`

| Parameter | Type   | Required | Notes                                                       |
| --------- | ------ | -------- | ----------------------------------------------------------- |
| `name`    | string | yes      | Must match one of the project-linked skill names.           |

Returns `<skill_content>…</skill_content>` with the markdown instructions,
followed by a `<skill_resources>` listing so the agent can reach bundled
files via `read_file` / `read_workspace_file`. Only spliced into the per-run
registry when the project has at least one linked skill.

---

## Subagent delegation (dynamic, conditional)

Enabled when `agents.is_subagent = 1` on the callee and the caller's
`allowed_subagents` contains the callee name. Source:
[`src/tools/call_agent.ts`](../src/tools/call_agent.ts).

### `call_agent`

| Parameter | Type   | Required | Notes                                                          |
| --------- | ------ | -------- | -------------------------------------------------------------- |
| `name`    | string | yes      | Subagent name; must appear in the caller's `allowed_subagents`. |
| `prompt`  | string | yes      | Task / question for the subagent (include all necessary context). |

Spawns a nested `runAgent` with a silent renderer; only the final assistant
answer surfaces as the tool result. Depth is capped at
`MAX_AGENT_CALL_DEPTH = 2` so chains cannot recurse indefinitely.

---

## Related surfaces

- The agent-editor picker calls `GET /api/tools` to populate the
  whitelist — it mirrors the names above.
- Every tool invocation is logged through the queue (`topic: "tool"`); see
  [ADR 0004](./adr/0004-bunqueue-as-spine.md).
- Additions of new tool families should come with an ADR under `docs/adr/`
  and an entry in `DYNAMIC_TOOL_NAMES` (if dynamic) or `src/tools/index.ts`
  (if static).
