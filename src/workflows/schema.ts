/**
 * Workflow TOML schema — hand-rolled validator + serializer + topological
 * sort. Matches the repo's no-zod convention; every other subsystem (agents,
 * skills, boards) does its own shape checks.
 *
 * A workflow definition is a DAG of nodes. Each node is exactly one of:
 *   - `prompt = "..."`               →  kind = "prompt"     (single runAgent call)
 *   - `bash = "..."`                 →  kind = "bash"       (gated shell command)
 *   - `[nodes.loop]` block           →  kind = "loop"       (iterate until stop-token)
 *   - `interactive = true` alone     →  kind = "interactive" (stand-alone approval gate)
 *
 * `depends_on = ["id", ...]` declares DAG edges. v1 runs the topological
 * order strictly serially — parallel sibling execution is out of scope.
 *
 * Invariants (enforced by `parseWorkflowToml`):
 *   - node id: /^[a-z0-9][a-z0-9_-]{0,63}$/, unique across the workflow
 *   - exactly one of { prompt, bash, loop } OR standalone `interactive: true`
 *   - depends_on references known ids
 *   - no cycles (Kahn's algorithm below)
 *   - loop.until non-empty, loop.max_iterations in [1, 100]
 *
 * The parser is used at **save time** (route rejects invalid TOML with 400)
 * **and** at **run time** (engine re-parses the frozen `toml_snapshot`). Keep
 * it pure — no disk, no DB.
 */

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type NodeKind =
  | "prompt"
  | "bash"
  | "script"
  | "loop"
  | "interactive"
  | "for_each"
  | "if_then_else";

export interface LoopSpec {
  prompt: string;
  /**
   * Human-readable stop condition. The engine wraps it in `<<<${until}>>>`
   * so the agent can assert completion. `ALL_TASKS_COMPLETE` and `APPROVED`
   * are the canonical ones; any other non-empty string is accepted.
   */
  until: string;
  /** Mint a new sessionId per iteration (default false — share umbrella). */
  fresh_context?: boolean;
  /** Splice `ask_user` tool on every iteration (human-in-the-loop coach). */
  interactive?: boolean;
  /** Cap on iterations. Default 10, clamped to [1, 100]. */
  max_iterations?: number;
}

/**
 * For-each iterates over a collection and runs `body` once per item. Exactly
 * one of `items` / `count` must be set.
 *
 *   `items` = a templated string (e.g. `"{{nodes.list.output}}"`). At runtime
 *     the engine interpolates variables then tries to parse the result as a
 *     JSON array. Falls back to newline-split non-empty lines.
 *   `count` = a templated string that resolves to an integer; the body runs
 *     `count` times with `item` = the 1-based iteration number.
 *
 * `body` is an array of node ids that belong to this for-each. Those nodes
 * are removed from the top-level topological order and dispatched inside
 * each iteration (serially, in declaration order).
 *
 * `item_var` (default "item") and `index_var` (default "iteration") name the
 * variables available to body nodes as `{{item}}` / `{{iteration}}`.
 */
export interface ForEachSpec {
  items?: string;
  count?: string;
  body: string[];
  item_var?: string;
  index_var?: string;
  /** Hard cap for safety — default 50, clamped to [1, 1000]. */
  max_iterations?: number;
}

/**
 * If-then-else branches based on a templated condition. After interpolation
 * the result is trimmed and tested: empty / "0" / "false" / "no" / "null"
 * (case-insensitive) → falsy, anything else → truthy.
 */
export interface IfThenElseSpec {
  condition: string;
  then_body: string[];
  else_body: string[];
}

export interface WorkflowNode {
  id: string;
  depends_on: string[];
  kind: NodeKind;
  prompt?: string;
  bash?: string;
  /**
   * JavaScript / TypeScript code executed via `bun -e`. Runs in a fresh
   * child Bun process with the same gates as `bash` (global enable flag,
   * first-run approval, cwd = workspace, timeout + output cap).
   */
  script?: string;
  loop?: LoopSpec;
  for_each?: ForEachSpec;
  if_then_else?: IfThenElseSpec;
  /** Stand-alone approval gate when kind === "interactive". */
  interactive?: boolean;
  /** Override the project's default agent for this node. */
  agent?: string;
  /** Per-node timeout. For bash/script nodes, clamped at runtime to [1, 600_000]. */
  timeout_ms?: number;
}

export interface WorkflowDef {
  name: string;
  description?: string;
  nodes: WorkflowNode[];
}

export interface ParseResult {
  def?: WorkflowDef;
  errors: string[];
}

