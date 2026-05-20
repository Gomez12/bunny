import { describe, expect, test } from "bun:test";
import { stripHtmlTags } from "../../src/util/html.ts";

describe("stripHtmlTags", () => {
  test("removes a single tag", () => {
    expect(stripHtmlTags("hello <b>world</b>")).toBe("hello world");
  });

  test("removes nested overlapping tags so no residue remains", () => {
    // A single-pass `replace(/<[^>]+>/g, "")` would leave residual `<script` /
    // `<img` content here. The fixed-point loop must catch the residue.
    expect(stripHtmlTags("<scr<script>ipt>alert(1)</script>")).not.toContain(
      "<script",
    );
    expect(stripHtmlTags("<scr<script>ipt>alert(1)</script>")).not.toContain(
      "<img",
    );
    expect(stripHtmlTags("<<img src=x onerror=alert(1)>>")).not.toContain(
      "<img",
    );
  });

  test("idempotent on plain text", () => {
    expect(stripHtmlTags("just text")).toBe("just text");
    expect(stripHtmlTags("")).toBe("");
  });

  test("strips empty `<>` and self-closing tags", () => {
    expect(stripHtmlTags("a<>b<br/>c")).toBe("abc");
  });

  test("does not hang on adversarial input", () => {
    const evil = "<".repeat(10_000) + ">".repeat(10_000);
    // Bounded loop must terminate; we only assert no `<` remains.
    expect(stripHtmlTags(evil).includes("<")).toBe(false);
  });
});
