# Add a tool

## When you need this

Your agent needs a new capability — read something, call something, fetch something — and the existing tools don't cover it.

## Two kinds

- **Static** — goes in the global `ToolRegistry`. No per-run state. Example: a pure math helper.
- **Dynamic / closure-bound** — built per run with project / db / userId baked in. Spliced into the run-scoped registry by `buildRunRegistry` in `src/agent/loop.ts`. Examples: `board_*` tools, `workspace_*` tools, `web_*` tools, `call_agent`, `activate_skill`, `ask_user`.

Pick **dynamic** if the tool touches per-run state (project scope, user id, a specific resource id). Pick **static** if it's pure.

## Steps — static tool

1. Add the handler in `src/tools/<your_tool>.ts`:
   ```ts
   import type { Tool } from "../agent/tool_registry";

   export const myTool: Tool = {
     name: "my_tool",
     description: "Short sentence describing what it does.",
     parameters: {
       type: "object",
       properties: {
         foo: { type: "string", description: "…" },
       },
       required: ["foo"],
     },
     async handler({ foo }) {
       return { result: `did the thing with ${foo}` };
     },
   };
   ```
2. Register it in `src/agent/tool_registry.ts` (the base registry that `runAgent` starts from).
3. Add it to the relevant `*_TOOL_NAMES` array if it's part of a group (e.g. `BOARD_TOOL_NAMES`).
4. Write a test under `tests/tools/my_tool.test.ts`.

## Steps — dynamic / closure-bound tool

1. Add a factory in `src/tools/<your_feature>.ts`:
   ```ts
   export function makeMyTool(
     project: string,
     db: Database,
     userId: string | null,
   ): Tool {
     return {
       name: "my_tool",
       description: "…",
       parameters: { /* … */ },
       async handler(args) {
         // project, db, userId are captured in the closure
         // so a tool in project 'alpha' cannot reach project 'beta'.
         return { /* … */ };
       },
     };
   }
   ```
2. Splice it into `buildRunRegistry` in `src/agent/loop.ts`. Follow the pattern used by `makeBoardTools`:
   ```ts
   const myTools = makeMyTool(project, db, userId);
   registry.extend(myTools);
   ```
3. Add the name to `DYNAMIC_TOOL_NAMES` in `loop.ts` so `/api/tools` surfaces it and the agent picker can offer it.
4. Write a test.

## If the tool should be gated

Some tools must only be available in specific contexts — e.g. `ask_user` only in live chat, not in background runs.

- Add a `RunAgentOptions` flag (e.g. `askUserEnabled`).
- Gate the splice in `buildRunRegistry` on that flag.
- Only set the flag from the contexts that support it (`POST /api/chat`, regenerate).

## Validation

```sh
bun test tests/tools/my_tool.test.ts
bun run src/index.ts "use my_tool to do the thing"
```

For dynamic tools, also verify via the UI that `/api/tools` lists it (so the agent picker shows the checkbox).

## Related

- [`../concepts/agent-loop.md`](../concepts/agent-loop.md)
- [`../entities/agents.md`](../entities/agents.md) — tool whitelists.
- `src/tools/board.ts` — reference example for a closure-bound tool group.
