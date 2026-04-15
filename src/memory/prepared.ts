/**
 * Prepared-statement cache keyed by (Database, sql).
 *
 * `bun:sqlite`'s `db.prepare()` re-parses SQL on every call. Hot paths — message
 * inserts, auth middleware, recall — call the same SQL thousands of times per
 * session, so we memoise the `Statement` per `Database` instance. A WeakMap
 * keeps the cache GC-safe when a test DB is closed.
 */

import type { Database, Statement } from "bun:sqlite";

const cache = new WeakMap<Database, Map<string, Statement>>();

export function prep(db: Database, sql: string): Statement {
  let inner = cache.get(db);
  if (!inner) {
    inner = new Map();
    cache.set(db, inner);
  }
  let stmt = inner.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    inner.set(sql, stmt);
  }
  return stmt;
}
