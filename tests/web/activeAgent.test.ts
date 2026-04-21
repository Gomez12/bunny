import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearActiveAgent,
  loadActiveAgent,
  saveActiveAgent,
} from "../../web/src/lib/activeAgent.ts";

// Minimal localStorage polyfill for the Bun test runtime.
function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i: number) => {
      const keys = Array.from(store.keys());
      return keys[i] ?? null;
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
}

beforeEach(() => {
  (globalThis as { localStorage: Storage }).localStorage = makeMemoryStorage();
});
afterEach(() => {
  (globalThis as { localStorage: Storage }).localStorage.clear();
});

describe("activeAgent helper", () => {
  test("returns defaultAgent when nothing is stored", () => {
    expect(loadActiveAgent("sess-1", "bunny")).toBe("bunny");
  });

  test("saveActiveAgent / loadActiveAgent roundtrips", () => {
    saveActiveAgent("sess-1", "mia");
    expect(loadActiveAgent("sess-1", "bunny")).toBe("mia");
  });

  test("empty value clears the binding", () => {
    saveActiveAgent("sess-1", "mia");
    saveActiveAgent("sess-1", "");
    expect(loadActiveAgent("sess-1", "bunny")).toBe("bunny");
  });

  test("clearActiveAgent removes the binding", () => {
    saveActiveAgent("sess-1", "mia");
    clearActiveAgent("sess-1");
    expect(loadActiveAgent("sess-1", "bunny")).toBe("bunny");
  });

  test("bindings are per-session", () => {
    saveActiveAgent("sess-1", "mia");
    expect(loadActiveAgent("sess-2", "bunny")).toBe("bunny");
  });
});
