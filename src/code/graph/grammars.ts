/**
 * Lazy tree-sitter grammar loader. All 11 WASMs ship inside the portable
 * binary via `with { type: "file" }`; `Parser.init` is called once per
 * process, grammars are cached by language key.
 *
 * A failure to load a single grammar is non-fatal: the run continues and
 * that language falls back to "module-only" extraction (one module node per
 * file, no edges).
 */

import Parser from "web-tree-sitter";

// Grammar WASM imports — Bun turns these into file paths that resolve both
// during `bun run` and inside a compiled binary.
import runtimeWasmPath from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import tsWasmPath from "tree-sitter-wasms/out/tree-sitter-typescript.wasm" with { type: "file" };
import tsxWasmPath from "tree-sitter-wasms/out/tree-sitter-tsx.wasm" with { type: "file" };
import jsWasmPath from "tree-sitter-wasms/out/tree-sitter-javascript.wasm" with { type: "file" };
import pyWasmPath from "tree-sitter-wasms/out/tree-sitter-python.wasm" with { type: "file" };
import goWasmPath from "tree-sitter-wasms/out/tree-sitter-go.wasm" with { type: "file" };
import rsWasmPath from "tree-sitter-wasms/out/tree-sitter-rust.wasm" with { type: "file" };
import javaWasmPath from "tree-sitter-wasms/out/tree-sitter-java.wasm" with { type: "file" };
import cWasmPath from "tree-sitter-wasms/out/tree-sitter-c.wasm" with { type: "file" };
import cppWasmPath from "tree-sitter-wasms/out/tree-sitter-cpp.wasm" with { type: "file" };
import rbWasmPath from "tree-sitter-wasms/out/tree-sitter-ruby.wasm" with { type: "file" };
import phpWasmPath from "tree-sitter-wasms/out/tree-sitter-php.wasm" with { type: "file" };

export type LangKey =
  | "ts"
  | "tsx"
  | "js"
  | "py"
  | "go"
  | "rs"
  | "java"
  | "c"
  | "cpp"
  | "rb"
  | "php";

/** Source file extensions we know how to parse → language key. */
export const EXTENSION_TO_LANG: Readonly<Record<string, LangKey>> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  pyi: "py",
  go: "go",
  rs: "rs",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  rb: "rb",
  php: "php",
};

const WASM_PATHS: Readonly<Record<LangKey, string>> = {
  ts: tsWasmPath,
  tsx: tsxWasmPath,
  js: jsWasmPath,
  py: pyWasmPath,
  go: goWasmPath,
  rs: rsWasmPath,
  java: javaWasmPath,
  c: cWasmPath,
  cpp: cppWasmPath,
  rb: rbWasmPath,
  php: phpWasmPath,
};

// In `web-tree-sitter@0.22.x` the default export is the `Parser` constructor
// itself; `Parser.Language` is a static namespace that loads grammar WASMs.
// The `init` call loads the runtime WASM exactly once.
type LanguageInstance = unknown;

let initPromise: Promise<void> | undefined;
const grammarCache = new Map<LangKey, LanguageInstance>();
const grammarLoadErrors = new Map<LangKey, string>();

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (
    Parser as unknown as {
      init(opts: { locateFile: (name: string) => string }): Promise<void>;
    }
  ).init({ locateFile: () => runtimeWasmPath });
  return initPromise;
}

/**
 * Load the grammar for `lang`. Returns the cached Language handle on hit,
 * otherwise loads the WASM and caches it. A load failure is remembered in
 * `grammarLoadErrors` so we don't retry on every file — the first caller
 * sees the error message and every subsequent call returns undefined.
 */
export async function loadGrammar(
  lang: LangKey,
): Promise<LanguageInstance | undefined> {
  if (grammarCache.has(lang)) return grammarCache.get(lang);
  if (grammarLoadErrors.has(lang)) return undefined;
  await ensureInit();
  try {
    const Language = (
      Parser as unknown as { Language: { load(path: string): Promise<LanguageInstance> } }
    ).Language;
    const inst = await Language.load(WASM_PATHS[lang]);
    grammarCache.set(lang, inst);
    return inst;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    grammarLoadErrors.set(lang, msg);
    return undefined;
  }
}

/** Build a fresh Parser bound to the given grammar. The Parser is single-file;
 *  callers must create one per source file parse. */
export async function parserFor(lang: LangKey): Promise<Parser | undefined> {
  const grammar = await loadGrammar(lang);
  if (!grammar) return undefined;
  const parser = new Parser();
  (parser as unknown as { setLanguage(g: LanguageInstance): void }).setLanguage(
    grammar,
  );
  return parser;
}

/** Lookup helper for tests and the walker — returns the lang key for a file extension, or undefined. */
export function langForFile(filePath: string): LangKey | undefined {
  const idx = filePath.lastIndexOf(".");
  if (idx < 0) return undefined;
  const ext = filePath.slice(idx + 1).toLowerCase();
  return EXTENSION_TO_LANG[ext];
}

/** For cache key + meta.json. Bumped manually when a walker is rewritten so
 *  cached extractions from the old walker get invalidated. */
export const GRAMMAR_VERSIONS: Readonly<Record<LangKey, string>> = {
  ts: "0.1.13",
  tsx: "0.1.13",
  js: "0.1.13",
  py: "0.1.13",
  go: "0.1.13",
  rs: "0.1.13",
  java: "0.1.13",
  c: "0.1.13",
  cpp: "0.1.13",
  rb: "0.1.13",
  php: "0.1.13",
};

/** Test/bench hook — forget all cached grammars + init. */
export function _resetGrammarCacheForTests(): void {
  initPromise = undefined;
  grammarCache.clear();
  grammarLoadErrors.clear();
}