interface RawNode {
  id?: unknown;
  depends_on?: unknown;
  prompt?: unknown;
  bash?: unknown;
  script?: unknown;
  loop?: unknown;
  interactive?: unknown;
  agent?: unknown;
  timeout_ms?: unknown;
}

const ALLOWED_NODE_KEYS = new Set([
  "id",
  "depends_on",
  "prompt",
  "bash",
  "script",
  "loop",
  "for_each",
  "if_then_else",
  "interactive",
  "agent",
  "timeout_ms",
]);

const ALLOWED_LOOP_KEYS = new Set([
  "prompt",
  "until",
  "fresh_context",
  "interactive",
  "max_iterations",
]);

const ALLOWED_FOR_EACH_KEYS = new Set([
  "items",
  "count",
  "body",
  "item_var",
  "index_var",
  "max_iterations",
]);

const ALLOWED_IF_KEYS = new Set(["condition", "then_body", "else_body"]);

const ALLOWED_TOP_KEYS = new Set(["name", "description", "nodes"]);

// ── Public API ───────────────────────────────────────────────────────────────

export function parseWorkflowToml(text: string): ParseResult {
  const errors: string[] = [];
  let raw: unknown;
  try {
    const parser = (
      Bun as unknown as { TOML?: { parse(src: string): unknown } }
    ).TOML;
    if (!parser) {
      errors.push("Bun.TOML unavailable — require Bun ≥ 1.1");
      return { errors };
    }
    raw = parser.parse(text);
  } catch (e) {
    errors.push(`TOML parse error: ${(e as Error).message}`);
    return { errors };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("workflow must be a TOML table at the top level");
    return { errors };
  }

  const top = raw as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      errors.push(`unknown top-level key '${key}'`);
    }
  }

  const rawName = top["name"];
  const name =
    typeof rawName === "string" && rawName.trim() ? rawName.trim() : "";
  if (!name) errors.push("missing 'name'");

  const rawDescription = top["description"];
  const description =
    typeof rawDescription === "string" ? rawDescription : undefined;

  const rawNodes = top["nodes"];
  if (!Array.isArray(rawNodes)) {
    errors.push("'nodes' must be an array of [[nodes]] tables");
    return { errors };
  }
  if (rawNodes.length === 0) {
    errors.push("workflow has no nodes");
  }

  const nodes: WorkflowNode[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i] as RawNode;
    const ctx = `nodes[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${ctx}: must be a table`);
      continue;
    }
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_NODE_KEYS.has(key)) {
        errors.push(`${ctx}: unknown key '${key}'`);
      }
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) {
      errors.push(`${ctx}: missing 'id'`);
      continue;
    }
    if (!ID_RE.test(id)) {
      errors.push(
        `${ctx}: id '${id}' does not match /^[a-z0-9][a-z0-9_-]{0,63}$/`,
      );
      continue;
    }
    if (seenIds.has(id)) {
      errors.push(`${ctx}: duplicate id '${id}'`);
      continue;
    }
    seenIds.add(id);

    const depends_on: string[] = [];
    if (raw.depends_on !== undefined) {
      if (!Array.isArray(raw.depends_on)) {
        errors.push(`${ctx}: 'depends_on' must be a string array`);
      } else {
        for (const d of raw.depends_on) {
          if (typeof d !== "string" || !d.trim()) {
            errors.push(`${ctx}: 'depends_on' entries must be non-empty strings`);
            continue;
          }
          depends_on.push(d.trim());
          if (d.trim() === id) {
            errors.push(`${ctx}: node '${id}' depends on itself`);
          }
        }
      }
    }

    // Exactly one body-kind must be set. `interactive = true` is a stand-alone
    // approval gate (no body-kind needed).
    const rawForEach = (raw as Record<string, unknown>)["for_each"];
    const rawIfThen = (raw as Record<string, unknown>)["if_then_else"];
    const hasPrompt = typeof raw.prompt === "string" && raw.prompt.length > 0;
    const hasBash = typeof raw.bash === "string" && raw.bash.length > 0;
    const hasScript = typeof raw.script === "string" && raw.script.length > 0;
    const hasLoop =
      raw.loop !== undefined && raw.loop !== null && typeof raw.loop === "object";
    const hasForEach =
      rawForEach !== undefined &&
      rawForEach !== null &&
      typeof rawForEach === "object";
    const hasIfThen =
      rawIfThen !== undefined &&
      rawIfThen !== null &&
      typeof rawIfThen === "object";
    const interactiveFlag = raw.interactive === true;
    const kindCount =
      (hasPrompt ? 1 : 0) +
      (hasBash ? 1 : 0) +
      (hasScript ? 1 : 0) +
      (hasLoop ? 1 : 0) +
      (hasForEach ? 1 : 0) +
      (hasIfThen ? 1 : 0);
    if (kindCount > 1) {
      errors.push(
        `${ctx}: node '${id}' must have exactly one of prompt / bash / script / loop / for_each / if_then_else`,
      );
      continue;
    }
    if (kindCount === 0 && !interactiveFlag) {
      errors.push(
        `${ctx}: node '${id}' has no prompt, bash, script, loop, for_each, if_then_else, or interactive=true`,
      );
      continue;
    }

    let kind: NodeKind;
    if (hasPrompt) kind = "prompt";
    else if (hasBash) kind = "bash";
    else if (hasScript) kind = "script";
    else if (hasLoop) kind = "loop";
    else if (hasForEach) kind = "for_each";
    else if (hasIfThen) kind = "if_then_else";
    else kind = "interactive";

    const node: WorkflowNode = { id, depends_on, kind };
    if (hasPrompt) node.prompt = raw.prompt as string;
    if (hasBash) node.bash = raw.bash as string;
    if (hasScript) node.script = raw.script as string;
    if (hasLoop) {
      const loop = parseLoop(raw.loop as Record<string, unknown>, ctx, errors);
      if (loop) node.loop = loop;
    }
    if (hasForEach) {
      const spec = parseForEach(
        rawForEach as Record<string, unknown>,
        ctx,
        errors,
      );
      if (spec) node.for_each = spec;
    }
    if (hasIfThen) {
      const spec = parseIfThenElse(
        rawIfThen as Record<string, unknown>,
        ctx,
        errors,
      );
      if (spec) node.if_then_else = spec;
    }
    if (interactiveFlag) node.interactive = true;
    if (typeof raw.agent === "string" && raw.agent.trim()) {
      node.agent = raw.agent.trim();
    }
    if (raw.timeout_ms !== undefined) {
      const n = Number(raw.timeout_ms);
      if (!Number.isFinite(n) || n <= 0) {
        errors.push(`${ctx}: timeout_ms must be a positive number`);
      } else {
        node.timeout_ms = Math.floor(n);
      }
    }
    nodes.push(node);
  }

  // depends_on resolution check.
  for (const n of nodes) {
    for (const dep of n.depends_on) {
      if (!seenIds.has(dep)) {
        errors.push(`node '${n.id}': depends_on references unknown id '${dep}'`);
      }
    }
  }

  // Body-ownership validation: each body id must exist, no node may appear
  // in more than one body, a node cannot own itself, and a body id may not
  // also appear in the owner's depends_on.
  const ownerOf = new Map<string, string>();
  const validateBody = (ownerId: string, kind: string, ids: string[]) => {
    for (const bid of ids) {
      if (!seenIds.has(bid)) {
        errors.push(
          `node '${ownerId}': ${kind} references unknown id '${bid}'`,
        );
        continue;
      }
      if (bid === ownerId) {
        errors.push(`node '${ownerId}': ${kind} cannot contain itself`);
        continue;
      }
      const prev = ownerOf.get(bid);
      if (prev && prev !== ownerId) {
        errors.push(
          `node '${bid}': already owned by '${prev}', cannot also be in ${kind} of '${ownerId}'`,
        );
        continue;
      }
      ownerOf.set(bid, ownerId);
    }
  };
  for (const n of nodes) {
    if (n.for_each) validateBody(n.id, "for_each.body", n.for_each.body);
    if (n.if_then_else) {
      validateBody(n.id, "if_then_else.then_body", n.if_then_else.then_body);
      validateBody(n.id, "if_then_else.else_body", n.if_then_else.else_body);
    }
  }

  // Cycle detection via Kahn's algorithm.
  if (errors.length === 0 && nodes.length > 0) {
    try {
      computeTopo({ name, description, nodes });
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  if (errors.length > 0) return { errors };
  return { def: { name, description, nodes }, errors: [] };
}

function parseForEach(
  raw: Record<string, unknown>,
  ctx: string,
  errors: string[],
): ForEachSpec | undefined {
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_FOR_EACH_KEYS.has(k)) {
      errors.push(`${ctx}.for_each: unknown key '${k}'`);
    }
  }
  const items =
    typeof raw["items"] === "string" ? (raw["items"] as string) : undefined;
  const count =
    typeof raw["count"] === "string" ? (raw["count"] as string) : undefined;
  if (!items && !count) {
    errors.push(`${ctx}.for_each: must set one of 'items' or 'count'`);
    return undefined;
  }
  if (items && count) {
    errors.push(`${ctx}.for_each: set only one of 'items' or 'count'`);
    return undefined;
  }
  const bodyRaw = raw["body"];
  if (!Array.isArray(bodyRaw) || bodyRaw.length === 0) {
    errors.push(`${ctx}.for_each: 'body' must be a non-empty array of node ids`);
    return undefined;
  }
  const body: string[] = [];
  for (const b of bodyRaw) {
    if (typeof b !== "string" || !b.trim()) {
      errors.push(`${ctx}.for_each.body: entries must be non-empty strings`);
      continue;
    }
    body.push(b.trim());
  }
  const spec: ForEachSpec = { body };
  if (items) spec.items = items;
  if (count) spec.count = count;
  if (typeof raw["item_var"] === "string" && (raw["item_var"] as string).trim()) {
    spec.item_var = (raw["item_var"] as string).trim();
  }
  if (
    typeof raw["index_var"] === "string" &&
    (raw["index_var"] as string).trim()
  ) {
    spec.index_var = (raw["index_var"] as string).trim();
  }
  if (raw["max_iterations"] !== undefined) {
    const n = Number(raw["max_iterations"]);
    if (!Number.isFinite(n) || n < 1 || n > 1000) {
      errors.push(`${ctx}.for_each: max_iterations must be in [1, 1000]`);
    } else {
      spec.max_iterations = Math.floor(n);
    }
  }
  return spec;
}

