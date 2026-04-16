/**
 * Install skills from external sources: GitHub URLs and skills.sh identifiers.
 *
 * GitHub URLs of the form `github.com/owner/repo/tree/branch/path/to/skill`
 * are decomposed into GitHub Contents API calls to fetch the skill directory.
 *
 * skills.sh identifiers (`owner/repo` or `owner/repo/path`) are resolved to
 * GitHub URLs and delegated to the GitHub installer.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { paths } from "../paths.ts";
import { validateSkillName } from "./skills.ts";
import { parseFrontmatter } from "./skill_assets.ts";

export interface InstallResult {
  name: string;
  description: string;
  sourceUrl: string;
  sourceRef: string | null;
}

export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

export function parseGitHubUrl(url: string): ParsedGitHubUrl {
  const cleaned = url.replace(/\/$/, "");
  let u: URL;
  try {
    u = new URL(cleaned);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (u.hostname !== "github.com") {
    throw new Error(`not a GitHub URL: ${url}`);
  }
  // /owner/repo/tree/branch/path/to/skill
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`cannot extract owner/repo from: ${url}`);
  }
  const owner = parts[0]!;
  const repo = parts[1]!;
  if (parts.length >= 4 && parts[2] === "tree") {
    const ref = parts[3]!;
    const path = parts.slice(4).join("/");
    return { owner, repo, ref, path };
  }
  if (parts.length >= 4 && parts[2] === "blob") {
    const ref = parts[3]!;
    const path = parts.slice(4).join("/");
    return { owner, repo, ref, path };
  }
  return { owner, repo, ref: "main", path: parts.slice(2).join("/") };
}

interface GitHubContentEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  download_url: string | null;
  sha: string;
}

async function fetchGitHubContents(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<GitHubContentEntry[]> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
  const res = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "bunny-skill-installer",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`expected directory listing at ${path}, got a single file`);
  }
  return data as GitHubContentEntry[];
}

async function fetchFileContent(downloadUrl: string): Promise<string> {
  const res = await fetch(downloadUrl, {
    headers: { "User-Agent": "bunny-skill-installer" },
  });
  if (!res.ok) throw new Error(`failed to fetch ${downloadUrl}: ${res.status}`);
  return res.text();
}

async function fetchFileContentBinary(downloadUrl: string): Promise<Buffer> {
  const res = await fetch(downloadUrl, {
    headers: { "User-Agent": "bunny-skill-installer" },
  });
  if (!res.ok) throw new Error(`failed to fetch ${downloadUrl}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadDirectory(
  owner: string,
  repo: string,
  remotePath: string,
  ref: string,
  localDir: string,
  rootRef: { sha: string | null },
): Promise<void> {
  const entries = await fetchGitHubContents(owner, repo, remotePath, ref);
  for (const entry of entries) {
    const localPath = join(localDir, entry.name);
    if (entry.type === "file" && entry.download_url) {
      mkdirSync(dirname(localPath), { recursive: true });
      const content = await fetchFileContentBinary(entry.download_url);
      writeFileSync(localPath, content);
      if (!rootRef.sha) rootRef.sha = entry.sha;
    } else if (entry.type === "dir") {
      await downloadDirectory(owner, repo, entry.path, ref, localPath, rootRef);
    }
  }
}

export async function installSkillFromGitHub(
  url: string,
  targetName?: string,
): Promise<InstallResult> {
  const parsed = parseGitHubUrl(url);
  const { owner, repo, ref, path } = parsed;

  const entries = await fetchGitHubContents(owner, repo, path, ref);
  const skillMdEntry = entries.find((e) => e.name === "SKILL.md" && e.type === "file");
  if (!skillMdEntry || !skillMdEntry.download_url) {
    throw new Error(`no SKILL.md found at ${url}`);
  }

  const skillMdContent = await fetchFileContent(skillMdEntry.download_url);
  const { frontmatter } = parseFrontmatter(skillMdContent, "");

  const dirName = path.split("/").filter(Boolean).pop() ?? "";
  const skillName = validateSkillName(targetName ?? (frontmatter.name || dirName));

  const skillDir = paths.skillDir(skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skillMdContent, "utf8");

  const rootRef = { sha: skillMdEntry.sha };
  for (const entry of entries) {
    if (entry.name === "SKILL.md") continue;
    if (entry.type === "file" && entry.download_url) {
      const content = await fetchFileContentBinary(entry.download_url);
      writeFileSync(join(skillDir, entry.name), content);
    } else if (entry.type === "dir") {
      const subDir = join(skillDir, entry.name);
      mkdirSync(subDir, { recursive: true });
      await downloadDirectory(owner, repo, entry.path, ref, subDir, rootRef);
    }
  }

  return {
    name: skillName,
    description: frontmatter.description || "",
    sourceUrl: url,
    sourceRef: rootRef.sha,
  };
}

export async function installSkillFromSkillsSh(
  identifier: string,
  targetName?: string,
): Promise<InstallResult> {
  // skills.sh identifiers are GitHub-backed: `owner/repo` or `owner/repo/path`.
  // We construct the GitHub URL and delegate.
  const parts = identifier.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) {
    throw new Error(`invalid skills.sh identifier: ${identifier} (expected owner/repo[/path])`);
  }
  const githubUrl = `https://github.com/${parts.join("/")}`;
  return installSkillFromGitHub(githubUrl, targetName);
}
