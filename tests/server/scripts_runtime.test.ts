/**
 * Regression tests for script runtime resolution.
 *
 * Bug: process.execPath in a compiled Bunny binary points to the Bunny
 * executable, not the Bun runtime — so `bun run <script>` was inadvertently
 * launching a full Bunny server instead of executing the script.
 */

import { test, expect } from "bun:test";
import { resolveRuntime } from "../../src/server/scripts_routes.ts";
import type { BunnyConfig } from "../../src/config.ts";
import { loadConfig } from "../../src/config.ts";

const baseCfg: BunnyConfig = { ...loadConfig({ env: {} }), sessionId: undefined };

test("JS/TS runtime exe is not the Bunny server binary", () => {
  // In a compiled Bunny binary, process.execPath points to bunny-darwin-arm64
  // (or similar), not to the bun runtime. The fix uses Bun.which("bun") so
  // the exe will be the real bun path, never the Bunny server itself.
  const result = resolveRuntime("javascript", baseCfg);
  expect(result).not.toBeNull();
  // The exe must not look like a Bunny server binary.
  expect(result!.exe).not.toMatch(/bunny(-darwin|-linux|-windows|\.exe)?(-arm64|-x64)?$/);
});

test("TS runtime exe is not the Bunny server binary", () => {
  const result = resolveRuntime("typescript", baseCfg);
  expect(result).not.toBeNull();
  expect(result!.exe).not.toMatch(/bunny(-darwin|-linux|-windows|\.exe)?(-arm64|-x64)?$/);
});

test("JS/TS runtime uses configured bunPath when set", () => {
  const cfg = { ...baseCfg, scripts: { ...baseCfg.scripts, bunPath: "/custom/bun" } };
  const result = resolveRuntime("javascript", cfg);
  expect(result!.exe).toBe("/custom/bun");
});

test("JS/TS runtime falls back to bun on PATH when bunPath not configured", () => {
  const cfg = { ...baseCfg, scripts: { ...baseCfg.scripts, bunPath: "" } };
  const result = resolveRuntime("javascript", cfg);
  expect(result).not.toBeNull();
  // Should be "bun" (from PATH) or an absolute path found via Bun.which — never the server binary.
  expect(result!.exe.endsWith("bunny") || result!.exe.endsWith("bunny-darwin-arm64")).toBe(false);
  expect(result!.extraArgs).toEqual(["run"]);
});

test("SQL returns null (not executable)", () => {
  expect(resolveRuntime("sql", baseCfg)).toBeNull();
});

test("C# returns null when dotnetPath not configured", () => {
  const cfg = { ...baseCfg, scripts: { ...baseCfg.scripts, dotnetPath: "" } };
  expect(resolveRuntime("csharp", cfg)).toBeNull();
});

test("C# returns runtime when dotnetPath is configured", () => {
  const cfg = { ...baseCfg, scripts: { ...baseCfg.scripts, dotnetPath: "/usr/local/bin/dotnet" } };
  const result = resolveRuntime("csharp", cfg);
  expect(result).not.toBeNull();
  expect(result!.exe).toBe("/usr/local/bin/dotnet");
  expect(result!.extraArgs).toEqual(["run"]);
});

test("bash always resolves (no config needed)", () => {
  const result = resolveRuntime("bash", baseCfg);
  expect(result).not.toBeNull();
  expect(result!.exe).toBe("bash");
});

test("go defaults to 'go' on PATH when not configured", () => {
  const cfg = { ...baseCfg, scripts: { ...baseCfg.scripts, goPath: "" } };
  const result = resolveRuntime("go", cfg);
  expect(result).not.toBeNull();
  expect(result!.exe).toBe("go");
  expect(result!.extraArgs).toEqual(["run"]);
});
