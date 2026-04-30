-- Bunny agent database schema (SQLite + FTS5 + sqlite-vec)
-- This file is the canonical reference; db.ts runs it on first open.
-- NEVER drop or rename columns — add new ones instead.

-- ── Events ───────────────────────────────────────────────────────────────────
-- Append-only log of every job processed by bunqueue.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,          -- Unix ms
  topic       TEXT    NOT NULL,          -- llm | tool | memory | …
  kind        TEXT    NOT NULL,          -- request | response | call | result | index
  session_id  TEXT,
  payload_json TEXT,                     -- full job payload (input + output)
  duration_ms INTEGER,
  error       TEXT,                      -- null on success
  user_id     TEXT                       -- owning user (null for anonymous/historical)
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_topic   ON events(topic, ts);

-- ── Messages ─────────────────────────────────────────────────────────────────
-- Conversation history. One row per "semantic unit" — content and reasoning are
-- stored as separate rows (channel column) so the UI can show/hide them.
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT    NOT NULL,
  ts           INTEGER NOT NULL,           -- Unix ms
  role         TEXT    NOT NULL,           -- system | user | assistant | tool
  channel      TEXT    NOT NULL DEFAULT 'content', -- content | reasoning | tool_call | tool_result
  content      TEXT,
  tool_call_id TEXT,                       -- set on tool_call / tool_result rows
  tool_name    TEXT,
  provider_sig TEXT,                       -- thinking-block signature (Anthropic-compat)
  ok           INTEGER,                    -- 1|0 on tool_result rows; NULL otherwise
  duration_ms  INTEGER,                    -- LLM call duration on assistant content/reasoning rows
  prompt_tokens     INTEGER,               -- tokens sent (per LLM call)
  completion_tokens INTEGER,                -- tokens generated (per LLM call)
  user_id      TEXT,                        -- owning user (null for anonymous/historical)
  project      TEXT,                        -- owning project name (null = 'general')
  author       TEXT,                        -- responding agent name (null = default assistant)
  attachments  TEXT,                        -- JSON array of {kind,mime,dataUrl} (null = no attachments)
  edited_at            INTEGER,             -- ms; set when content was rewritten via the edit affordance
  trimmed_at           INTEGER,             -- ms; soft-delete used by "save and regenerate"
  regen_of_message_id  INTEGER              -- assistant alt-version pointer (chain of regenerations)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_regen_of ON messages(regen_of_message_id);
-- idx_messages_project is created in db.ts:migrateColumns so it also works on
-- upgraded databases where the `project` column is added by ALTER TABLE.

