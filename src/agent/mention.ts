/**
 * Parse a leading `@agentname` mention from a user prompt.
 *
 * Only leading mentions are recognised to avoid ambiguity — an `@` in the
 * middle of an explanation collides with email addresses, handles, tool arg
 * syntax, etc. Callers that have a canonical list of agent names should do
 * stricter matching themselves; this parser only extracts a syntactic
 * candidate that satisfies {@link AGENT_NAME_RE}.
 */

import { AGENT_NAME_RE } from "../memory/agent_name.ts";

export interface ParsedMention {
  agent: string | null;
  cleaned: string;
}

// Built from AGENT_NAME_RE so the mention pattern can never drift from the
// validator used server-side. Source is `^[a-z0-9][a-z0-9_-]{0,62}$` → drop
// the anchors, wrap in a leading `@`, require a word-boundary afterwards.
const MENTION_RE = new RegExp(
  `^\\s*@(${AGENT_NAME_RE.source.replace(/^\^|\$$/g, "")})(?:\\s+|$)`,
  "i",
);

export function parseMention(prompt: string): ParsedMention {
  if (typeof prompt !== "string") return { agent: null, cleaned: "" };
  const match = prompt.match(MENTION_RE);
  if (!match) return { agent: null, cleaned: prompt };
  return {
    agent: match[1]!.toLowerCase(),
    cleaned: prompt.slice(match[0].length).trimStart(),
  };
}
