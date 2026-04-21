/**
 * Parser + topological sort tests for the workflow TOML schema.
 */

import { describe, expect, test } from "bun:test";
import {
  computeTopo,
  parseWorkflowToml,
  serializeWorkflowToml,
} from "../../src/workflows/schema.ts";

const SAMPLE = `name = "build feature"
description = "Canonical plan → implement → review pipeline."

[[nodes]]
id = "plan"
prompt = "Explore and draft a plan"

[[nodes]]
id = "implement"
depends_on = ["plan"]

[nodes.loop]
prompt = "Implement next task; run validation"
until = "ALL_TASKS_COMPLETE"
fresh_context = true

[[nodes]]
id = "run-tests"
depends_on = ["implement"]
bash = "bun run validate"

[[nodes]]
id = "review"
depends_on = ["run-tests"]
prompt = "Review changes against the plan"

[[nodes]]
id = "approve"
depends_on = ["review"]
interactive = true

[[nodes]]
id = "create-pr"
depends_on = ["approve"]
prompt = "Push changes and open a PR"
`;

describe("parseWorkflowToml — happy path", () => {
  test("accepts the canonical sample", () => {
    const { def, errors } = parseWorkflowToml(SAMPLE);
    expect(errors).toEqual([]);
    expect(def!.name).toBe("build feature");
    expect(def!.nodes.map((n) => n.id)).toEqual([
      "plan",
      "implement",
      "run-tests",
      "review",
      "approve",
      "create-pr",
    ]);
    const impl = def!.nodes.find((n) => n.id === "implement")!;
    expect(impl.kind).toBe("loop");
    expect(impl.loop?.until).toBe("ALL_TASKS_COMPLETE");
    expect(impl.loop?.fresh_context).toBe(true);
    const bash = def!.nodes.find((n) => n.id === "run-tests")!;
    expect(bash.kind).toBe("bash");
    const approve = def!.nodes.find((n) => n.id === "approve")!;
    expect(approve.kind).toBe("interactive");
  });

  test("computeTopo returns declaration order for the sample", () => {
    const { def } = parseWorkflowToml(SAMPLE);
    const order = computeTopo(def!);
    expect(order).toEqual([
      "plan",
      "implement",
      "run-tests",
      "review",
      "approve",
      "create-pr",
    ]);
  });

  test("serializeWorkflowToml round-trips through parse", () => {
    const { def } = parseWorkflowToml(SAMPLE);
    const out = serializeWorkflowToml(def!);
    const re = parseWorkflowToml(out);
    expect(re.errors).toEqual([]);
    expect(re.def!.nodes.map((n) => n.id)).toEqual(def!.nodes.map((n) => n.id));
  });
});

describe("parseWorkflowToml — validation errors", () => {
  test("rejects duplicate ids", () => {
    const { errors } = parseWorkflowToml(`name = "x"
[[nodes]]
id = "a"
prompt = "hi"
[[nodes]]
id = "a"
prompt = "again"
`);
    expect(errors.some((e) => e.includes("duplicate id 'a'"))).toBe(true);
  });

  test("rejects bad id slug", () => {
    const { errors } = parseWorkflowToml(`name = "x"
[[nodes]]
id = "NotASlug"
prompt = "hi"
`);
    expect(errors.some((e) => e.includes("does not match"))).toBe(true);
  });

  test("rejects depends_on to unknown id", () => {
    const { errors } = parseWorkflowToml(`name = "x"
[[nodes]]
id = "a"
depends_on = ["ghost"]
prompt = "hi"
`);
    expect(errors.some((e) => e.includes("unknown id 'ghost'"))).toBe(true);
  });

  test("rejects a cycle", () => {
    const { errors } = parseWorkflowToml(`name = "x"
[[nodes]]
id = "a"
depends_on = ["b"]
prompt = "hi"
[[nodes]]
id = "b"
depends_on = ["a"]
prompt = "hi"
`);
    expect(errors.some((e) => e.toLowerCase().includes("cycle"))).toBe(true);
  });

  test("rejects more than one of prompt/bash/loop", () => {
    const { errors } = parseWorkflowToml(`name = "x"
[[nodes]]
id = "a"
prompt = "hi"
bash = "echo"
`);
    expect(errors.some((e) => e.includes("exactly one"))).toBe(true);
  });

  test("rejects a node with no prompt/bash/loop/interactive", () => {
    const { errors } = parseWorkflowToml(`name = "x"
[[nodes]]
id = "a"
`);
    expect(errors.some((e) => e.includes("has no prompt"))).toBe(true);
  });

  test("rejects empty workflows", () => {
    const { errors } = parseWorkflowToml(`name = "x"
`);
    expect(
      errors.some(
        (e) => e.includes("no nodes") || e.includes("must be an array"),
      ),
    ).toBe(true);
  });

  test("rejects self-dependency", () => {
    const { errors } = parseWorkflowToml(`name = "x"
[[nodes]]
id = "a"
depends_on = ["a"]
prompt = "hi"
`);
    expect(errors.some((e) => e.includes("depends on itself"))).toBe(true);
  });

  test("rejects missing loop.until", () => {
    const { errors } = parseWorkflowToml(`name = "x"
[[nodes]]
id = "a"
[nodes.loop]
prompt = "hi"
`);
    expect(errors.some((e) => e.includes("'until'"))).toBe(true);
  });
});

describe("computeTopo", () => {
  test("throws on cycle", () => {
    const def = {
      name: "x",
      nodes: [
        { id: "a", depends_on: ["b"], kind: "prompt" as const, prompt: "hi" },
        { id: "b", depends_on: ["a"], kind: "prompt" as const, prompt: "hi" },
      ],
    };
    expect(() => computeTopo(def)).toThrow(/cycle/i);
  });

  test("preserves declaration order when siblings are independent", () => {
    const def = {
      name: "x",
      nodes: [
        { id: "a", depends_on: [], kind: "prompt" as const, prompt: "hi" },
        { id: "b", depends_on: [], kind: "prompt" as const, prompt: "hi" },
        { id: "c", depends_on: ["a", "b"], kind: "prompt" as const, prompt: "hi" },
      ],
    };
    expect(computeTopo(def)).toEqual(["a", "b", "c"]);
  });
});
