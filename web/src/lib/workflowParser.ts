/**
 * Browser-side mini TOML parser, scoped to the workflow DSL.
 *
 * The server in `src/workflows/schema.ts` is authoritative — every save path
 * re-validates. This parser exists so the Graph view can render nodes +
 * edges as the user types, and to surface inline syntax errors without a
 * round-trip. It handles:
 *
 *   - `key = "..."` basic strings
 *   - `key = """..."""` triple-quoted strings (single or multi-line)
 *   - `key = number`, `key = true|false`, `key = [ "...", "..." ]`
 *   - `[[nodes]]` array-of-tables
 *   - `[nodes.loop]` sub-table of the last `[[nodes]]`
 *
 * Not supported: inline tables, arrays of tables other than `[[nodes]]`,
 * dotted keys, binary/hex/octal numbers, datetime literals. These are not
 * part of the workflow schema so their absence is not a regression.
 */

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
  until: string;
  fresh_context?: boolean;
  interactive?: boolean;
  max_iterations?: number;
}

export interface ForEachSpec {
  items?: string;
  count?: string;
  body: string[];
  item_var?: string;
  index_var?: string;
  max_iterations?: number;
}

export interface IfThenElseSpec {
  condition: string;
  then_body: string[];
  else_body: string[];
}

export interface ClientWorkflowNode {
  id: string;
  depends_on: string[];
  kind: NodeKind;
  prompt?: string;
  bash?: string;
  script?: string;
  loop?: LoopSpec;
  for_each?: ForEachSpec;
  if_then_else?: IfThenElseSpec;
  interactive?: boolean;
  agent?: string;
  timeout_ms?: number;
}

export interface ClientWorkflowDef {
  name: string;
  description?: string;
  nodes: ClientWorkflowNode[];
}

export interface ClientParseResult {
  def?: ClientWorkflowDef;
  errors: string[];
}

type TomlValue =
  | string
  | number
  | boolean
  | TomlValue[]
  | { [key: string]: TomlValue };

// ── Serializer ───────────────────────────────────────────────────────────────

/**
 * Emit TOML matching the server-side `serializeWorkflowToml` layout so
 * the graph editor can regenerate valid TOML after every mutation. The
 * server is still authoritative on save — this just seeds the textarea
 * and the autosave round-trip.
 */
