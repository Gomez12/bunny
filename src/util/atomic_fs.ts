import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/** Write `content` to `absPath` atomically: write to `.tmp` then rename. */
export function atomicWrite(absPath: string, content: string): void {
  const tmp = absPath + ".tmp";
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, absPath);
}
