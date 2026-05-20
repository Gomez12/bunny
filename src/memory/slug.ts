/**
 * Shared slug validation used for anything that doubles as a DB primary key
 * AND a directory name (projects, agents). The rule is deliberately strict:
 * lowercase ascii / digits / `-` / `_`, 1–63 chars, must start with a letter
 * or digit. `.` / `..` / `node_modules` are reserved because they collide
 * with FS semantics.
 */

import { SafeError } from "../util/error.ts";

const RESERVED_SLUGS = new Set([".", "..", "node_modules", ""]);

export function validateSlugName(
  raw: unknown,
  regex: RegExp,
  label: string,
): string {
  if (typeof raw !== "string")
    throw new SafeError(`${label} name must be a string`, { httpStatus: 400 });
  const name = raw.trim().toLowerCase();
  if (RESERVED_SLUGS.has(name))
    throw new SafeError(`${label} name '${name}' is reserved`, {
      httpStatus: 400,
    });
  if (!regex.test(name)) {
    throw new SafeError(
      `${label} name must match ${regex.source} (lowercase, digits, _ or -)`,
      { httpStatus: 400 },
    );
  }
  return name;
}
