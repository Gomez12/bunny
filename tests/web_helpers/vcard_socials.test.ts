/**
 * Tests for the vCard parser's social-handle extraction (ADR 0036).
 * Exercises URL, X-SOCIALPROFILE (Apple iCloud), IMPP, and the legacy
 * X-TWITTER / X-LINKEDIN / X-GITHUB family.
 */

import { describe, expect, test } from "bun:test";
import { parseVCards } from "../../web/src/lib/vcard.ts";

const sample = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alice Example\r\nEMAIL:alice@example.com\r\nURL:https://alice.example\r\nX-SOCIALPROFILE;type=twitter:https://twitter.com/alice\r\nX-LINKEDIN:https://linkedin.com/in/alice\r\nIMPP:xmpp:alice@chat.example\r\nEND:VCARD\r\n`;

describe("vCard socials parsing", () => {
  test("URL becomes a website social", () => {
    const [card] = parseVCards(sample);
    expect(card?.socials.find((s) => s.platform === "website")?.url).toBe(
      "https://alice.example",
    );
  });

  test("X-SOCIALPROFILE;type=twitter is recognised with platform=twitter", () => {
    const [card] = parseVCards(sample);
    const s = card?.socials.find((x) => x.platform === "twitter");
    expect(s?.url).toBe("https://twitter.com/alice");
  });

  test("legacy X-LINKEDIN maps to platform=linkedin", () => {
    const [card] = parseVCards(sample);
    const s = card?.socials.find((x) => x.platform === "linkedin");
    expect(s?.handle).toBe("https://linkedin.com/in/alice");
  });

  test("IMPP xmpp scheme maps to mastodon-ish bucket", () => {
    const [card] = parseVCards(sample);
    const s = card?.socials.find((x) => x.platform === "mastodon");
    expect(s?.handle).toContain("alice@chat.example");
  });

  test("missing socials yields empty array, not undefined", () => {
    const minimal = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Bob\r\nEMAIL:bob@example.com\r\nEND:VCARD\r\n`;
    const [card] = parseVCards(minimal);
    expect(card?.socials).toEqual([]);
  });
});