function parseIfThenElse(
  raw: Record<string, unknown>,
  ctx: string,
  errors: string[],
): IfThenElseSpec | undefined {
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_IF_KEYS.has(k)) {
      errors.push(`${ctx}.if_then_else: unknown key '${k}'`);
    }
  }
  const condition =
    typeof raw["condition"] === "string"
      ? (raw["condition"] as string).trim()
      : "";
  if (!condition) {
    errors.push(`${ctx}.if_then_else: missing 'condition'`);
    return undefined;
  }
  const parseBranch = (key: "then_body" | "else_body"): string[] => {
    const arr = raw[key];
    if (arr === undefined) return [];
    if (!Array.isArray(arr)) {
      errors.push(`${ctx}.if_then_else.${key}: must be an array of node ids`);
      return [];
    }
    const out: string[] = [];
    for (const b of arr) {
      if (typeof b !== "string" || !b.trim()) {
        errors.push(`${ctx}.if_then_else.${key}: entries must be non-empty strings`);
        continue;
      }
      out.push(b.trim());
    }
    return out;
  };
  const then_body = parseBranch("then_body");
  const else_body = parseBranch("else_body");
  if (then_body.length === 0 && else_body.length === 0) {
    errors.push(
      `${ctx}.if_then_else: at least one of then_body or else_body must be non-empty`,
    );
    return undefined;
  }
  return { condition, then_body, else_body };
}

