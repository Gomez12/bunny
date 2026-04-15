# ADR 0008 — Projects

**Status:** Accepted
**Datum:** 2026-04-15

## Context

Tot nu toe zat alle conversatie-state in één platte pot: messages gescoped op `session_id` (+ `user_id`). Zodra Bunny voor meerdere werkzaamheden tegelijk wordt ingezet (een R&D-chat, een interne support-chat, een team-wiki) wil je per context:

- Een eigen **system prompt** (toon, domeinkennis, restricties).
- Geïsoleerde **recall** — geen kruisbestuiving tussen contexten.
- Later per context: skills, prompt shortcuts, wiki-bestanden.
- Zichtbaarheid als een zelfstandig ding in de UI ("ga naar project X").

Dit ADR introduceert het concept **project**: een logische werkruimte met zowel een DB-row (metadata) als een eigen directory op schijf.

## Beslissing

1. **Project = sessie-attribuut, opgeslagen per message.** Elke `messages`-row krijgt een `project` kolom. Een sessie hoort tot precies één project; dat wordt afgeleid uit elke willekeurige row van die sessie. Project-wissel in de UI start verplicht een nieuwe sessie.
2. **Default project `general`.** Bij elke DB-open wordt hij `INSERT OR IGNORE`-gezet. Legacy/NULL-project rows lezen terug als `general` via `COALESCE(project, 'general')` in elke read.
3. **Append-only migratie.** Alleen `ALTER TABLE messages ADD COLUMN project TEXT` + nieuwe `projects` tabel + `idx_messages_project`. Geen backfill; NULL blijft NULL.
4. **On-disk directory = source of truth voor prompt-tekst.** Elk project heeft `$BUNNY_HOME/projects/<name>/systemprompt.toml` met velden `prompt` en `append` (bool). De DB bevat alleen metadata (`description`, `visibility`, `created_by`, `created_at`, `updated_at`). PATCH schrijft de TOML opnieuw — geen drift tussen DB en disk.
5. **`append` flag bepaalt composition.** `append=true` (default): projectprompt komt ná de basisprompt. `append=false`: projectprompt **vervangt** de basisprompt volledig (power-user override).
6. **Recall is project-scoped.** `hybridRecall`, `searchBM25` en `searchVector` krijgen een optionele `project`-parameter. BM25 filtert via `COALESCE(m.project,'general') = ?`; vector gebruikt over-fetch + post-filter (vec0 ondersteunt geen joins in MATCH).
7. **Naam = PK en directory — immutable.** Een rename impliceert DB + schijf atomair houden; niet waard. Alleen `description`, `visibility` en de prompt zijn editeerbaar. Regex: `^[a-z0-9][a-z0-9_-]{0,62}$`, plus denylist (`.`, `..`, `node_modules`, leeg).
8. **Zichtbaarheid voorbereid, maar default public.** `projects.visibility` = `'public'|'private'`, default `'public'`. Publieke projecten zijn voor elke authenticated user zichtbaar en bruikbaar; private projecten alleen voor admin + creator. Dit laat room voor toekomstige privacy zonder nu complexiteit te introduceren.
9. **CLI `--project <name>` auto-creëert.** Onbekende naam → DB-row + `projects/<name>/systemprompt.toml` stub. Bij `--session <bestaand>` + `--project` die niet overeenkomt: harde error (één project per sessie).
10. **HTTP: `/api/projects` (CRUD) + `?project=` op `/api/sessions` + `project` in `/api/chat` body.** Mismatch tussen body-project en bestaande sessie → 409.
11. **Configureerbare defaults.** De naam van het default project en de basis system-prompt staan onder `[agent]` in `bunny.config.toml` (`default_project`, `system_prompt`; env: `BUNNY_DEFAULT_PROJECT` / `BUNNY_SYSTEM_PROMPT`). `runAgent` krijgt ze via `agentCfg`; bij boot seedt zowel CLI als server het geconfigureerde default project náást de permanent aanwezige `general`. Zo blijft `general` de stabiele legacy-fallback in SQL (`COALESCE(project,'general')`) terwijl een team een eigen "werkruimte"-naam kan kiezen.

## Gevolgen

- **Geen backfill-runbook**: bestaande `.bunny`-directories blijven werken, alles wat vóór deze commit staat lijkt vanzelf `general`.
- **Recall kleiner en gerichter** — "general" verzuipt niet in gemengde context.
- **Toekomstige per-project assets** (skills, shortcuts, wiki) hoeven alleen `loadProjectAssets(name)` aan te vullen; de systemprompt-pipeline is al klaar om extra velden mee te nemen.
- **Sessie ↔ project binding is impliciet** via messages. `runAgent` + `/api/chat` beschermen tegen project-mismatch; de web UI start voor alle zekerheid een nieuwe sessie bij project-wissel.

## Alternatieven

- *Project op `sessions`-tabel*: we hebben geen `sessions`-tabel; één per message houdt de migratie triviaal en maakt queries (recall, listSessions, sidebar) een simpele WHERE-clause.
- *Prompt-tekst in DB*: zou een tweede bewaarlocatie toevoegen naast de TOML. Nu is de TOML editeerbaar vanaf schijf én vanuit de web UI — één bron.
- *Projects als bunny-config fields*: te statisch; gebruikers willen in de web UI runtime aanmaken.

## Verificatie

- `bun test tests/memory/projects.test.ts` — 10 tests (CRUD, validatie, default seed, `getSessionProject`, NULL-legacy).
- `bun test tests/memory/project_scoping.test.ts` — BM25 en `listSessions` scoping.
- `bun test tests/agent/prompt.test.ts` — append vs. replace, legacy positionele call.
- End-to-end: web UI Projects-tab → create → card-click → chat antwoordt volgens de project-instructies → Messages-tab filtert op project.
