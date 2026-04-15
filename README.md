# Bunny

A Bun-native AI agent. Minimal architecture, queue-backed logging, hybrid memory (BM25 + vector) from day one.

## Status

Fase 1 (MVP) — in ontwikkeling. Zie [`docs/README.md`](./docs/README.md) voor architectuur en [`docs/adr/`](./docs/adr/) voor design-beslissingen.

## Quick start

```sh
bun install
cp .env.example .env     # fill LLM_API_KEY
bun run src/index.ts "list the files in src/"
```

State komt in `./.bunny/` (override met `BUNNY_HOME`). Database is SQLite, alles is portable.

### Projects

Alle messages horen bij een **project** — een logische werkruimte met eigen system prompt (in `projects/<name>/systemprompt.toml`) en gescheiden recall. Het default project heet `general`. Maak een nieuw project aan vanuit de web-UI ("Projects"-tab → `+ New project`), of direct op de CLI:

```sh
bun run src/index.ts --project alpha "schrijf een intro voor dit project"
```

De CLI maakt DB-row en directory automatisch aan als ze nog niet bestaan. Switchen tussen projecten start een nieuwe sessie — één sessie hoort bij precies één project. Zie [ADR 0008](./docs/adr/0008-projects.md).

### Agents

Een **agent** is een benoemde persoonlijkheid met eigen system prompt en een beperkte tool-set. Maak er één aan in de web-UI ("Agents"-tab → `+ New agent`), koppel 'm aan een project, en roep 'm aan in de Chat door je bericht te beginnen met `@naam`:

```
@bob zoek uit of er duplicate functies zijn in src/tools
```

Agents kunnen ook met elkaar praten: zet `is_subagent` aan op een agent en voeg 'm toe aan `allowed_subagents` van een orchestrator, dan krijgt die orchestrator de `call_agent(name, prompt)` tool. De context-scope (`full` of `own`) bepaalt of een agent de hele session kan zien of alleen zijn eigen eerdere antwoorden — handig voor eenmalige specialisten. Zie [ADR 0009](./docs/adr/0009-agents.md).

### Boards

Elk project heeft een eigen **kanban-board**. Open de **Board**-tab in de web-UI: standaard zie je de swimlanes Todo / Doing / Done, sleep cards ertussen of hernoem/verwijder lanes als admin of project-owner. Een card kan toegewezen worden aan een **user** of een **agent** — niet allebei tegelijk.

Cards met een agent-assignee kun je via de **Run**-knop in de card-dialog laten uitvoeren: bunny stuurt `title + description` als prompt naar de agent, streamt de output live in de card, en bewaart het uiteindelijke antwoord op de run-row. "Open in Chat" deep-linkt naar de bijbehorende sessie zodat je de hele trace (incl. tool-calls en reasoning) kunt nakijken. Re-runs blijven als geschiedenis op de card staan. Zie [ADR 0010](./docs/adr/0010-project-boards.md).

## Web UI

Bunny heeft ook een tab-based web-UI: **Chat** (live streaming), **Messages** (alle eerdere sessies uit SQLite, doorzoekbaar via BM25), **Board** (kanban per project, met optionele auto-run per swimlane en per card), **Files** (workspace-bestanden per project, upload/download/drag-and-drop), **Tasks** (systeem- en gebruikertaken met cron-schedule), **Projects**, **Agents** en **Settings**.

```sh
# terminal 1 — backend (Bun HTTP + SSE)
bun run serve                       # of: bun run src/index.ts serve

# terminal 2 — frontend (Vite dev server, proxy naar :3000)
cd web && bun install && bun run dev
# open http://localhost:5173
```

Voor productie: `bun run web:build` bouwt `web/dist/`, daarna serveert `bun run serve` zowel de API als de statische bundle op één poort.

Voor een portable binary met **alles erin** (CLI + server + embedded web-UI):

```sh
bun run build                        # bouwt web/dist en compileert voor alle platforms
# of één platform:
bun run build:platform darwin-arm64
./dist/bunny-darwin-arm64 serve      # UI op http://localhost:3000
```

De Vite-bundle wordt bij `build` als `import … with { type: "file" }` in het binary geëmbed via een gegenereerde manifest (`src/server/web_bundle.ts`); de stub wordt na de compile weer teruggezet zodat git schoon blijft.

Zie [`docs/adr/0006-web-ui.md`](./docs/adr/0006-web-ui.md) voor de architectuurkeuzes.

## Authentication

Bij de eerste `bunny serve` boot maakt de server een admin aan op basis van je config (default: `admin` / `change-me`). Je moet bij de eerste login in de web-UI een nieuw wachtwoord kiezen.

Configureer in `bunny.config.toml`:

```toml
[auth]
default_admin_username = "admin"
default_admin_password = "change-me"   # override via BUNNY_DEFAULT_ADMIN_PASSWORD
session_ttl_hours = 168                # 7 dagen
```

Users beheer je in de web-UI onder **Settings → Users** (admin-only). Gewone users zien alleen hun eigen sessies; admins zien alles.

### CLI met een API key

Elke user kan in **Settings → API keys** een key met naam + optionele expiry aanmaken. Het plaintext secret is één keer zichtbaar — bewaar het direct.

```sh
BUNNY_API_KEY=bny_xxxx_yyyy bun run src/index.ts "hoi"
# of
bun run src/index.ts --api-key bny_xxxx_yyyy "hoi"
```

Zonder key draait de CLI onder de geseedde `system` user (backward-compat).

Zie [`docs/adr/0007-auth-and-users.md`](./docs/adr/0007-auth-and-users.md) voor de architectuurkeuzes.

## Development

```sh
bun test          # unit + integration
bun run typecheck
bun run docs      # generate TypeDoc → docs/api/
```