function parseLoop(
  raw: Record<string, unknown>,
  ctx: string,
  errors: string[],
): LoopSpec | undefined {
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_LOOP_KEYS.has(k)) {
      errors.push(`${ctx}.loop: unknown key '${k}'`);
    }
  }
  const rawPrompt = raw["prompt"];
  const prompt = typeof rawPrompt === "string" ? rawPrompt : "";
  if (!prompt) {
    errors.push(`${ctx}.loop: missing 'prompt'`);
    return undefined;
  }
  const rawUntil = raw["until"];
  const until = typeof rawUntil === "string" ? rawUntil.trim() : "";
  if (!until) {
    errors.push(`${ctx}.loop: missing 'until'`);
    return undefined;
  }
  const spec: LoopSpec = { prompt, until };
  if (raw["fresh_context"] !== undefined)
    spec.fresh_context = raw["fresh_context"] === true;
  if (raw["interactive"] !== undefined)
    spec.interactive = raw["interactive"] === true;
  if (raw["max_iterations"] !== undefined) {
    const n = Number(raw["max_iterations"]);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      errors.push(`${ctx}.loop: max_iterations must be in [1, 100]`);
    } else {
      spec.max_iterations = Math.floor(n);
    }
  }
  return spec;
}

/**
 * Return node ids in topological order. Throws on cycle.
 *
 * v1 is serial: callers walk the array in order. Sibling branches that could
 * run in parallel are still emitted in a deterministic order (declaration
 * order among ready nodes) to keep logs reproducible.
 */
