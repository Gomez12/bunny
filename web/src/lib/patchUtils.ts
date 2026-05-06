/** Apply search/replace blocks to `source`. Returns null if any block fails to match. */
export function applyPatches(
  source: string,
  blocks: Array<{ search: string; replace: string }>,
): string | null {
  let result = source;
  for (const { search, replace } of blocks) {
    if (!result.includes(search)) return null;
    result = result.replace(search, replace);
  }
  return result;
}

/** Extract <<<SEARCH / === / >>>REPLACE blocks from an LLM response. */
export function extractPatches(
  text: string,
): Array<{ search: string; replace: string }> {
  const blocks: Array<{ search: string; replace: string }> = [];
  for (const m of text.matchAll(/<<<SEARCH\n([\s\S]*?)\n===\n([\s\S]*?)\n>>>REPLACE/g)) {
    blocks.push({ search: m[1]!, replace: m[2]! });
  }
  return blocks;
}

/** Extract the last fenced code block from an LLM response. */
export function extractFullBlock(text: string): string | null {
  const all = [...text.matchAll(/```(?:\w+)?\n([\s\S]*?)\n```/g)];
  return all.at(-1)?.[1] ?? null;
}
