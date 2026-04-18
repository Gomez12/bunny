/**
 * Portable path resolution.
 *
 * All runtime state lives under a single root directory. By default that root
 * is `./.bunny` under the current working directory, so a project folder is
 * self-contained and trivially movable. Set `$BUNNY_HOME` to override (absolute
 * path or path relative to cwd).
 *
 * This module is the **only** place that builds state paths. Never touch
 * `os.homedir()` or `process.env.HOME` in the app — that would break
 * portability and break the "copy the folder and it still works" guarantee.
 */

import { isAbsolute, join, resolve, dirname } from "node:path";

const DEFAULT_SUBDIR = ".bunny";

/**
 * When running as a compiled Bun binary, `import.meta.path` is a virtual
 * `/$bunfs/…` path. We use this to distinguish compiled from source/dev mode.
 */
const IS_COMPILED = import.meta.path.startsWith("/$bunfs/");

/**
 * Base directory for state storage.
 *
 * - Compiled binary: directory of the binary itself (`dirname(process.execPath)`)
 *   so state stays portable alongside the binary regardless of cwd.
 * - Dev / `bun run`: current working directory (project-relative, as before).
 */
function defaultBase(cwd: string): string {
  return IS_COMPILED ? dirname(process.execPath) : cwd;
}

/**
 * Resolve the root directory for Bunny's runtime state.
 *
 * Precedence:
 *  1. `$BUNNY_HOME` if set (absolute or relative to cwd)
 *  2. `.bunny` next to the binary (compiled) or under cwd (dev)
 *
 * The directory is **not** created here; callers that need it on disk should
 * `mkdir -p` it themselves.
 */
export function resolveBunnyHome(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const override = env["BUNNY_HOME"];
  if (override && override.length > 0) {
    return isAbsolute(override) ? override : resolve(cwd, override);
  }
  return join(defaultBase(cwd), DEFAULT_SUBDIR);
}

/**
 * Build a path inside Bunny's state root. `segments` are joined to the root.
 *
 * @example
 * resolveBunnyPath("db.sqlite")           // <cwd>/.bunny/db.sqlite
 * resolveBunnyPath("logs", "agent.log")   // <cwd>/.bunny/logs/agent.log
 */
export function resolveBunnyPath(...segments: string[]): string {
  return join(resolveBunnyHome(), ...segments);
}

/** Well-known paths. Callers should prefer these over string literals. */
export const paths = {
  home: () => resolveBunnyHome(),
  db: () => resolveBunnyPath("db.sqlite"),
  logs: () => resolveBunnyPath("logs"),
  sessions: () => resolveBunnyPath("sessions"),
  projects: () => resolveBunnyPath("projects"),
  projectDir: (name: string) => resolveBunnyPath("projects", name),
  agents: () => resolveBunnyPath("agents"),
  agentDir: (name: string) => resolveBunnyPath("agents", name),
  skills: () => resolveBunnyPath("skills"),
  skillDir: (name: string) => resolveBunnyPath("skills", name),
  configFile: (cwd: string = process.cwd()) => join(cwd, "bunny.config.toml"),
} as const;
