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
  UNIQUE(project, name)
);
CREATE INDEX IF NOT EXISTS idx_whiteboards_project ON whiteboards(project, updated_at);

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
  UNIQUE(project, name)
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project, updated_at);

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
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_project ON contacts(project, name);
CREATE INDEX IF NOT EXISTS idx_contacts_created_by ON contacts(created_by);

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
  created_by           TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE(project, term)
);
CREATE INDEX IF NOT EXISTS idx_kb_definitions_project ON kb_definitions(project, term);

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

-- ── Embeddings ───────────────────────────────────────────────────────────────
-- Created dynamically by db.ts using the configured dimension (default 1536)
-- because the dimension must be baked into the vec0 CREATE statement.
-- Template (replaced at init time):
--   CREATE VIRTUAL TABLE IF NOT EXISTS embeddings
--     USING vec0(message_id INTEGER PRIMARY KEY, embedding FLOAT[{dim}]);
