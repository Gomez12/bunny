/**
 * Scheduler handler: disk-sync scan for scripts.
 *
 * Every tick:
 * 1. Walk all alive scripts for every non-deleted code project.
 * 2. If the disk file is missing → restore from DB content.
 * 3. If the disk file hash differs from the stored file_hash → external edit;
 *    update DB + create version snapshot.
 * 4. If a file in workspace/code/<cp>/scripts/ has no matching DB row → auto-import.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, extname, basename } from "node:path";
import type { Database } from "bun:sqlite";
import { sha256Hex } from "../util/hash.ts";
import { atomicWrite } from "../util/atomic_fs.ts";
import { workspaceDir } from "../memory/project_assets.ts";
import {
  listScripts,
  updateScript,
  pruneScriptVersions,
  scriptRelPath,
  EXT_TO_LANGUAGE,
  LANGUAGE_TO_EXT,
  createScript,
  type ScriptLanguage,
} from "../memory/scripts.ts";
import { listCodeProjects } from "../memory/code_projects.ts";
import { listProjects } from "../memory/projects.ts";
import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { ensureSystemTask } from "../memory/scheduled_tasks.ts";
import { computeNextRun } from "../scheduler/cron.ts";

export const SCRIPTS_SYNC_HANDLER = "scripts.sync_scan";

export function scriptsSyncHandler(ctx: TaskHandlerContext): void {
  const { db, cfg } = ctx;
  for (const p of listProjects(db)) {
    for (const cp of listCodeProjects(db, p.name)) {
      syncCodeProject(db, cfg.scripts.maxVersionsPerScript, p.name, cp.name, cp.id);
    }
  }
}

function syncCodeProject(
  db: Database,
  maxVersions: number,
  bunnyProject: string,
  codeProjectName: string,
  codeProjectId: number,
): void {
  const wsRoot = workspaceDir(bunnyProject);
  const scriptsDir = join(wsRoot, `code/${codeProjectName}/scripts`);
  const tempDir = join(scriptsDir, "temp");

  // Sync existing DB scripts
  const scripts = listScripts(db, codeProjectId, { includeTemp: true });
  for (const script of scripts) {
    const relPath = scriptRelPath(
      codeProjectName,
      script.name,
      script.language,
      script.isTemp,
    );
    const absPath = join(wsRoot, relPath);

    if (!existsSync(absPath)) {
      // Restore missing file
      atomicWrite(absPath, script.content);
      continue;
    }

    const diskContent = readFileSync(absPath, "utf8");
    const diskHash = sha256Hex(diskContent);
    if (diskHash !== (script.fileHash ?? "")) {
      // External edit — update DB + create version
      updateScript(
        db,
        script.id,
        { content: diskContent, fileHash: diskHash },
        { createVersion: true },
      );
      pruneScriptVersions(db, script.id, maxVersions);
    }
  }

  // Auto-import new files dropped into scripts/ or scripts/temp/
  for (const [dir, isTemp] of [
    [scriptsDir, false],
    [tempDir, true],
  ] as [string, boolean][]) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => {
        const ext = extname(f);
        return ext in EXT_TO_LANGUAGE && !f.startsWith("__trash:");
      });
    } catch {
      continue;
    }

    for (const file of files) {
      const ext = extname(file);
      const name = basename(file, ext);
      const language = EXT_TO_LANGUAGE[ext] as ScriptLanguage;
      // Check if this script already exists in DB
      const existingInDb = scripts.some(
        (s) => s.name === name && s.language === language && s.isTemp === isTemp,
      );
      if (existingInDb) continue;

      const absPath = join(dir, file);
      let content: string;
      try {
        content = readFileSync(absPath, "utf8");
      } catch {
        continue;
      }
      const fileHash = sha256Hex(content);
      try {
        const newScript = createScript(db, {
          codeProjectId,
          project: bunnyProject,
          name,
          content,
          language,
          isTemp,
        });
        db.prepare(`UPDATE scripts SET file_hash = ? WHERE id = ?`).run(
          fileHash,
          newScript.id,
        );
      } catch {
        /* skip on name conflict */
      }
    }
  }
}

export function registerScriptsSyncHandler(
  registry: HandlerRegistry,
): void {
  registry.register(SCRIPTS_SYNC_HANDLER, scriptsSyncHandler);
}

export function seedScriptsSyncTask(
  db: Database,
  syncCron: string,
): void {
  try {
    ensureSystemTask(db, SCRIPTS_SYNC_HANDLER, {
      name: "Scripts disk sync",
      description:
        "Sync scripts between the database and disk, auto-import new files (every 5 minutes by default).",
      cronExpr: syncCron,
      nextRunAt: computeNextRun(syncCron, Date.now()),
    });
  } catch {
    /* ignore if already seeded */
  }
}
