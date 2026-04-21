/**
 * On-disk TOML for workflows: one file per workflow at
 * `<projectDir>/workflows/<slug>.toml`. The `workflows` DB row is a thin
 * index — the TOML text itself is the source of truth for node definitions.
 *
 * Mirrors `project_assets.ts`: the route layer writes both in a single
 * transaction-adjacent pair (DB update first, then file write) so a crash
 * between the two leaves the DB hash mismatched with disk and the next read
 * surfaces the drift.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { projectDir } from "./project_assets.ts";

const WORKFLOWS_SUBDIR = "workflows";

function workflowsDir(project: string): string {
  return join(projectDir(project), WORKFLOWS_SUBDIR);
}

function workflowFile(project: string, slug: string): string {
  return join(workflowsDir(project), `${slug}.toml`);
}

/** Read the TOML text for one workflow. Returns null if the file is missing. */
export function loadWorkflowToml(
  project: string,
  slug: string,
): string | null {
  const file = workflowFile(project, slug);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

/** Overwrite the TOML file; creates the workflows dir on first write. */
export function writeWorkflowToml(
  project: string,
  slug: string,
  text: string,
): void {
  const dir = workflowsDir(project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(workflowFile(project, slug), text, "utf8");
}

/** sha256 hex digest of the raw TOML text. Used as the drift-detection hash. */
export function hashWorkflowToml(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
