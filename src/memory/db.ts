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
  addColumn("ALTER TABLE messages ADD COLUMN edited_at INTEGER");
  addColumn("ALTER TABLE messages ADD COLUMN trimmed_at INTEGER");
  addColumn("ALTER TABLE messages ADD COLUMN regen_of_message_id INTEGER");
  // Discriminates rows produced by scheduled / background runAgent invocations
  // (web-news, board card runs, kb auto-generate, contact/business soul refresh,
  // business auto-build, translation auto-translate, memory.refresh itself) so
  // memory.refresh stops merging its own output back in. See ADR 0034.
  addColumn(
    "ALTER TABLE messages ADD COLUMN from_automation INTEGER NOT NULL DEFAULT 0",
  );
  addColumn(
    "ALTER TABLE session_visibility ADD COLUMN is_quick_chat INTEGER NOT NULL DEFAULT 0",
  );
  addColumn(
    "ALTER TABLE session_visibility ADD COLUMN forked_from_session_id TEXT",
  );
  addColumn(
    "ALTER TABLE session_visibility ADD COLUMN forked_from_message_id INTEGER",
  );
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
  // ── KB definition illustrations (SVG) ────────────────────────────────────
  addColumn("ALTER TABLE kb_definitions ADD COLUMN svg_content TEXT");
  addColumn(
    "ALTER TABLE kb_definitions ADD COLUMN svg_status TEXT NOT NULL DEFAULT 'idle'",
  );
  addColumn("ALTER TABLE kb_definitions ADD COLUMN svg_error TEXT");
  addColumn("ALTER TABLE kb_definitions ADD COLUMN svg_generated_at INTEGER");
  // ── Multi-language support ────────────────────────────────────────────────
  addColumn(
    "ALTER TABLE projects ADD COLUMN languages TEXT NOT NULL DEFAULT '[\"en\"]'",
  );
  addColumn(
    "ALTER TABLE projects ADD COLUMN default_language TEXT NOT NULL DEFAULT 'en'",
  );
  addColumn("ALTER TABLE users ADD COLUMN preferred_language TEXT");
  // Per-user "soul" (personality + style) — auto-curated by memory.refresh.
  addColumn("ALTER TABLE users ADD COLUMN soul TEXT NOT NULL DEFAULT ''");
  addColumn(
    "ALTER TABLE users ADD COLUMN soul_status TEXT NOT NULL DEFAULT 'idle'",
  );
  addColumn("ALTER TABLE users ADD COLUMN soul_error TEXT");
  addColumn(
    "ALTER TABLE users ADD COLUMN soul_watermark_message_id INTEGER NOT NULL DEFAULT 0",
  );
  addColumn("ALTER TABLE users ADD COLUMN soul_refreshed_at INTEGER");
  addColumn("ALTER TABLE users ADD COLUMN soul_refreshing_at INTEGER");
  addColumn("ALTER TABLE users ADD COLUMN soul_manual_edited_at INTEGER");
  for (const t of ["kb_definitions", "documents", "contacts", "board_cards"]) {
    addColumn(`ALTER TABLE ${t} ADD COLUMN original_lang TEXT`);
    addColumn(
      `ALTER TABLE ${t} ADD COLUMN source_version INTEGER NOT NULL DEFAULT 1`,
    );
  }
  // Soft-delete / trash bin — see ADR 0025.
  for (const t of ["documents", "whiteboards", "contacts", "kb_definitions"]) {
    addColumn(`ALTER TABLE ${t} ADD COLUMN deleted_at INTEGER`);
    addColumn(`ALTER TABLE ${t} ADD COLUMN deleted_by TEXT`);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_${t}_trash ON ${t}(deleted_at) WHERE deleted_at IS NOT NULL`,
    );
  }
  // ── Contacts: socials + per-contact soul ─────────────────────────────────
  addColumn(
    "ALTER TABLE contacts ADD COLUMN socials TEXT NOT NULL DEFAULT '[]'",
  );
  addColumn("ALTER TABLE contacts ADD COLUMN soul TEXT NOT NULL DEFAULT ''");
  addColumn(
    "ALTER TABLE contacts ADD COLUMN soul_status TEXT NOT NULL DEFAULT 'idle'",
  );
  addColumn("ALTER TABLE contacts ADD COLUMN soul_error TEXT");
  addColumn("ALTER TABLE contacts ADD COLUMN soul_refreshed_at INTEGER");
  addColumn("ALTER TABLE contacts ADD COLUMN soul_refreshing_at INTEGER");
  addColumn("ALTER TABLE contacts ADD COLUMN soul_manual_edited_at INTEGER");
  addColumn("ALTER TABLE contacts ADD COLUMN soul_next_refresh_at INTEGER");
  addColumn("ALTER TABLE contacts ADD COLUMN soul_sources TEXT");
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_contacts_soul_refresh
       ON contacts(soul_status, soul_next_refresh_at) WHERE deleted_at IS NULL`,
  );
  // Translation sidecar: soul gets its own translated column (ADR 0036).
  addColumn("ALTER TABLE contact_translations ADD COLUMN soul TEXT");
  // Per-project opt-in for business auto-build handler (ADR 0036).
  addColumn(
    "ALTER TABLE projects ADD COLUMN auto_build_businesses INTEGER NOT NULL DEFAULT 0",
  );
  // Business postal address — auto-filled from website during soul refresh.
  addColumn("ALTER TABLE businesses ADD COLUMN address TEXT");
  addColumn("ALTER TABLE businesses ADD COLUMN address_fetched_at INTEGER");
  // Workflows — structured per-node step records for the run timeline UI.
  addColumn("ALTER TABLE workflow_run_nodes ADD COLUMN steps_json TEXT");
  // Code sub-app: per-project knowledge-graph status (ADR 0033).
  addColumn(
    "ALTER TABLE code_projects ADD COLUMN graph_status TEXT NOT NULL DEFAULT 'idle'",
  );
  addColumn("ALTER TABLE code_projects ADD COLUMN graph_error TEXT");
  addColumn("ALTER TABLE code_projects ADD COLUMN graph_node_count INTEGER");
  addColumn("ALTER TABLE code_projects ADD COLUMN graph_edge_count INTEGER");
  addColumn("ALTER TABLE code_projects ADD COLUMN last_graphed_at INTEGER");
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
  // One-shot backfill of from_automation for rows written before the column
  // existed. Idempotent via the from_automation = 0 predicate. Board card
  // runs use a bare randomUUID() session id, so they're caught via the
  // board_card_runs join; everything else has a stable session prefix.
  db.run(
    `UPDATE messages SET from_automation = 1
      WHERE from_automation = 0
        AND (
             session_id LIKE 'web-news-%'
          OR session_id LIKE 'contact-soul-%'
          OR session_id LIKE 'business-soul-%'
          OR session_id LIKE 'business-build-%'
          OR session_id LIKE 'kb-def-%'
          OR session_id LIKE 'translate-%'
          OR session_id LIKE 'memory-user-%'
          OR session_id LIKE 'memory-agent-%'
          OR session_id LIKE 'memory-soul-%'
          OR session_id IN (SELECT session_id FROM board_card_runs)
        )`,
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
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_regen_of ON messages(regen_of_message_id)",
  );
  // Backs the cursor pagination on getMessagesBySession (limit + before_id).
  // Without this the planner falls back to a temp B-tree for ORDER BY id DESC.
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id)",
  );
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
