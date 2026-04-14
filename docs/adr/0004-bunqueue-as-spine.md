# ADR 0004 — bunqueue als audit-spine

**Status:** Accepted
**Datum:** 2026-04-14

## Context

Elk zinvol event in de agent (LLM-request, tool-call, memory-index) moet worden opgeslagen voor:
1. **Observability**: wat heeft de agent gedaan?
2. **Reproducibility**: een sessie reconstrueren.
3. **Debugging**: waarom heeft de agent dit besloten?
4. **Toekomstige web-UI**: events/messages tonen in een timeline.

Opties: directe synchrone SQLite-writes, een event-bus (EventEmitter), of een persistente job-queue.

## Beslissing

**bunqueue** als embedded job-queue. Elke LLM-call, tool-call en memory-index-actie wordt als job gepusht op de queue. De processor schrijft het event naar de `events` tabel. De agent-loop wacht niet op de queue — logging is fire-and-forget.

## Onderbouwing

- **bunqueue is Bun-native**: geen Redis, geen externe server, embedded mode (`embedded: true`).
- **Audit-semantiek**: de queue geeft durabiliteit (jobs overleven crashes als de agent tijdens verwerking stopt) en at-least-once delivery.
- **Separation of concerns**: de agent-loop doet de echte werk (LLM-call, tool-call), en laat het loggen over aan de queue. De loop wordt niet geblokkeerd door I/O van de logger.
- **Uitbreidbaar**: dezelfde queue kan later gebruikt worden voor echte async job-dispatch (bijv. een LLM-call in een aparte worker) door de processor te vervangen.
- **Topics als job-namen**: `llm.request`, `llm.response`, `tool.call`, `tool.result`, `memory.index` — querybaar in de `events` tabel via `topic` en `kind` kolommen.

## Consequenties

- Logging is async: vlak na `q.log(...)` is het event nog niet in de DB. In tests is `await q.close()` nodig om te wachten tot de queue gedraineerd is.
- Bunqueue beheert zijn eigen in-memory state (LRU maps voor job-tracking). Bij abnormaal afsluiten van de process kunnen in-flight logs verloren gaan. Acceptabel voor een logging-use-case.
- Elke `createBunnyQueue(db)` aanroep maakt een nieuwe Bunqueue-instantie met een uniek naam (counter). Dit voorkomt state-conflicten in tests.

## Alternatieven verworpen

- **Directe synchrone SQLite-writes**: eenvoudig maar blokkeert de event-loop (geen WAL-voordeel in hot path).
- **Node EventEmitter**: geen persistentie; events verdwijnen als process crasht.
- **BullMQ**: vereist Redis; breekt de "zero external services" eis.
