import { describe, expect, test } from "bun:test";
import { parseMention } from "../../src/agent/mention.ts";

describe("parseMention", () => {
  test("extracts leading @name and strips it", () => {
    const { agent, cleaned } = parseMention("@bob wat vind je hiervan?");
    expect(agent).toBe("bob");
    expect(cleaned).toBe("wat vind je hiervan?");
  });

  test("lowercases the mention", () => {
    expect(parseMention("@Ada hi").agent).toBe("ada");
  });

  test("returns null + untouched prompt when no mention", () => {
    const { agent, cleaned } = parseMention("help me please");
    expect(agent).toBeNull();
    expect(cleaned).toBe("help me please");
  });

  test("ignores @ in the middle of a sentence", () => {
    const { agent } = parseMention("please email me at foo@bar");
    expect(agent).toBeNull();
  });

  test("bare @name with no trailing text yields empty cleaned", () => {
    const { agent, cleaned } = parseMention("@bob");
    expect(agent).toBe("bob");
    expect(cleaned).toBe("");
  });

  test("rejects invalid mention syntax", () => {
    // underscore-leading is invalid per AGENT_NAME_RE
    expect(parseMention("@-weird hi").agent).toBeNull();
  });
});