-- ── Projects ─────────────────────────────────────────────────────────────────
-- Logical workspaces: each project has its own directory under $BUNNY_HOME/projects/<name>/
-- and its own systemprompt.toml that augments (or replaces) the base system prompt.
CREATE TABLE IF NOT EXISTS projects (
  name              TEXT    PRIMARY KEY,
  description       TEXT,
  visibility        TEXT    NOT NULL DEFAULT 'public',  -- 'public' | 'private'
  languages         TEXT    NOT NULL DEFAULT '["en"]',  -- JSON array of ISO 639-1
  default_language  TEXT    NOT NULL DEFAULT 'en',      -- must appear in languages
  created_by        TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- ── Agents ──────────────────────────────────────────────────────────────────
-- Named personalities with their own system prompt + tool whitelist. Global by
-- default; per-project availability is controlled via `project_agents`.
-- On-disk config lives at $BUNNY_HOME/agents/<name>/config.toml.
CREATE TABLE IF NOT EXISTS agents (
  name                TEXT    PRIMARY KEY,
  description         TEXT    NOT NULL DEFAULT '',
  visibility          TEXT    NOT NULL DEFAULT 'private',  -- 'public' | 'private'
  is_subagent         INTEGER NOT NULL DEFAULT 0,           -- 1 = callable as subagent
  knows_other_agents  INTEGER NOT NULL DEFAULT 0,           -- 1 = list peers in prompt
  context_scope       TEXT    NOT NULL DEFAULT 'full',      -- 'full' | 'own'
  created_by          TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Opt-in join: which agents are available in which project.
CREATE TABLE IF NOT EXISTS project_agents (
  project  TEXT NOT NULL,
  agent    TEXT NOT NULL,
  PRIMARY KEY (project, agent)
);
CREATE INDEX IF NOT EXISTS idx_project_agents_agent ON project_agents(agent);

-- FTS5 virtual table — mirrors content from messages where channel='content'
-- Kept in sync by the triggers below.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(content, content=messages, content_rowid=id, tokenize='trigram');

-- Triggers to keep messages_fts in sync with messages.channel='content' rows.
CREATE TRIGGER IF NOT EXISTS messages_fts_insert
  AFTER INSERT ON messages
  WHEN NEW.channel = 'content'
BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (NEW.id, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete
  AFTER DELETE ON messages
  WHEN OLD.channel = 'content'
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.id, OLD.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update
  AFTER UPDATE ON messages
  WHEN NEW.channel = 'content' AND NEW.trimmed_at IS NULL
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.id, OLD.content);
  INSERT INTO messages_fts(rowid, content) VALUES (NEW.id, NEW.content);
END;

-- Soft-delete: drop the FTS row when trimmed_at is set on a content row.
CREATE TRIGGER IF NOT EXISTS messages_fts_trim
  AFTER UPDATE OF trimmed_at ON messages
  WHEN OLD.channel = 'content' AND OLD.trimmed_at IS NULL AND NEW.trimmed_at IS NOT NULL
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.id, OLD.content);
END;

-- ── Users & Auth ─────────────────────────────────────────────────────────────
-- Authentication tables. Roles: 'admin' | 'user'.
CREATE TABLE IF NOT EXISTS users (
  id             TEXT    PRIMARY KEY,
  username       TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  role           TEXT    NOT NULL DEFAULT 'user',
  display_name   TEXT,
  email          TEXT,
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  expand_think_bubbles INTEGER NOT NULL DEFAULT 0,
  expand_tool_bubbles  INTEGER NOT NULL DEFAULT 0,
  preferred_language   TEXT,                          -- ISO 639-1; null = inherit project default
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  key_hash     TEXT    NOT NULL UNIQUE,
  prefix       TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- ── Per-user session visibility ──────────────────────────────────────────────
-- Lets a user hide a session from their own chat sidebar without affecting any
-- other user. The session itself remains intact and stays visible under the
-- Messages tab, where the user can unhide it. One row per (user, session).
CREATE TABLE IF NOT EXISTS session_visibility (
  user_id                TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id             TEXT    NOT NULL,
  hidden_from_chat       INTEGER NOT NULL DEFAULT 0,
  is_quick_chat          INTEGER NOT NULL DEFAULT 0,   -- 1 = throwaway session; eligible for inactivity auto-hide
  forked_from_session_id TEXT,                         -- src session id when this row records a fork
  forked_from_message_id INTEGER,                      -- src message id at the fork pivot (null = full copy)
  updated_at             INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_session_visibility_session ON session_visibility(session_id);

-- ── Boards ───────────────────────────────────────────────────────────────────
-- Trello-style kanban per project: configurable swimlanes (columns) with cards
-- that can be assigned to either a user or an agent (mutually exclusive).
-- Cards assigned to an agent can be "run" — see board_card_runs.
-- 1 board per project; the `project` column is the scope key (no separate
-- boards table), consistent with `project_agents`.

CREATE TABLE IF NOT EXISTS board_swimlanes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  position    INTEGER NOT NULL,
  wip_limit   INTEGER,
  auto_run    INTEGER NOT NULL DEFAULT 0,       -- 1 = scheduler tick will auto-run agent cards here
  default_assignee_user_id TEXT,
  default_assignee_agent   TEXT,
  next_swimlane_id         INTEGER,
  color       TEXT,
  lane_group  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(project, name)
);
CREATE INDEX IF NOT EXISTS idx_swimlanes_project ON board_swimlanes(project, position);

CREATE TABLE IF NOT EXISTS board_cards (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project           TEXT    NOT NULL,
  swimlane_id       INTEGER NOT NULL,
  position          INTEGER NOT NULL,             -- sparse, stappen van 100
  title             TEXT    NOT NULL,
  description       TEXT    NOT NULL DEFAULT '',
  assignee_user_id  TEXT,                          -- mutex met assignee_agent
  assignee_agent    TEXT,
  auto_run          INTEGER NOT NULL DEFAULT 0,    -- 1 = eligible for auto-run scan (cleared on enqueue)
  estimate_hours    REAL,
  percent_done      INTEGER,
  original_lang     TEXT,                          -- ISO 639-1 of the source title+description
  source_version    INTEGER NOT NULL DEFAULT 1,    -- bumps on every source-field edit
  created_by        TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cards_project  ON board_cards(project, swimlane_id, position);
CREATE INDEX IF NOT EXISTS idx_cards_assignee ON board_cards(assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_cards_agent    ON board_cards(assignee_agent);

CREATE TABLE IF NOT EXISTS board_card_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id       INTEGER NOT NULL,
  session_id    TEXT    NOT NULL,
  agent         TEXT    NOT NULL,
  triggered_by  TEXT    NOT NULL,                  -- user.id of 'scheduler'
  trigger_kind  TEXT    NOT NULL,                  -- 'manual' | 'scheduled'
  status        TEXT    NOT NULL,                  -- queued | running | done | error
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  final_answer  TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_card_runs_card    ON board_card_runs(card_id, started_at);
CREATE INDEX IF NOT EXISTS idx_card_runs_session ON board_card_runs(session_id);

-- ── Code projects ───────────────────────────────────────────────────────────
-- Per-Bunny-project source-code areas. Each row maps 1:1 to a directory under
-- `<projectDir>/workspace/code/<name>/`. `git_url` is optional; when set, the
-- initial clone runs asynchronously via isomorphic-git and the status machine
-- progresses idle → cloning → ready | error. Public repos only in v1 — scheme
-- is validated at the route boundary (https:// and git:// accepted, others
-- rejected up-front). Soft-delete via deleted_at/deleted_by like documents.
CREATE TABLE IF NOT EXISTS code_projects (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project           TEXT    NOT NULL,
  name              TEXT    NOT NULL,                 -- slug, doubles as directory name
  description       TEXT    NOT NULL DEFAULT '',
  git_url           TEXT,                             -- NULL = no remote, local-only scratch area
  git_ref           TEXT,                             -- branch/tag/ref; NULL = remote HEAD
  git_status        TEXT    NOT NULL DEFAULT 'idle',  -- 'idle' | 'cloning' | 'ready' | 'error'
  git_error         TEXT,
  last_cloned_at    INTEGER,
  graph_status      TEXT    NOT NULL DEFAULT 'idle',  -- 'idle' | 'extracting' | 'clustering' | 'rendering' | 'ready' | 'error'
  graph_error       TEXT,
  graph_node_count  INTEGER,
  graph_edge_count  INTEGER,
  last_graphed_at   INTEGER,
  created_by        TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,                          -- ms; non-null ⇒ soft-deleted (trash bin)
  deleted_by        TEXT,
  UNIQUE(project, name)
);
CREATE INDEX IF NOT EXISTS idx_code_projects_project ON code_projects(project, updated_at);
CREATE INDEX IF NOT EXISTS idx_code_projects_trash   ON code_projects(deleted_at) WHERE deleted_at IS NOT NULL;

-- ── Scheduled tasks ──────────────────────────────────────────────────────────
-- Generiek scheduler-subsysteem: rijen representeren periodiek werk waarvan de
-- naam van de handler de enige koppeling is naar de code. De ticker
-- (src/scheduler/ticker.ts) selecteert rijen met next_run_at <= now, voert de
-- geregistreerde handler uit en berekent de volgende next_run_at via cron.
-- System-taken worden door iedereen ingezien, maar alleen admins mogen ze
-- wijzigen; user-taken zijn eigendom van hun owner_user_id.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id             TEXT    PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN ('system','user')),
  handler        TEXT    NOT NULL,                -- bv. 'board.auto_run_scan'
  name           TEXT    NOT NULL,
  description    TEXT,
  cron_expr      TEXT    NOT NULL,                -- 5-veld cron
  payload        TEXT,                            -- JSON; handler-specifiek
  enabled        INTEGER NOT NULL DEFAULT 1,
  owner_user_id  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  last_run_at    INTEGER,
  last_status    TEXT,                            -- 'ok' | 'error'
  last_error     TEXT,
  next_run_at    INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_due   ON scheduled_tasks(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_sched_owner ON scheduled_tasks(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_sched_kind  ON scheduled_tasks(kind);

-- ── Skills ──────────────────────────────────────────────────────────────────
-- Agent Skills (agentskills.io standard). On-disk content lives at
-- $BUNNY_HOME/skills/<name>/SKILL.md. The DB row stores metadata + provenance.
CREATE TABLE IF NOT EXISTS skills (
  name        TEXT    PRIMARY KEY,
  description TEXT    NOT NULL DEFAULT '',
  visibility  TEXT    NOT NULL DEFAULT 'private',
  source_url  TEXT,
  source_ref  TEXT,
  created_by  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_skills (
  project  TEXT NOT NULL,
  skill    TEXT NOT NULL,
  PRIMARY KEY (project, skill)
);
CREATE INDEX IF NOT EXISTS idx_project_skills_skill ON project_skills(skill);

-- ── Whiteboards ─────────────────────────────────────────────────────────────
-- Per-project Excalidraw whiteboards. Each project can have multiple named
-- whiteboards that store the full Excalidraw elements JSON + a small PNG
-- thumbnail for the sidebar preview.
-- `deleted_at` / `deleted_by` implement soft-delete; the row stays in place so
-- an admin can restore it from the Trash tab or hard-delete it. Because
-- UNIQUE(project, name) cannot be weakened, soft-delete renames the row to
-- `__trash:<id>:<name>` — every list/get query filters `deleted_at IS NULL`.
CREATE TABLE IF NOT EXISTS whiteboards (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project         TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  elements_json   TEXT    NOT NULL DEFAULT '[]',
  app_state_json  TEXT,
  thumbnail       TEXT,                          -- PNG data URL (small, ~200×150)
  created_by      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,                       -- ms; non-null ⇒ soft-deleted (hidden from list)
  deleted_by      TEXT,                          -- user.id who soft-deleted (no FK so legacy rows survive)
  UNIQUE(project, name)
);
CREATE INDEX IF NOT EXISTS idx_whiteboards_project ON whiteboards(project, updated_at);
CREATE INDEX IF NOT EXISTS idx_whiteboards_trash   ON whiteboards(deleted_at) WHERE deleted_at IS NOT NULL;

-- ── Documents ───────────────────────────────────────────────────────────────
-- Per-project rich-text documents. Content is stored as markdown; the WYSIWYG
-- editor (Tiptap) is the ephemeral presentation layer.
CREATE TABLE IF NOT EXISTS documents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project         TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  content_md      TEXT    NOT NULL DEFAULT '',
  thumbnail       TEXT,
  is_template     INTEGER NOT NULL DEFAULT 0,
  original_lang   TEXT,                            -- ISO 639-1 of the source name+content
  source_version  INTEGER NOT NULL DEFAULT 1,      -- bumps on every source-field edit
  created_by      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,                         -- ms; non-null ⇒ soft-deleted (trash bin)
  deleted_by      TEXT,                            -- user.id who soft-deleted
  UNIQUE(project, name)
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project, updated_at);
CREATE INDEX IF NOT EXISTS idx_documents_trash   ON documents(deleted_at) WHERE deleted_at IS NOT NULL;

-- ── Contacts ────────────────────────────────────────────────────────────────
-- Per-project contact management. Emails, phones, and tags are stored as
-- JSON arrays in TEXT columns to avoid join tables for simple lists.
CREATE TABLE IF NOT EXISTS contacts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project        TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  emails         TEXT    NOT NULL DEFAULT '[]',
  phones         TEXT    NOT NULL DEFAULT '[]',
  company        TEXT    NOT NULL DEFAULT '',
  title          TEXT    NOT NULL DEFAULT '',
  notes          TEXT    NOT NULL DEFAULT '',
  avatar         TEXT,
  tags           TEXT    NOT NULL DEFAULT '[]',
  original_lang  TEXT,                           -- ISO 639-1 of the source notes field
  source_version INTEGER NOT NULL DEFAULT 1,     -- bumps on every notes edit
  created_by     TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,                        -- ms; non-null ⇒ soft-deleted (trash bin)
  deleted_by     TEXT                            -- user.id who soft-deleted
);
CREATE INDEX IF NOT EXISTS idx_contacts_project ON contacts(project, name);
CREATE INDEX IF NOT EXISTS idx_contacts_created_by ON contacts(created_by);
CREATE INDEX IF NOT EXISTS idx_contacts_trash ON contacts(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  color       TEXT,
  created_by  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(project, name)
);
CREATE INDEX IF NOT EXISTS idx_contact_groups_project ON contact_groups(project);

CREATE TABLE IF NOT EXISTS contact_group_members (
  group_id    INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_cgm_contact ON contact_group_members(contact_id);

-- ── Knowledge Base: Definitions ──────────────────────────────────────────────
-- Per-project dictionary of project-specific terms. Each row holds up to three
-- candidate descriptions (manual, short LLM, long LLM) plus a list of external
-- source links. `active_description` names the one the project considers
-- authoritative. `llm_cleared` distinguishes "never generated" (llm_cleared=0
-- with NULL fields — future auto-fill scheduler target) from "explicitly
-- cleared by user" (llm_cleared=1, NULL fields — auto-fill skips). `term` is
-- stored COLLATE NOCASE so "Supplier" and "supplier" collide on the
-- UNIQUE(project, term) constraint.
CREATE TABLE IF NOT EXISTS kb_definitions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  project              TEXT    NOT NULL,
  term                 TEXT    NOT NULL COLLATE NOCASE,
  manual_description   TEXT    NOT NULL DEFAULT '',
  llm_short            TEXT,
  llm_long             TEXT,
  llm_sources          TEXT    NOT NULL DEFAULT '[]',   -- JSON: [{title,url}] (language-neutral)
  llm_cleared          INTEGER NOT NULL DEFAULT 0,      -- 1 = user explicitly cleared
  llm_status           TEXT    NOT NULL DEFAULT 'idle', -- 'idle' | 'generating' | 'error'
  llm_error            TEXT,
  llm_generated_at     INTEGER,                         -- Unix ms of last successful generation
  is_project_dependent INTEGER NOT NULL DEFAULT 0,
  active_description   TEXT    NOT NULL DEFAULT 'manual', -- 'manual' | 'short' | 'long'
  original_lang        TEXT,                            -- ISO 639-1 of the source fields
  source_version       INTEGER NOT NULL DEFAULT 1,      -- bumps on every source-field edit
  svg_content          TEXT,                            -- raw SVG markup (language-neutral like llm_sources)
  svg_status           TEXT    NOT NULL DEFAULT 'idle', -- 'idle' | 'generating' | 'error'
  svg_error            TEXT,
  svg_generated_at     INTEGER,                         -- Unix ms of last successful SVG generation
  created_by           TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER,                         -- ms; non-null ⇒ soft-deleted (trash bin)
  deleted_by           TEXT,                            -- user.id who soft-deleted
  UNIQUE(project, term)
);
CREATE INDEX IF NOT EXISTS idx_kb_definitions_project ON kb_definitions(project, term);
CREATE INDEX IF NOT EXISTS idx_kb_definitions_trash   ON kb_definitions(deleted_at) WHERE deleted_at IS NOT NULL;

-- ── Translations ────────────────────────────────────────────────────────────
-- Per-entity sidecar tables. Each holds one row per (entity, target-language)
-- except the entity's own `original_lang` — the entity columns themselves are
-- the source copy. `source_hash` is sha256(JSON.stringify(sourceFields)) at
-- the time of translation; it lets the scheduler skip regeneration when a
-- revert brings source back to a previously-translated state even though
-- `source_version` has moved. `translating_at` supports the daily stuck-row
-- sweep (src/translation/sweep_stuck_handler.ts).

CREATE TABLE IF NOT EXISTS kb_definition_translations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id      INTEGER NOT NULL REFERENCES kb_definitions(id) ON DELETE CASCADE,
  lang               TEXT    NOT NULL,
  term               TEXT,
  manual_description TEXT,
  llm_short          TEXT,
  llm_long           TEXT,
  status             TEXT    NOT NULL DEFAULT 'pending', -- 'pending'|'translating'|'ready'|'error'
  error              TEXT,
  source_version     INTEGER NOT NULL,
  source_hash        TEXT,
  translating_at     INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(definition_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_kb_def_trans_lookup  ON kb_definition_translations(definition_id, lang);
CREATE INDEX IF NOT EXISTS idx_kb_def_trans_pending ON kb_definition_translations(status, source_version);

CREATE TABLE IF NOT EXISTS document_translations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  lang            TEXT    NOT NULL,
  name            TEXT,
  content_md      TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending',
  error           TEXT,
  source_version  INTEGER NOT NULL,
  source_hash     TEXT,
  translating_at  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(document_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_doc_trans_lookup  ON document_translations(document_id, lang);
CREATE INDEX IF NOT EXISTS idx_doc_trans_pending ON document_translations(status, source_version);

CREATE TABLE IF NOT EXISTS contact_translations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  lang            TEXT    NOT NULL,
  notes           TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending',
  error           TEXT,
  source_version  INTEGER NOT NULL,
  source_hash     TEXT,
  translating_at  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(contact_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_contact_trans_lookup  ON contact_translations(contact_id, lang);
CREATE INDEX IF NOT EXISTS idx_contact_trans_pending ON contact_translations(status, source_version);

CREATE TABLE IF NOT EXISTS board_card_translations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id         INTEGER NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
  lang            TEXT    NOT NULL,
  title           TEXT,
  description     TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending',
  error           TEXT,
  source_version  INTEGER NOT NULL,
  source_hash     TEXT,
  translating_at  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(card_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_card_trans_lookup  ON board_card_translations(card_id, lang);
CREATE INDEX IF NOT EXISTS idx_card_trans_pending ON board_card_translations(status, source_version);

-- ── Web News ────────────────────────────────────────────────────────────────
-- Per-project periodic news aggregator. Each topic carries its own agent,
-- search terms (JSON array), an update cron + optional renew-terms cron, and
-- self-scheduling next-run timestamps. The scan handler
-- (src/web_news/auto_run_handler.ts) fires once per minute, selects due rows,
-- and dispatches runTopic which calls runAgent with web tools available.
-- Items are append-only; content_hash is sha256(normalizedUrl + normalizedTitle)
-- so a re-run that finds the same story bumps seen_count instead of inserting.
CREATE TABLE IF NOT EXISTS web_news_topics (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  project                   TEXT    NOT NULL,
  name                      TEXT    NOT NULL,
  description               TEXT    NOT NULL DEFAULT '',
  agent                     TEXT    NOT NULL,
  terms                     TEXT    NOT NULL DEFAULT '[]',  -- JSON array<string>
  update_cron               TEXT    NOT NULL,
  renew_terms_cron          TEXT,                            -- NULL when not scheduled
  always_regenerate_terms   INTEGER NOT NULL DEFAULT 0,      -- 1 = regen terms every update
  max_items_per_run         INTEGER NOT NULL DEFAULT 10,
  enabled                   INTEGER NOT NULL DEFAULT 1,
  run_status                TEXT    NOT NULL DEFAULT 'idle', -- 'idle' | 'running'
  next_update_at            INTEGER NOT NULL,
  next_renew_terms_at       INTEGER,
  last_run_at               INTEGER,
  last_run_status           TEXT,                            -- 'ok' | 'error'
  last_run_error            TEXT,
  last_session_id           TEXT,
  created_by                TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  UNIQUE(project, name)
);
CREATE INDEX IF NOT EXISTS idx_web_news_topics_project ON web_news_topics(project);
CREATE INDEX IF NOT EXISTS idx_web_news_topics_due     ON web_news_topics(enabled, next_update_at);

CREATE TABLE IF NOT EXISTS web_news_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id          INTEGER NOT NULL REFERENCES web_news_topics(id) ON DELETE CASCADE,
  project           TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  summary           TEXT    NOT NULL DEFAULT '',
  url               TEXT,
  image_url         TEXT,
  source            TEXT,
  published_at      INTEGER,
  content_hash      TEXT    NOT NULL,
  seen_count        INTEGER NOT NULL DEFAULT 1,
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  UNIQUE(topic_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_web_news_items_topic_time   ON web_news_items(topic_id, published_at DESC, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_news_items_project_time ON web_news_items(project, first_seen_at DESC);

-- ── User notifications ──────────────────────────────────────────────────────
-- Per-user (cross-project) notifications. v1 trigger: @username mentions in
-- chat prompts; extensible to future triggers (board-card assignment, task
-- completion, …) via the `kind` column. Actor name + display name are
-- denormalised so the panel still reads correctly after the actor user is
-- deleted. `read_at` is NULL for unread. `deep_link` is an app-relative query
-- string the frontend parses on boot. The dispatcher prunes to the newest
-- 200 rows per user on insert to keep the list bounded.
CREATE TABLE IF NOT EXISTS notifications (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                TEXT    NOT NULL,          -- 'mention' | 'mention_blocked' | (future)
  title               TEXT    NOT NULL,
  body                TEXT    NOT NULL DEFAULT '',
  actor_user_id       TEXT    REFERENCES users(id) ON DELETE SET NULL,
  actor_username      TEXT,                        -- denormalised so the panel survives user deletion
  actor_display_name  TEXT,
  project             TEXT,                        -- nullable (future triggers may not be project-scoped)
  session_id          TEXT,
  message_id          INTEGER,
  deep_link           TEXT    NOT NULL DEFAULT '',
  read_at             INTEGER,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_time
  ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

-- ── Telegram integration ─────────────────────────────────────────────────────
-- Per-project Telegram bot configuration + per-(user, project) chat linking.
-- See ADR 0028. Bot tokens are per-project; linking is per-(user, project)
-- because the bot itself is project-scoped. Outbound deliveries (mentions,
-- card runs, news digests) are additional channels beside the SSE fanout —
-- they skip when the recipient has no link for that project.
CREATE TABLE IF NOT EXISTS project_telegram_config (
  project          TEXT    PRIMARY KEY REFERENCES projects(name) ON DELETE CASCADE,
  bot_token        TEXT    NOT NULL UNIQUE,
  bot_username     TEXT    NOT NULL,
  transport        TEXT    NOT NULL CHECK(transport IN ('poll','webhook')) DEFAULT 'poll',
  webhook_secret   TEXT,                                            -- set when transport='webhook'
  last_update_id   INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  poll_lease_until INTEGER NOT NULL DEFAULT 0,                      -- ticker race-safety
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_telegram_config_enabled
  ON project_telegram_config(enabled, transport, poll_lease_until);

CREATE TABLE IF NOT EXISTS user_telegram_links (
  user_id            TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project            TEXT    NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  chat_id            INTEGER NOT NULL,
  tg_username        TEXT,
  current_session_id TEXT,                                          -- rolling session for this chat
  busy_until         INTEGER NOT NULL DEFAULT 0,                    -- per-chat serialisation mutex
  linked_at          INTEGER NOT NULL,
  PRIMARY KEY (user_id, project),
  UNIQUE (project, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_user_telegram_links_project
  ON user_telegram_links(project, chat_id);

CREATE TABLE IF NOT EXISTS telegram_pending_links (
  link_token  TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project     TEXT    NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_pending_links_user
  ON telegram_pending_links(user_id, expires_at);

-- Optional per-topic Web News subscribers for Telegram digests. When no row
-- exists for a topic, the digest falls back to the topic creator only.
CREATE TABLE IF NOT EXISTS web_news_topic_subscriptions (
  topic_id  INTEGER NOT NULL REFERENCES web_news_topics(id) ON DELETE CASCADE,
  user_id   TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (topic_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_web_news_topic_subs_user
  ON web_news_topic_subscriptions(user_id);

-- Inbound update_id dedup (poison-message safety — advancing last_update_id
-- before processing ensures a malformed update can't wedge the bot, and this
-- table makes the "already processed" check O(1)).
CREATE TABLE IF NOT EXISTS telegram_seen_updates (
  project    TEXT    NOT NULL,
  update_id  INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL,
  PRIMARY KEY (project, update_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_seen_updates_time
  ON telegram_seen_updates(seen_at);

-- ── Workflows ────────────────────────────────────────────────────────────────
-- Per-project TOML-defined DAG pipelines. The definition lives on disk at
-- $BUNNY_HOME/projects/<project>/workflows/<slug>.toml; this row is the DB
-- index + stores the xyflow layout + per-(workflow,node) first-run bash
-- approval hashes. Soft-delete via deleted_at/deleted_by (see trash.ts).
CREATE TABLE IF NOT EXISTS workflows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project         TEXT    NOT NULL,
  slug            TEXT    NOT NULL,                 -- filename stem; immutable
  name            TEXT    NOT NULL,
  description     TEXT,
  toml_sha256     TEXT    NOT NULL,                 -- detects on-disk drift
  layout_json     TEXT,                             -- xyflow node x/y positions
  bash_approvals  TEXT,                             -- JSON map nodeId -> sha256(cmd)
  created_by      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,                          -- ms; non-null = soft-deleted
  deleted_by      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(project, slug)
);
CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows(project, deleted_at);
CREATE INDEX IF NOT EXISTS idx_workflows_trash   ON workflows(deleted_at) WHERE deleted_at IS NOT NULL;

-- One row per workflow execution. The umbrella session_id is the SSE fanout
-- key and the ask_user registry key. toml_snapshot freezes the definition at
-- run start so mid-run edits never contaminate a running run.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id    INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  project        TEXT    NOT NULL,
  session_id     TEXT    NOT NULL,                  -- umbrella session for the run
  status         TEXT    NOT NULL,                  -- queued | running | done | error | cancelled | paused
  trigger_kind   TEXT    NOT NULL DEFAULT 'manual', -- manual | scheduled | api
  triggered_by   TEXT    REFERENCES users(id) ON DELETE SET NULL,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  error          TEXT,
  toml_snapshot  TEXT    NOT NULL                   -- frozen definition for replay
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status   ON workflow_runs(status, started_at);

-- Per-node execution records. iteration = 0 for non-loop nodes; loop nodes
-- get one row per iteration, monotonically increasing.
CREATE TABLE IF NOT EXISTS workflow_run_nodes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id           TEXT    NOT NULL,               -- matches toml [[nodes]].id
  kind              TEXT    NOT NULL,               -- prompt | bash | loop | interactive
  status            TEXT    NOT NULL,               -- pending | running | waiting | done | error | skipped
  iteration         INTEGER NOT NULL DEFAULT 0,
  child_session_id  TEXT,                           -- runAgent session (prompt/loop) or null
  started_at        INTEGER,
  finished_at       INTEGER,
  result_text       TEXT,                           -- final answer / bash stdout tail / answer text
  log_text          TEXT,                           -- accumulated per-node buffer, persisted on finish
  error             TEXT,
  steps_json        TEXT,                           -- structured per-step records for the timeline UI
  UNIQUE(run_id, node_id, iteration)
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_nodes_run ON workflow_run_nodes(run_id, id);

-- ── Embeddings ───────────────────────────────────────────────────────────────
-- Created dynamically by db.ts using the configured dimension (default 1536)
-- because the dimension must be baked into the vec0 CREATE statement.
-- Template (replaced at init time):
--   CREATE VIRTUAL TABLE IF NOT EXISTS embeddings
--     USING vec0(message_id INTEGER PRIMARY KEY, embedding FLOAT[{dim}]);
