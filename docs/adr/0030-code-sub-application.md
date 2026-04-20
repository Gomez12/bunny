# ADR 0030 — Code sub-application with a secondary icon rail

Status: Accepted — 2026-04-20

## Context

Bunny has per-project content areas (Documents, Whiteboards, Files, Contacts,
Knowledge Base, Web News) but no structured home for source code. Users want
to point Bunny at a repository (initially via a git URL) so agents can perform
code reviews, answer questions about the code, and write documentation about
it. The feature is explicitly a seed for future expansion — reviews, docs
generation, code search, issues — so the v1 shell must not crowd the primary
nav the way another tab would, and the subsystem must be self-contained
enough that adding a second Code sub-feature is trivial.

Bunny's hard constraints also shape the design:

- **Portable by design.** The standalone binary produced by `bun build
  --compile` is expected to run on any machine that has `bun` available, with
  no other system toolchain. A `git` binary dependency would break that
  contract.
- **Append-only schema.** New state lives in a new table; no columns may be
  dropped or renamed on `documents`, `whiteboards`, or any existing row.
- **Queue-logged mutations.** Every HTTP mutation fans out to `events` so the
  admin Logs tab keeps a complete paper trail.

## Decision

Introduce a **Code sub-application** rendered inside `activeTab === "code"`
that owns its own secondary icon rail. Projects live on disk under the
existing per-Bunny-project workspace at `workspace/code/<name>/`, optionally
seeded from a public git repo cloned via `isomorphic-git` (pure JS, bundles
with the binary).

### UI shape: two icon rails

When the user clicks **Code** in the primary nav rail, the main region
renders a `CodeTab` shell whose internal layout is a second 56 px icon rail
followed directly by the active feature's main pane:

```
[ primary nav 56px ] [ code rail 56→240px ] [ feature pane ]
```

Both rails expand to 240 px on hover, absolutely positioned, so there is no
layout reflow. The secondary rail splits into two regions:

1. **Top: code-project picker.** A single button spanning the rail width
   that shows the currently-active code project's name. Clicking it opens
   `CodeProjectPickerDialog` — a modal listing every code project in the
   current Bunny project with status dots, edit / delete per row, and a
   **+ New** button that hands off to `CodeProjectDialog`. The active id is
   persisted per Bunny project in
   `localStorage["bunny.activeCodeProject.<project>"]` so switching Bunny
   projects restores the right code-project selection.
2. **Bottom: per-project feature buttons.** v1 ships two features —
   **Show Code** (file tree + details + quick-edit composer) and
   **Chat** (persistent conversational pane scoped to this code project).
   Future features (Code Review, Code Search, Issues, …) drop in as a
   single entry in the rail's `NavGroup[]` plus one case in the
   `CodeTab` switch. The active feature is persisted in
   `localStorage["bunny.activeCodeFeature"]`. Buttons are disabled until a
   code project is picked.

The list sidebar that earlier versions of this ADR described has been
removed — the picker in the rail replaces it, which keeps the main pane
full-width and makes room for future features that need the whole
horizontal space (e.g. diff views, file content readers).

The primary rail, other tabs, and the non-Code UX are pixel-identical to
before.

### Backend shape: one table, workspace reuse

One new table `code_projects` with `id`, `project`, `name`, `description`,
`git_url`, `git_ref`, `git_status ∈ {idle|cloning|ready|error}`, `git_error`,
`last_cloned_at`, `created_by`, timestamps, and soft-delete columns
(`deleted_at`, `deleted_by`) — append-only. `UNIQUE(project, name)` enforces
that the slug doubles safely as a directory name.

`WORKSPACE_DEFAULT_SUBDIRS` grows from `["input", "output"]` to
`["input", "output", "code"]`. `ensureProjectDir` self-seeds the new root;
`safeWorkspacePath` derives `PROTECTED_ROOTS` from the same constant, so
`code/` automatically becomes a protected root (the directory contents are
freely editable, the root itself cannot be moved or deleted).

The two existing workspace primitives — `listWorkspace` and
`readWorkspaceFile` — back the file-tree and file-read endpoints; no new
filesystem code is needed.

### Cloning: portable, async, bounded

