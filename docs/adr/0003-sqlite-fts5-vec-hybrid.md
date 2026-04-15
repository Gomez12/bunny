# ADR 0003 — SQLite + FTS5 (BM25) + sqlite-vec for hybrid memory

**Status:** Accepted
**Date:** 2026-04-14

## Context

The agent needs persistent memory that supports two kinds of recall:
1. **Lexical recall** (exact / near-exact matches, name lookups): BM25 full-text search.
2. **Semantic recall** (conceptual similarity, paraphrase): vector k-NN.

Combining them via Reciprocal Rank Fusion (RRF) yields better recall than either alone (shown in TREC evaluations).

## Decision

- **SQLite** as the only database (phase 1). Portable: one file, per cwd.
- **FTS5 with trigram tokenizer** for BM25-like lexical search.
- **sqlite-vec** (libvec extension) for vector k-NN via the `vec0` virtual table.
- **RRF** (`recall.ts`) as the merge strategy with k=60 (standard constant).
- Upgrade path to Postgres + pgvector: `db.ts` exports a `DBDriver` interface; the SQLite implementation is swappable.

## Rationale

- **Portability**: SQLite files are relocatable with the project. No server process. `bun:sqlite` is built in.
- **Trigram tokenizer**: language-agnostic (no stemming required), good for code and technical terms.
- **sqlite-vec**: single-file extension (`.dylib`/`.so`), no extra server. Installed via npm; Bun loads it via `loadExtension()`.
- **Graceful degradation**: if sqlite-vec cannot be loaded (Bun < some version, CI), recall falls back to BM25 only — no crash.
- **`messages.channel`**: content and reasoning are stored as separate rows. FTS5 and embeddings only index `channel='content'` (unless `[memory].index_reasoning = true`). This keeps internal reasoning processes out of recall.

## Schema decisions

- Embeddings dimension is baked in at creation of the `vec0` table (default 1536 for `text-embedding-3-small`).
- `messages_fts` is a `content=` table (pointing at `messages`) to halve storage; triggers keep it in sync.
- `events` is an append-only log — no UPDATE/DELETE on events.

## Consequences

- Bun 1.3.5 doesn't have `loadExtension` active by default — sqlite-vec cannot be loaded in the current default Bun build. The fallback (BM25-only) works. For production use: compile Bun with `SQLITE_ENABLE_LOAD_EXTENSION` or wait for a Bun release that enables it by default.
- Dimension mismatch between the embedding model and the `vec0` schema yields an error on insert. Config `[embed].dim` must match.

## Alternatives rejected

- **Postgres + pgvector**: excellent for production but requires a server process; breaks the portability requirement.
- **Chroma / Qdrant**: external vector database; too heavy for embedded use.
- **LanceDB**: Rust-native, no native Bun support.
