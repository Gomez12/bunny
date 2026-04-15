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
  author       TEXT                         -- responding agent name (null = default assistant)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);
-- idx_messages_project is created in db.ts:migrateColumns so it also works on
-- upgraded databases where the `project` column is added by ALTER TABLE.

-- ── Projects ─────────────────────────────────────────────────────────────────
-- Logical workspaces: each project has its own directory under $BUNNY_HOME/projects/<name>/
-- and its own systemprompt.toml that augments (or replaces) the base system prompt.
CREATE TABLE IF NOT EXISTS projects (
  name        TEXT    PRIMARY KEY,
  description TEXT,
  visibility  TEXT    NOT NULL DEFAULT 'public',  -- 'public' | 'private'
  created_by  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
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
  WHEN NEW.channel = 'content'
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.id, OLD.content);
  INSERT INTO messages_fts(rowid, content) VALUES (NEW.id, NEW.content);
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
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id       TEXT    NOT NULL,
  hidden_from_chat INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
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

-- ── Embeddings ───────────────────────────────────────────────────────────────
-- Created dynamically by db.ts using the configured dimension (default 1536)
-- because the dimension must be baked into the vec0 CREATE statement.
-- Template (replaced at init time):
--   CREATE VIRTUAL TABLE IF NOT EXISTS embeddings
--     USING vec0(message_id INTEGER PRIMARY KEY, embedding FLOAT[{dim}]);
