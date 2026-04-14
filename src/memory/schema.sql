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
  user_id      TEXT                         -- owning user (null for anonymous/historical)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);

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

-- ── Embeddings ───────────────────────────────────────────────────────────────
-- Created dynamically by db.ts using the configured dimension (default 1536)
-- because the dimension must be baked into the vec0 CREATE statement.
-- Template (replaced at init time):
--   CREATE VIRTUAL TABLE IF NOT EXISTS embeddings
--     USING vec0(message_id INTEGER PRIMARY KEY, embedding FLOAT[{dim}]);
