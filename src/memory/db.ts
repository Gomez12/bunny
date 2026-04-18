/**
 * Database layer.
 *
 * Opens (or creates) the SQLite database under BUNNY_HOME, loads sqlite-vec,
 * and runs the schema / migrations. All other memory modules import `getDb()`
 * to get the shared instance.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../paths.ts";
import { errorMessage } from "../util/error.ts";
// Static import so Bun embeds the file in compiled binaries.
import schemaSql from "./schema.sql" with { type: "text" };

// sqlite-vec is loaded lazily on first DB open to avoid blocking module init.
let sqliteVecLoad:
  | ((db: { loadExtension(f: string, e?: string): void }) => void)
  | undefined;
let sqliteVecAttempted = false;

async function ensureSqliteVec(): Promise<void> {
  if (sqliteVecAttempted) return;
  sqliteVecAttempted = true;
  try {
    const mod = await import("sqlite-vec");
    sqliteVecLoad = mod.load;
  } catch {
    // sqlite-vec binary not available — vector search degrades to empty results.
  }
}

export interface DbOptions {
  /** Override path, useful in tests. Defaults to paths.db(). */
  dbPath?: string;
  /** Embedding dimension. Must match model output. Default 1536. */
  embedDim?: number;
}

let _db: Database | undefined;
let _dbPath: string | undefined;

/** Return the shared database, opening and migrating it if necessary. */
export async function getDb(opts: DbOptions = {}): Promise<Database> {
  const dbPath = opts.dbPath ?? paths.db();
  if (_db && _dbPath === dbPath) return _db;
  _db = await openDb(dbPath, opts.embedDim ?? 1536);
  _dbPath = dbPath;
  return _db;
}

/** Open a database at `dbPath`, applying schema and loading extensions. */
export async function openDb(
  dbPath: string,
  embedDim = 1536,
): Promise<Database> {
  await ensureSqliteVec();

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA temp_store = MEMORY");
  db.run("PRAGMA mmap_size = 268435456");
  db.run("PRAGMA cache_size = -65536");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_size_limit = 67108864");

  if (sqliteVecLoad) {
    try {
      sqliteVecLoad(db);
    } catch (e) {
      console.warn(
        "[bunny/db] Could not load sqlite-vec extension:",
        errorMessage(e),
      );
    }
  }

  applySchema(db, embedDim);
  migrateColumns(db);
  return db;
}

/**
 * Idempotent column additions for existing databases. SQLite errors with
 * "duplicate column name" when a column already exists — we swallow that and
 * treat any other error as fatal. Schema is append-only by convention.
 */
