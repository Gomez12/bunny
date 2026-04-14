/**
 * Database layer.
 *
 * Opens (or creates) the SQLite database under BUNNY_HOME, loads sqlite-vec,
 * and runs the schema / migrations. All other memory modules import `getDb()`
 * to get the shared instance.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../paths.ts";
import { errorMessage } from "../util/error.ts";

// sqlite-vec is loaded lazily on first DB open to avoid blocking module init.
let sqliteVecLoad: ((db: { loadExtension(f: string, e?: string): void }) => void) | undefined;
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
export async function openDb(dbPath: string, embedDim = 1536): Promise<Database> {
  await ensureSqliteVec();

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");

  if (sqliteVecLoad) {
    try {
      sqliteVecLoad(db);
    } catch (e) {
      console.warn("[bunny/db] Could not load sqlite-vec extension:", errorMessage(e));
    }
  }

  applySchema(db, embedDim);
  return db;
}

function applySchema(db: Database, embedDim: number): void {
  // Read the static schema from schema.sql (adjacent to this file).
  const schemaPath = join(import.meta.dir, "schema.sql");
  const schemaSql = readFileSync(schemaPath, "utf8");

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
      // Skip expected errors like "table already exists" when IF NOT EXISTS is absent.
      if (!errorMessage(e).includes("already exists")) throw e;
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
    if (!msg.includes("no such module") && !msg.includes("already exists")) throw e;
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