export function computeTopo(def: WorkflowDef): string[] {
  const indeg = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const n of def.nodes) {
    indeg.set(n.id, 0);
    edges.set(n.id, []);
  }
  for (const n of def.nodes) {
    for (const dep of n.depends_on) {
      if (!indeg.has(dep)) continue; // already reported by parser
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
      edges.get(dep)!.push(n.id);
    }
  }
  const ready: string[] = [];
  // Preserve declaration order among ready nodes — deterministic.
  for (const n of def.nodes) if ((indeg.get(n.id) ?? 0) === 0) ready.push(n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of edges.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) ready.push(next);
    }
  }
  if (order.length !== def.nodes.length) {
    const unresolved = def.nodes
      .filter((n) => !order.includes(n.id))
      .map((n) => n.id);
    throw new Error(`cycle detected in workflow: ${unresolved.join(" → ")}`);
  }
  return order;
}

// ── Serializer ───────────────────────────────────────────────────────────────

/**
 * Emit TOML that round-trips through `parseWorkflowToml`. Uses the
 * `[[nodes]]` + `[nodes.loop]` form to keep multi-line prompts readable.
 *
 * Follows the triple-quoted-same-line convention (see CLAUDE.md — Bun's TOML
 * parser does not trim the newline after `"""\n`).
 */
import { multilineTomlString } from "../prompts/toml_utils.ts";

export function serializeWorkflowToml(def: WorkflowDef): string {
  const lines: string[] = [];
  lines.push(`name = ${tomlString(def.name)}`);
  if (def.description) {
    lines.push(`description = ${tomlString(def.description)}`);
  }
  for (const n of def.nodes) {
    lines.push("");
    lines.push("[[nodes]]");
    lines.push(`id = ${tomlString(n.id)}`);
    if (n.depends_on.length > 0) {
      lines.push(`depends_on = [${n.depends_on.map(tomlString).join(", ")}]`);
    }
    if (n.agent) lines.push(`agent = ${tomlString(n.agent)}`);
    if (n.timeout_ms !== undefined) {
      lines.push(`timeout_ms = ${n.timeout_ms}`);
    }
    if (n.kind === "prompt" && n.prompt !== undefined) {
      lines.push(`prompt = ${tomlMaybeMultiline(n.prompt)}`);
    } else if (n.kind === "bash" && n.bash !== undefined) {
      lines.push(`bash = ${tomlMaybeMultiline(n.bash)}`);
    } else if (n.kind === "script" && n.script !== undefined) {
      lines.push(`script = ${tomlMaybeMultiline(n.script)}`);
    } else if (n.kind === "interactive") {
      lines.push(`interactive = true`);
    }
    if (n.kind === "loop" && n.loop) {
      lines.push("");
      lines.push("[nodes.loop]");
      lines.push(`prompt = ${tomlMaybeMultiline(n.loop.prompt)}`);
      lines.push(`until = ${tomlString(n.loop.until)}`);
      if (n.loop.fresh_context) lines.push(`fresh_context = true`);
      if (n.loop.interactive) lines.push(`interactive = true`);
      if (n.loop.max_iterations !== undefined) {
        lines.push(`max_iterations = ${n.loop.max_iterations}`);
      }
    }
    if (n.kind === "for_each" && n.for_each) {
      lines.push("");
      lines.push("[nodes.for_each]");
      if (n.for_each.items) {
        lines.push(`items = ${tomlMaybeMultiline(n.for_each.items)}`);
      }
      if (n.for_each.count) {
        lines.push(`count = ${tomlMaybeMultiline(n.for_each.count)}`);
      }
      lines.push(`body = [${n.for_each.body.map(tomlString).join(", ")}]`);
      if (n.for_each.item_var) {
        lines.push(`item_var = ${tomlString(n.for_each.item_var)}`);
      }
      if (n.for_each.index_var) {
        lines.push(`index_var = ${tomlString(n.for_each.index_var)}`);
      }
      if (n.for_each.max_iterations !== undefined) {
        lines.push(`max_iterations = ${n.for_each.max_iterations}`);
      }
    }
    if (n.kind === "if_then_else" && n.if_then_else) {
      lines.push("");
      lines.push("[nodes.if_then_else]");
      lines.push(
        `condition = ${tomlMaybeMultiline(n.if_then_else.condition)}`,
      );
      lines.push(
        `then_body = [${n.if_then_else.then_body.map(tomlString).join(", ")}]`,
      );
      lines.push(
        `else_body = [${n.if_then_else.else_body.map(tomlString).join(", ")}]`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

const tomlMaybeMultiline = multilineTomlString;