function migrateColumns(db: Database): void {
  const addColumn = (ddl: string) => {
    try {
      db.run(ddl);
    } catch (e) {
      const msg = errorMessage(e);
      if (!msg.includes("duplicate column")) throw e;
    }
  };
  addColumn("ALTER TABLE messages ADD COLUMN ok INTEGER");
  addColumn("ALTER TABLE messages ADD COLUMN duration_ms INTEGER");
  addColumn("ALTER TABLE messages ADD COLUMN prompt_tokens INTEGER");
  addColumn("ALTER TABLE messages ADD COLUMN completion_tokens INTEGER");
  addColumn("ALTER TABLE messages ADD COLUMN user_id TEXT");
  addColumn("ALTER TABLE messages ADD COLUMN project TEXT");
  addColumn("ALTER TABLE messages ADD COLUMN author TEXT");
  addColumn("ALTER TABLE messages ADD COLUMN attachments TEXT");
  addColumn("ALTER TABLE events ADD COLUMN user_id TEXT");
  addColumn(
    "ALTER TABLE board_swimlanes ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 0",
  );
  addColumn(
    "ALTER TABLE board_cards ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 0",
  );
  addColumn(
    "ALTER TABLE board_swimlanes ADD COLUMN default_assignee_user_id TEXT",
  );
  addColumn(
    "ALTER TABLE board_swimlanes ADD COLUMN default_assignee_agent TEXT",
  );
  addColumn("ALTER TABLE board_swimlanes ADD COLUMN next_swimlane_id INTEGER");
  addColumn("ALTER TABLE board_swimlanes ADD COLUMN color TEXT");
  addColumn("ALTER TABLE board_swimlanes ADD COLUMN lane_group TEXT");
  addColumn("ALTER TABLE board_cards ADD COLUMN estimate_hours REAL");
  addColumn("ALTER TABLE board_cards ADD COLUMN percent_done INTEGER");
  addColumn(
    "ALTER TABLE users ADD COLUMN expand_think_bubbles INTEGER NOT NULL DEFAULT 0",
  );
  addColumn(
    "ALTER TABLE users ADD COLUMN expand_tool_bubbles INTEGER NOT NULL DEFAULT 0",
  );
  addColumn(
    "ALTER TABLE documents ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0",
  );
  // ── Multi-language support ────────────────────────────────────────────────
  addColumn(
    "ALTER TABLE projects ADD COLUMN languages TEXT NOT NULL DEFAULT '[\"en\"]'",
  );
  addColumn(
    "ALTER TABLE projects ADD COLUMN default_language TEXT NOT NULL DEFAULT 'en'",
  );
  addColumn("ALTER TABLE users ADD COLUMN preferred_language TEXT");
  for (const t of ["kb_definitions", "documents", "contacts", "board_cards"]) {
    addColumn(`ALTER TABLE ${t} ADD COLUMN original_lang TEXT`);
    addColumn(
      `ALTER TABLE ${t} ADD COLUMN source_version INTEGER NOT NULL DEFAULT 1`,
    );
  }
  // Backfill original_lang once for legacy rows.
  db.run(
    `UPDATE kb_definitions
       SET original_lang = COALESCE(
         (SELECT default_language FROM projects WHERE projects.name = kb_definitions.project),
         'en'
       )
     WHERE original_lang IS NULL`,
  );
  db.run(
    `UPDATE documents
       SET original_lang = COALESCE(
         (SELECT default_language FROM projects WHERE projects.name = documents.project),
         'en'
       )
     WHERE original_lang IS NULL`,
  );
  db.run(
    `UPDATE contacts
       SET original_lang = COALESCE(
         (SELECT default_language FROM projects WHERE projects.name = contacts.project),
         'en'
       )
     WHERE original_lang IS NULL`,
  );
  db.run(
    `UPDATE board_cards
       SET original_lang = COALESCE(
         (SELECT default_language FROM projects WHERE projects.name = board_cards.project),
         'en'
       )
     WHERE original_lang IS NULL`,
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)");
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_session_user ON messages(session_id, user_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project, ts)",
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author)");
  // Covers the per-session first-user-row lookup used by listSessions.
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_session_role_channel_ts ON messages(session_id, role, channel, ts)",
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)");

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_cards_swimlane ON board_cards(swimlane_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_card_runs_status_card ON board_card_runs(status, card_id)",
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, ts)");

  db.run("PRAGMA optimize");

  // Auto-seed the 'general' project so every install has a default workspace.
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO projects(name, description, visibility, created_by, created_at, updated_at)
     VALUES ('general', 'Default project', 'public', NULL, ?, ?)`,
    [now, now],
  );
}

function applySchema(db: Database, embedDim: number): void {
  // Remove single-line comments before splitting, to avoid false ";" matches
  // inside comment text.
  const stripped = schemaSql.replace(/--[^\n]*/g, "");

  // Split into individual statements. We can't naively split on ";" because
  // trigger bodies contain ";" inside BEGIN...END blocks. We split on ";"
  // only when we're NOT inside a BEGIN...END block.
  const statements = splitSqlStatements(stripped);

  for (const stmt of statements) {
    try {
      db.run(stmt);
    } catch (e) {
      const msg = errorMessage(e);
      // Skip expected errors when running the declarative schema against an
      // already-migrated DB: tables/indexes already exist, or a statement
      // references a column that only gets added later by migrateColumns.
      if (!msg.includes("already exists") && !msg.includes("no such column"))
        throw e;
    }
  }

  // Embeddings table — dimension is baked in, created separately.
  try {
    db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS embeddings
         USING vec0(message_id INTEGER PRIMARY KEY, embedding FLOAT[${embedDim}])`,
    );
  } catch (e) {
    const msg = errorMessage(e);
    // Not fatal if sqlite-vec is absent.
    if (!msg.includes("no such module") && !msg.includes("already exists"))
      throw e;
  }
}

/**
 * Split a multi-statement SQL string into individual statements, correctly
 * handling trigger bodies that contain ";" inside BEGIN...END blocks.
 */
function splitSqlStatements(sql: string): string[] {
  const results: string[] = [];
  let depth = 0; // nesting depth of BEGIN...END blocks
  let current = "";

  // Tokenise very simply: we only care about the keywords BEGIN, END, and ";".
  const tokenRe = /\bBEGIN\b|\bEND\b|;/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(sql)) !== null) {
    const token = match[0]!.toUpperCase();
    if (token === "BEGIN") {
      depth++;
    } else if (token === "END") {
      depth = Math.max(0, depth - 1);
    } else if (token === ";" && depth === 0) {
      current += sql.slice(lastIndex, match.index);
      const trimmed = current.trim();
      if (trimmed) results.push(trimmed);
      current = "";
      lastIndex = match.index + 1;
      continue;
    }
    current += sql.slice(lastIndex, match.index + match[0].length);
    lastIndex = match.index + match[0].length;
  }

  // Append any remainder after the last ";".
  current += sql.slice(lastIndex);
  const trimmed = current.trim();
  if (trimmed) results.push(trimmed);

  return results;
}

/** Close and reset the shared singleton (useful in tests). */
export function closeDb(): void {
  _db?.close();
  _db = undefined;
  _dbPath = undefined;
}