export function serializeClientWorkflow(def: ClientWorkflowDef): string {
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
      lines.push(
        `depends_on = [${n.depends_on.map(tomlString).join(", ")}]`,
      );
    }
    if (n.agent) lines.push(`agent = ${tomlString(n.agent)}`);
    if (n.timeout_ms !== undefined) {
      lines.push(`timeout_ms = ${Math.floor(n.timeout_ms)}`);
    }
    if (n.kind === "prompt" && n.prompt !== undefined) {
      lines.push(`prompt = ${tomlMaybeMultiline(n.prompt)}`);
    } else if (n.kind === "bash" && n.bash !== undefined) {
      lines.push(`bash = ${tomlMaybeMultiline(n.bash)}`);
    } else if (n.kind === "script" && n.script !== undefined) {
      lines.push(`script = ${tomlMaybeMultiline(n.script)}`);
    } else if (n.kind === "interactive") {
      lines.push("interactive = true");
    }
    if (n.kind === "loop" && n.loop) {
      lines.push("");
      lines.push("[nodes.loop]");
      lines.push(`prompt = ${tomlMaybeMultiline(n.loop.prompt)}`);
      lines.push(`until = ${tomlString(n.loop.until)}`);
      if (n.loop.fresh_context) lines.push("fresh_context = true");
      if (n.loop.interactive) lines.push("interactive = true");
      if (typeof n.loop.max_iterations === "number") {
        lines.push(`max_iterations = ${Math.floor(n.loop.max_iterations)}`);
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
      if (typeof n.for_each.max_iterations === "number") {
        lines.push(
          `max_iterations = ${Math.floor(n.for_each.max_iterations)}`,
        );
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

function tomlMaybeMultiline(s: string): string {
  if (!s.includes("\n")) return tomlString(s);
  // Same-line triple-quote convention — see CLAUDE.md note on the
  // Bun-TOML newline-after-delimiter quirk.
  const body = s.replace(/"""/g, '\\"\\"\\"');
  return `"""${body}"""`;
}

interface RootState {
  top: Record<string, TomlValue>;
  nodes: Array<Record<string, TomlValue>>;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseClientWorkflow(text: string): ClientParseResult {
  const errors: string[] = [];
  let state: RootState;
  try {
    state = parseToml(text);
  } catch (e) {
    return {
      errors: [`TOML parse error: ${(e as Error).message}`],
    };
  }

  const rawName = state.top.name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) errors.push("missing 'name'");

  const description =
    typeof state.top.description === "string"
      ? (state.top.description as string)
      : undefined;

  if (state.nodes.length === 0) errors.push("workflow has no nodes");

  const seenIds = new Set<string>();
  const nodes: ClientWorkflowNode[] = [];
  for (let i = 0; i < state.nodes.length; i++) {
    const raw = state.nodes[i]!;
    const ctx = `nodes[${i}]`;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) {
      errors.push(`${ctx}: missing 'id'`);
      continue;
    }
    if (!ID_RE.test(id)) {
      errors.push(`${ctx}: id '${id}' is not a valid slug`);
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
        errors.push(`${ctx}: depends_on must be an array`);
      } else {
        for (const d of raw.depends_on) {
          if (typeof d === "string" && d.trim()) depends_on.push(d.trim());
        }
      }
    }

    const hasPrompt = typeof raw.prompt === "string" && raw.prompt.length > 0;
    const hasBash = typeof raw.bash === "string" && raw.bash.length > 0;
    const hasScript =
      typeof (raw as { script?: unknown }).script === "string" &&
      ((raw as { script: string }).script as string).length > 0;
    const isTable = (v: unknown) =>
      v !== undefined && typeof v === "object" && v !== null && !Array.isArray(v);
    const hasLoop = isTable(raw.loop);
    const hasForEach = isTable(raw.for_each);
    const hasIfThenElse = isTable(raw.if_then_else);
    const interactiveFlag = raw.interactive === true;

    const kindCount =
      (hasPrompt ? 1 : 0) +
      (hasBash ? 1 : 0) +
      (hasScript ? 1 : 0) +
      (hasLoop ? 1 : 0) +
      (hasForEach ? 1 : 0) +
      (hasIfThenElse ? 1 : 0);
    if (kindCount > 1) {
      errors.push(
        `${ctx}: node '${id}' has more than one of prompt/bash/script/loop/for_each/if_then_else`,
      );
      continue;
    }
    if (kindCount === 0 && !interactiveFlag) {
      errors.push(
        `${ctx}: node '${id}' has none of prompt/bash/script/loop/for_each/if_then_else/interactive=true`,
      );
      continue;
    }

    let kind: NodeKind;
    if (hasPrompt) kind = "prompt";
    else if (hasBash) kind = "bash";
    else if (hasScript) kind = "script";
    else if (hasLoop) kind = "loop";
    else if (hasForEach) kind = "for_each";
    else if (hasIfThenElse) kind = "if_then_else";
    else kind = "interactive";

    const node: ClientWorkflowNode = { id, depends_on, kind };
    if (hasPrompt) node.prompt = raw.prompt as string;
    if (hasBash) node.bash = raw.bash as string;
    if (hasScript)
      node.script = (raw as { script: string }).script as string;
    if (hasLoop) {
      const loop = raw.loop as Record<string, TomlValue>;
      const prompt = typeof loop.prompt === "string" ? loop.prompt : "";
      const until = typeof loop.until === "string" ? loop.until : "";
      if (!prompt) errors.push(`${ctx}.loop: missing 'prompt'`);
      if (!until) errors.push(`${ctx}.loop: missing 'until'`);
      node.loop = {
        prompt,
        until,
        fresh_context: loop.fresh_context === true,
        interactive: loop.interactive === true,
        max_iterations:
          typeof loop.max_iterations === "number"
            ? loop.max_iterations
            : undefined,
      };
    }
    if (hasForEach) {
      const fe = raw.for_each as Record<string, TomlValue>;
      const items = typeof fe.items === "string" ? fe.items : undefined;
      const count = typeof fe.count === "string" ? fe.count : undefined;
      const body = Array.isArray(fe.body)
        ? (fe.body as TomlValue[])
            .filter((b) => typeof b === "string" && b.trim().length > 0)
            .map((b) => (b as string).trim())
        : [];
      if (!items && !count) {
        errors.push(`${ctx}.for_each: need either 'items' or 'count'`);
      }
      if (items && count) {
        errors.push(`${ctx}.for_each: set only one of 'items' or 'count'`);
      }
      if (body.length === 0) {
        errors.push(`${ctx}.for_each: 'body' must list at least one node id`);
      }
      node.for_each = {
        body,
        items,
        count,
        item_var: typeof fe.item_var === "string" ? fe.item_var : undefined,
        index_var: typeof fe.index_var === "string" ? fe.index_var : undefined,
        max_iterations:
          typeof fe.max_iterations === "number"
            ? fe.max_iterations
            : undefined,
      };
    }
    if (hasIfThenElse) {
      const it = raw.if_then_else as Record<string, TomlValue>;
      const condition =
        typeof it.condition === "string" ? it.condition.trim() : "";
      if (!condition) {
        errors.push(`${ctx}.if_then_else: missing 'condition'`);
      }
      const pickBranch = (key: "then_body" | "else_body"): string[] => {
        const arr = it[key];
        if (arr === undefined) return [];
        if (!Array.isArray(arr)) return [];
        return (arr as TomlValue[])
          .filter((b) => typeof b === "string" && b.trim().length > 0)
          .map((b) => (b as string).trim());
      };
      node.if_then_else = {
        condition,
        then_body: pickBranch("then_body"),
        else_body: pickBranch("else_body"),
      };
    }
    if (interactiveFlag) node.interactive = true;
    if (typeof raw.agent === "string" && raw.agent.trim()) {
      node.agent = (raw.agent as string).trim();
    }
    if (typeof raw.timeout_ms === "number") {
      node.timeout_ms = raw.timeout_ms;
    }
    nodes.push(node);
  }

  for (const n of nodes) {
    for (const dep of n.depends_on) {
      if (!seenIds.has(dep)) {
        errors.push(`node '${n.id}': unknown depends_on id '${dep}'`);
      }
    }
  }

  // Body ownership: each body id must exist and appear in at most one body.
  const ownerOf = new Map<string, string>();
  const checkBody = (owner: string, key: string, ids: string[]) => {
    for (const bid of ids) {
      if (!seenIds.has(bid)) {
        errors.push(`node '${owner}': ${key} references unknown id '${bid}'`);
        continue;
      }
      if (bid === owner) {
        errors.push(`node '${owner}': ${key} cannot contain itself`);
        continue;
      }
      const prev = ownerOf.get(bid);
      if (prev && prev !== owner) {
        errors.push(
          `node '${bid}': already owned by '${prev}', cannot also be in ${key} of '${owner}'`,
        );
        continue;
      }
      ownerOf.set(bid, owner);
    }
  };
  for (const n of nodes) {
    if (n.for_each) checkBody(n.id, "for_each.body", n.for_each.body);
    if (n.if_then_else) {
      checkBody(n.id, "if_then_else.then_body", n.if_then_else.then_body);
      checkBody(n.id, "if_then_else.else_body", n.if_then_else.else_body);
    }
  }

  if (errors.length > 0) return { errors };
  return { def: { name, description, nodes }, errors: [] };
}

/**
 * Body-owned node ids → owner id. Used by the graph view to hide owned
 * nodes from top-level depends_on edges and to show an owner chip.
 */
export function computeOwnerOf(def: ClientWorkflowDef): Record<string, string> {
  const owner: Record<string, string> = {};
  for (const n of def.nodes) {
    if (n.for_each) for (const b of n.for_each.body) owner[b] = n.id;
    if (n.if_then_else) {
      for (const b of n.if_then_else.then_body) owner[b] = n.id;
      for (const b of n.if_then_else.else_body) owner[b] = n.id;
    }
  }
  return owner;
}

// ── Parser internals ─────────────────────────────────────────────────────────

function parseToml(src: string): RootState {
  const lines = src.split(/\r?\n/);
  const top: Record<string, TomlValue> = {};
  const nodes: Array<Record<string, TomlValue>> = [];
  let current: Record<string, TomlValue> = top;
  let path: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const line = raw.replace(/^\s+/, "");
    if (line === "" || line.startsWith("#")) {
      i++;
      continue;
    }

    if (line.startsWith("[[") && line.includes("]]")) {
      const end = line.indexOf("]]");
      const header = line.slice(2, end).trim();
      if (header !== "nodes") {
        throw new Error(`unsupported array-of-tables '[[${header}]]'`);
      }
      const obj: Record<string, TomlValue> = {};
      nodes.push(obj);
      current = obj;
      path = ["nodes"];
      i++;
      continue;
    }
    if (line.startsWith("[") && line.includes("]")) {
      const end = line.indexOf("]");
      const header = line.slice(1, end).trim();
      const parts = header.split(".").map((p) => p.trim());
      if (parts[0] === "nodes" && parts.length === 2) {
        if (nodes.length === 0) {
          throw new Error(
            `'[nodes.${parts[1]}]' appears before any [[nodes]]`,
          );
        }
        const parent = nodes[nodes.length - 1]!;
        const child: Record<string, TomlValue> = {};
        parent[parts[1]!] = child;
        current = child;
        path = ["nodes", parts[1]!];
      } else if (parts.length === 1) {
        // Top-level [foo] — unused in the workflow schema, but we accept and
        // ignore to stay forward-compatible with future additions.
        const child: Record<string, TomlValue> = {};
        top[parts[0]!] = child;
        current = child;
        path = [parts[0]!];
      } else {
        throw new Error(`unsupported table header '[${header}]'`);
      }
      i++;
      continue;
    }

    // key = value
    const eq = line.indexOf("=");
    if (eq < 0) throw new Error(`expected '=' in '${raw}'`);
    const key = line.slice(0, eq).trim();
    let rest = line.slice(eq + 1).trim();

    let value: TomlValue;
    if (rest.startsWith('"""')) {
      // Multi-line or single-line triple-quoted string.
      const after = rest.slice(3);
      const closeIdx = after.indexOf('"""');
      if (closeIdx >= 0) {
        value = unescapeBasic(after.slice(0, closeIdx));
        i++;
      } else {
        const parts: string[] = [after];
        i++;
        let closed = false;
        let collected = "";
        for (; i < lines.length; i++) {
          const next = lines[i]!;
          const c = next.indexOf('"""');
          if (c >= 0) {
            parts.push(next.slice(0, c));
            collected = parts.join("\n");
            closed = true;
            i++;
            break;
          }
          parts.push(next);
        }
        if (!closed) throw new Error("unterminated triple-quoted string");
        value = unescapeBasic(collected);
      }
    } else {
      value = parseValue(rest);
      i++;
    }
    current[key] = value;
    // Keep current set — no-op when writing back to same table.
    void path;
  }

  return { top, nodes };
}

function parseValue(raw: string): TomlValue {
  // Strip trailing comment (outside of strings — simple heuristic since the
  // workflow schema doesn't use '#' inside unquoted values).
  let s = raw.trim();
  // Arrays may span multiple lines in general TOML; for the workflow schema
  // `depends_on = [ "a", "b" ]` is always one line.
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw new Error(`array did not close on same line: '${raw}'`);
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    const out: TomlValue[] = [];
    // Split on commas at depth 0, respecting quoted strings.
    let buf = "";
    let quoted = false;
    for (let j = 0; j < inner.length; j++) {
      const c = inner[j];
      if (c === '"') quoted = !quoted;
      if (c === "," && !quoted) {
        out.push(parseValue(buf));
        buf = "";
      } else {
        buf += c;
      }
    }
    if (buf.trim().length > 0) out.push(parseValue(buf));
    return out;
  }
  if (s.startsWith('"')) {
    if (!s.endsWith('"')) throw new Error(`string did not close: '${raw}'`);
    return unescapeBasic(s.slice(1, -1));
  }
  if (s === "true") return true;
  if (s === "false") return false;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`cannot parse value: '${raw}'`);
  return n;
}

function unescapeBasic(s: string): string {
  return s.replace(/\\(.)/g, (_m, ch) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return ch;
    }
  });
}
