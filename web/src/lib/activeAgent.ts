/**
 * Per-session agent binding persisted in `localStorage`.
 *
 * Key: `bunny.activeAgent.<sessionId>`. Empty / missing → caller should use
 * the configured default agent (see `/api/auth/me`).
 */

const PREFIX = "bunny.activeAgent.";

function keyFor(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

export function loadActiveAgent(
  sessionId: string,
  defaultAgent: string,
): string {
  if (typeof localStorage === "undefined") return defaultAgent;
  const raw = localStorage.getItem(keyFor(sessionId));
  const stored = raw?.trim();
  return stored || defaultAgent;
}

export function saveActiveAgent(sessionId: string, agent: string): void {
  if (typeof localStorage === "undefined") return;
  const trimmed = agent.trim();
  if (!trimmed) {
    localStorage.removeItem(keyFor(sessionId));
    return;
  }
  localStorage.setItem(keyFor(sessionId), trimmed);
}

export function clearActiveAgent(sessionId: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(keyFor(sessionId));
}
