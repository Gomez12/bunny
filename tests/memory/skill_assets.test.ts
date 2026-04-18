import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../../src/memory/skill_assets.ts";

describe("parseFrontmatter", () => {
  test("parses valid YAML frontmatter", () => {
    const raw = `---
name: pdf-processing
description: Extract PDF text, fill forms, merge files.
license: Apache-2.0
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash Read
---

# PDF Processing

Step 1: do the thing.
`;
    const { frontmatter, body } = parseFrontmatter(raw, "fallback");
    expect(frontmatter.name).toBe("pdf-processing");
    expect(frontmatter.description).toBe(
      "Extract PDF text, fill forms, merge files.",
    );
    expect(frontmatter.license).toBe("Apache-2.0");
    expect(frontmatter.metadata).toEqual({
      author: "example-org",
      version: "1.0",
    });
    expect(frontmatter.allowedTools).toEqual(["Bash", "Read"]);
    expect(body).toContain("# PDF Processing");
    expect(body).toContain("Step 1: do the thing.");
  });

  test("returns fallback on missing frontmatter", () => {
    const raw = "# Just markdown\n\nNo frontmatter here.";
    const { frontmatter, body } = parseFrontmatter(raw, "my-fallback");
    expect(frontmatter.name).toBe("my-fallback");
    expect(frontmatter.description).toBe("");
    expect(body).toContain("# Just markdown");
  });

  test("returns fallback on incomplete frontmatter delimiters", () => {
    const raw = "---\nname: broken\nNo closing delimiter";
    const { frontmatter } = parseFrontmatter(raw, "fb");
    expect(frontmatter.name).toBe("fb");
  });

  test("handles empty frontmatter", () => {
    const raw = "---\n---\nBody text.";
    const { frontmatter, body } = parseFrontmatter(raw, "empty");
    expect(frontmatter.name).toBe("empty");
    expect(frontmatter.description).toBe("");
    expect(body).toBe("Body text.");
  });

  test("handles malformed YAML gracefully", () => {
    const raw = "---\n: broken yaml [[[{{{\n---\nSome instructions.";
    const { frontmatter, body } = parseFrontmatter(raw, "safe");
    expect(frontmatter.name).toBe("safe");
    expect(body).toBe("Some instructions.");
  });

  test("handles compatibility field", () => {
    const raw = `---
name: docker-skill
description: Docker helper.
compatibility: Requires Docker and docker-compose
---
Instructions here.`;
    const { frontmatter } = parseFrontmatter(raw, "fb");
    expect(frontmatter.compatibility).toBe(
      "Requires Docker and docker-compose",
    );
  });

  test("strips leading whitespace before frontmatter", () => {
    const raw = `  \n---\nname: spaced\ndescription: Has leading whitespace.\n---\nBody.`;
    const { frontmatter, body } = parseFrontmatter(raw, "fb");
    expect(frontmatter.name).toBe("spaced");
    expect(body).toBe("Body.");
  });
});
