/**
 * Derive the human-readable label shown above each chat bubble.
 *
 * Pure function so it's trivially testable. User rows show displayName /
 * username / "you" (in that order of preference); assistant rows show
 * `@<author>` and fall back to the configured default agent when the row
 * has no author (legacy NULL-author history).
 */

export type BubbleRole = "user" | "assistant" | "tool" | "system";

export interface ResolveLabelArgs {
  role: BubbleRole;
  author?: string | null;
  displayName?: string | null;
  username?: string | null;
  defaultAgent: string;
}

export interface BubbleLabel {
  label: string;
  kind: BubbleRole | "agent";
}

export function resolveBubbleLabel(args: ResolveLabelArgs): BubbleLabel {
  const { role, author, displayName, username, defaultAgent } = args;

  if (role === "user") {
    const name = displayName?.trim() || username?.trim() || "you";
    return { label: name, kind: "user" };
  }

  if (role === "assistant") {
    const agent = (author && author.trim()) || defaultAgent;
    return { label: `@${agent}`, kind: "agent" };
  }

  return { label: role, kind: role };
}
