/**
 * On-disk assets for a skill: a `SKILL.md` file under
 * `$BUNNY_HOME/skills/<name>/` following the agentskills.io standard.
 *
 * The SKILL.md file has YAML frontmatter (name, description, license, etc.)
 * and a markdown body containing the skill instructions.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import { paths } from "../paths.ts";
import { validateSkillName, type Skill } from "./skills.ts";

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

export interface SkillAssets {
  frontmatter: SkillFrontmatter;
  instructions: string;
  raw: string;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
}

const SKILL_FILE = "SKILL.md";

export function skillDir(name: string): string {
  return paths.skillDir(validateSkillName(name));
}

export function ensureSkillDir(name: string, initialContent?: string): string {
  const dir = skillDir(name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, SKILL_FILE);
  if (initialContent !== undefined) {
    writeFileSync(file, initialContent, "utf8");
  }
  return dir;
}

export function writeSkillMd(name: string, content: string): void {
  const dir = skillDir(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SKILL_FILE), content, "utf8");
}

const assetsCache = new Map<string, { mtimeMs: number; assets: SkillAssets }>();

export function loadSkillAssets(name: string): SkillAssets {
  const file = join(skillDir(name), SKILL_FILE);
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    // Missing file — return empty defaults.
  }
  const hit = assetsCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.assets;
  if (mtimeMs < 0) {
    return {
      frontmatter: { name, description: "" },
      instructions: "",
      raw: "",
    };
  }
  try {
    const raw = readFileSync(file, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw, name);
    const assets: SkillAssets = { frontmatter, instructions: body, raw };
    assetsCache.set(file, { mtimeMs, assets });
    return assets;
  } catch {
    return {
      frontmatter: { name, description: "" },
      instructions: "",
      raw: "",
    };
  }
}

function unquoteYaml(s: string): string {
  if (s.length >= 2) {
    const f = s[0], l = s[s.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) return s.slice(1, -1);
  }
  return s;
}

function parseSkillYamlFrontmatter(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = block.split("\n");
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    if (!raw.trim() || raw.trimStart().startsWith("#")) { i++; continue; }
    const m = raw.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)/);
    if (!m) { i++; continue; }
    const key = m[1] ?? "";
    const rest = (m[2] ?? "").trim();
    if (rest) {
      result[key] = unquoteYaml(rest);
      i++;
    } else {
      i++;
      const children: string[] = [];
      while (i < lines.length) {
        const line = lines[i] ?? "";
        if (!line.trim()) { i++; continue; }
        if (!line.match(/^\s/)) break;
        children.push(line);
        i++;
      }
      if (children.length > 0) {
        const nested: Record<string, string> = {};
        for (const child of children) {
          const cm = child.match(/^\s+([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)/);
          if (cm) nested[cm[1] ?? ""] = unquoteYaml((cm[2] ?? "").trim());
        }
        if (Object.keys(nested).length > 0) result[key] = nested;
      }
    }
  }
  return result;
}

export function parseFrontmatter(
  raw: string,
  fallbackName: string,
): { frontmatter: SkillFrontmatter; body: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return {
      frontmatter: { name: fallbackName, description: "" },
      body: raw.trim(),
    };
  }
  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx < 0) {
    return {
      frontmatter: { name: fallbackName, description: "" },
      body: raw.trim(),
    };
  }
  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = parseSkillYamlFrontmatter(yamlBlock);
  } catch {
    parsed = {};
  }
  const frontmatter: SkillFrontmatter = {
    name: typeof parsed["name"] === "string" ? parsed["name"] : fallbackName,
    description:
      typeof parsed["description"] === "string" ? parsed["description"] : "",
    license:
      typeof parsed["license"] === "string" ? parsed["license"] : undefined,
    compatibility:
      typeof parsed["compatibility"] === "string"
        ? parsed["compatibility"]
        : undefined,
    metadata:
      parsed["metadata"] &&
      typeof parsed["metadata"] === "object" &&
      !Array.isArray(parsed["metadata"])
        ? (parsed["metadata"] as Record<string, string>)
        : undefined,
    allowedTools:
      typeof parsed["allowed-tools"] === "string"
        ? parsed["allowed-tools"].split(/\s+/).filter(Boolean)
        : undefined,
  };
  return { frontmatter, body };
}

export function buildSkillCatalog(skills: Skill[]): SkillCatalogEntry[] {
  return skills.map((s) => {
    try {
      const assets = loadSkillAssets(s.name);
      return {
        name: s.name,
        description: assets.frontmatter.description || s.description,
      };
    } catch {
      return { name: s.name, description: s.description };
    }
  });
}

export function listSkillResources(name: string): string[] {
  const dir = skillDir(name);
  const results: string[] = [];
  function walk(current: string) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name !== SKILL_FILE) {
        results.push(relative(dir, full));
      }
    }
  }
  walk(dir);
  return results.sort();
}
