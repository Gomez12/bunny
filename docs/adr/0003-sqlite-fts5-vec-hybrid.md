# ADR 0003 — SQLite + FTS5 (BM25) + sqlite-vec voor hybride memory

**Status:** Accepted
**Datum:** 2026-04-14

## Context

De agent heeft persistente memory nodig die twee soorten recall ondersteunt:
1. **Lexicale recall** (exact / near-exact matches, naam-lookups): BM25 full-text search.
2. **Semantische recall** (conceptuele gelijkenis, parafrase): vector k-NN.

Combinatie via Reciprocal Rank Fusion (RRF) geeft betere recall dan elk afzonderlijk (bewezen in TREC-evaluaties).

## Beslissing

- **SQLite** als enige database (fase 1). Portable: één bestand, per cwd.
- **FTS5 met trigram-tokenizer** voor BM25-achtige lexicale search.
- **sqlite-vec** (libvec extension) voor vector k-NN via `vec0` virtual table.
- **RRF** (`recall.ts`) als merge-strategie met k=60 (standaard constant).
- Upgrade-pad naar Postgres + pgvector: `db.ts` exporteert een `DBDriver`-interface; de SQLite-implementatie is vervangbaar.

## Onderbouwing

- **Portability**: SQLite files zijn meeverhuisbaar met het project. Geen server-process. `bun:sqlite` is ingebouwd.
- **Trigram tokenizer**: werkt taalonafhankelijk (geen stemming vereist), goed voor code en technische termen.
- **sqlite-vec**: single-file extension (`.dylib`/`.so`), geen extra server. Geïnstalleerd via npm; Bun laadt het via `loadExtension()`.
- **Graceful degradation**: als sqlite-vec niet geladen kan worden (Bun < bepaalde versie, CI), valt recall terug op alleen BM25 — geen crash.
- **`messages.channel`**: content en reasoning worden als aparte rijen opgeslagen. FTS5 en embeddings indexeren alleen `channel='content'` (tenzij `[memory].index_reasoning = true`). Dit voorkomt dat interne redeneerprocessen de recall vervuilen.

## Schema-beslissingen

- Embeddings-dimensie is baked in bij aanmaken van de `vec0` tabel (default 1536 voor `text-embedding-3-small`).
- `messages_fts` is een `content=` tabel (verwijst naar `messages`) om opslagruimte te halve; triggers houden sync.
- `events` is een append-only log — geen UPDATE/DELETE op events.

## Consequenties

- Bun 1.3.5 heeft `loadExtension` niet standaard actief — sqlite-vec kan niet geladen worden in de huidige standaard Bun-build. De fallback (BM25-only) werkt. Voor productie-gebruik: Bun compileren met `SQLITE_ENABLE_LOAD_EXTENSION` of wachten op Bun-release die dit standaard activeert.
- Dimensie-mismatch tussen embedding-model en `vec0` schema geeft een error bij insert. Config `[embed].dim` moet matchen.

## Alternatieven verworpen

- **Postgres + pgvector**: uitstekend voor productie maar vereist een server-process; breekt de portability-eis.
- **Chroma / Qdrant**: externe vector-database; te zwaar voor embedded gebruik.
- **LanceDB**: Rust-native, geen native Bun-support.