Git cloning uses `isomorphic-git` rather than shelling out to `git`. This
preserves the "copy the binary anywhere" contract at the cost of some speed
on large clones. The trade-off is bounded by a shallow-clone depth (default
50), a per-clone timeout (default 5 min), and a post-clone size cap (default
500 MB) — any one of which flips the row to `error` and wipes the directory.
An `AbortController` wired into the `http` transport guarantees the timeout
is load-bearing even for hung remotes.

Clones run as fire-and-forget jobs detached from the HTTP response. The
create endpoint returns immediately with `git_status = 'cloning'`; the
frontend polls `GET /api/code/:id` every 2 s for the transition.

### Public-repo only (v1)

The route boundary rejects `ssh://`, `scp`-style `user@host:path`, `file://`,
and `ext::` URLs with a 400. No credential callback is registered on the http
transport, so a private URL that slipped through surfaces a 401/404 from the
remote instead of prompting. This removes all secret-handling surface for
v1 — adding authenticated clones later is an additive change.

### LLM interactions: ask, edit, chat

Three LLM entry points, all piggy-backing on `runAgent`:

- **Ask** (`POST /api/code/:id/ask`) — seeds a normal chat session with the
  `code.ask` prompt and returns `{ sessionId }`; the frontend navigates to
  the main Chat tab. Used for one-off questions the user may want to
  continue in the standard chat UX.
- **Edit** (`POST /api/code/:id/edit`) — lives under the **Show Code**
  feature's quick-edit composer. Streams via SSE with
  `systemPromptOverride = resolvePrompt("code.edit")`; the agent may read
  and write files. The file tree refreshes on `done`.
- **Chat** (`POST /api/code/:id/chat`) — drives the embedded **Chat**
  feature. Persistent per-code-project session (id stored in
  `localStorage["bunny.codeChatSession.<id>"]`), SSE stream, markdown
  rendering, workspace tools auto-spliced by `buildRunRegistry`. This is
  the main conversational surface for code review / Q&A / doc generation.

All three use the existing workspace tools
(`list_workspace_files`, `read_workspace_file`, `write_workspace_file`)
with paths prefixed by `code/<name>/`, which matches the session's Bunny
project. The three prompts are `projectOverridable` entries in the central
registry (ADR 0029) with matching fixture files that the snapshot test
covers.

### Trash integration

`code_project` joins the four entities that already participate in the
central trash system (ADR 0025): `documents`, `whiteboards`, `contacts`,
`kb_definitions`. No translation sidecars (the content is code, not natural
language). Soft-delete renames the row to `__trash:<id>:<name>` so
`UNIQUE(project, name)` stays free for re-creation; restore reverses the
rename and returns `"name_conflict"` when another live row has already
claimed the original slug.

## Alternatives considered

- **Add Code as a peer tab inside the existing Content section.** Ruled out
  because the feature is explicitly planned to grow into multiple sub-tabs.
  Forcing each future sub-tab into the primary rail would crowd it; a secondary
  rail isolates the growth.
- **Shell out to system `git`.** Faster for large repos, but breaks the
  portable-binary contract and introduces a hard dependency for every
  distribution. A future `[code] git_bin = "git"` escape hatch can layer on
  top when someone hits a clone-speed wall.
- **Store private-repo credentials per code project.** Deferred. Encrypted
  token storage, rotation UX, and audit trail are a feature in their own
  right; public-only clones cover the intended v1 use cases and leave the
  door open for an additive ADR.
- **New "code repository" top-level entity outside of Bunny projects.** Ruled
  out: every other content entity is per-Bunny-project, sharing the same
  permission model, sidebar switcher, and workspace filesystem; carving out
  a parallel global namespace would fragment the mental model.

## Consequences

- One new backend route file (`src/server/code_routes.ts`), one new memory
  module (`src/memory/code_projects.ts`), one new clone subsystem
  (`src/code/clone.ts`), two new prompt-registry entries + fixtures.
- Three new frontend files — `CodeRail`, `CodeTab` shell, `CodeProjectsTab` —
  plus a `CodeProjectDialog` and a self-contained CSS block scoped under
  `.code-*`. The primary `.nav` rules are untouched.
- `isomorphic-git` joins the backend dependency list. Every Bunny binary
  grows by ~600 KB; no system toolchain is required.
- Soft-delete, workspace reuse, queue logging, and prompt overrides all come
  in "for free" from existing subsystems.
- Future sub-tabs (Reviews, Docs, Search, Issues) slot into the secondary
  rail with no primary-nav changes.
