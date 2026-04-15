#!/usr/bin/env bun
/**
 * Cross-platform build script.
 *
 * Compiles src/index.ts to self-contained executables for all supported
 * platforms and places them in dist/. Each binary embeds the Bun runtime
 * (no installation required on the target machine).
 *
 * The Vite web bundle (web/dist) is built first and then embedded into each
 * binary by generating src/server/web_bundle.ts with `import ... with {type:
 * "file"}` entries. After compilation the stub manifest is restored so the
 * file stays inert in git / tests.
 *
 * Usage:
 *   bun run build                              # build web + all binaries
 *   bun run build:platform darwin-arm64        # single platform
 *   bun run scripts/build.ts --list            # list targets
 *   bun run scripts/build.ts --no-web          # skip Vite step (reuse existing web/dist)
 *
 * Output:
 *   dist/bunny-darwin-arm64
 *   dist/bunny-darwin-x64
 *   dist/bunny-linux-arm64
 *   dist/bunny-linux-x64
 *   dist/bunny-windows-x64.exe
 */

import { mkdirSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";

interface Target {
  id: string;
  bunTarget: string;
  outfile: string;
}

const TARGETS: Target[] = [
  { id: "darwin-arm64", bunTarget: "bun-darwin-arm64", outfile: "bunny-darwin-arm64" },
  { id: "darwin-x64",   bunTarget: "bun-darwin-x64",   outfile: "bunny-darwin-x64" },
  { id: "linux-arm64",  bunTarget: "bun-linux-arm64",   outfile: "bunny-linux-arm64" },
  { id: "linux-x64",    bunTarget: "bun-linux-x64",     outfile: "bunny-linux-x64" },
  { id: "windows-x64",  bunTarget: "bun-windows-x64",   outfile: "bunny-windows-x64.exe" },
];

const ROOT         = resolve(import.meta.dir, "..");
const ENTRY        = join(ROOT, "src", "index.ts");
const DIST         = join(ROOT, "dist");
const WEB_DIR      = join(ROOT, "web");
const WEB_DIST     = join(WEB_DIR, "dist");
const BUNDLE_FILE  = join(ROOT, "src", "server", "web_bundle.ts");

const BUNDLE_STUB = `/**
 * Embedded web bundle manifest.
 *
 * Stub by default — replaced by \`scripts/build.ts\` just before \`bun build
 * --compile\` with a version that imports every file under \`web/dist/\` using
 * \`with { type: "file" }\`. Bun embeds those bytes into the compiled binary
 * and the imported value is a path that works at runtime.
 *
 * Keep the stub checked in so \`bun test\` / \`bun run src/index.ts\` compile
 * without a prior \`bun run web:build\`.
 */

/** Maps a URL pathname (e.g. "/index.html", "/assets/foo-abc.js") to a
 * Bun-readable path (real FS path in dev, \`/$bunfs/...\` in a compiled binary). */
export const webBundle: Record<string, string> = {};
`;

// ---------------------------------------------------------------------------
// CLI argument parsing

const args = process.argv.slice(2);

if (args.includes("--list")) {
  console.log("Available targets:");
  for (const t of TARGETS) console.log(`  ${t.id}`);
  process.exit(0);
}

const platformArg = (() => {
  const idx = args.indexOf("--platform");
  return idx !== -1 ? args[idx + 1] : undefined;
})();

const skipWeb = args.includes("--no-web");

const targets = platformArg
  ? TARGETS.filter((t) => t.id === platformArg)
  : TARGETS;

if (platformArg && targets.length === 0) {
  console.error(`Unknown platform: ${platformArg}`);
  console.error(`Run with --list to see available targets.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Web bundle

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walkFiles(p, acc);
    else if (s.isFile()) acc.push(p);
  }
  return acc;
}

function buildWeb(): void {
  if (skipWeb) {
    process.stdout.write("Skipping Vite build (--no-web)\n");
    return;
  }
  process.stdout.write("Building web bundle (vite) … ");
  if (!existsSync(join(WEB_DIR, "node_modules"))) {
    const install = Bun.spawnSync(["bun", "install"], { cwd: WEB_DIR });
    if (install.exitCode !== 0) {
      process.stderr.write(new TextDecoder().decode(install.stderr));
      throw new Error("web: bun install failed");
    }
  }
  const vite = Bun.spawnSync(["bun", "run", "build"], { cwd: WEB_DIR });
  if (vite.exitCode !== 0) {
    process.stderr.write(new TextDecoder().decode(vite.stderr));
    throw new Error("web: vite build failed");
  }
  console.log("✓");
}

/** Generate the web_bundle.ts manifest listing every file in web/dist/. */
function writeBundleManifest(): void {
  if (!existsSync(WEB_DIST)) {
    throw new Error(`web/dist not found — run \`bun run web:build\` or drop --no-web`);
  }
  const files = walkFiles(WEB_DIST);
  const lines: string[] = [];
  const keys: string[] = [];
  files.forEach((abs, i) => {
    // Import path is relative to BUNDLE_FILE (src/server/web_bundle.ts).
    const importPath = "./" + posix.normalize(relative(join(ROOT, "src", "server"), abs).split(/\\|\//).join("/"));
    // Map key is the URL pathname: "/index.html", "/assets/foo.js", …
    const key = "/" + relative(WEB_DIST, abs).split(/\\|\//).join("/");
    lines.push(`import _${i} from ${JSON.stringify(importPath)} with { type: "file" };`);
    keys.push(`  ${JSON.stringify(key)}: _${i},`);
  });

  const src =
    `// GENERATED by scripts/build.ts — do not edit.\n` +
    lines.join("\n") +
    `\n\nexport const webBundle: Record<string, string> = {\n` +
    keys.join("\n") +
    `\n};\n`;
  writeFileSync(BUNDLE_FILE, src);
  process.stdout.write(`Web manifest: ${files.length} files embedded\n`);
}

function restoreBundleStub(): void {
  writeFileSync(BUNDLE_FILE, BUNDLE_STUB);
}

// ---------------------------------------------------------------------------
// Build

mkdirSync(DIST, { recursive: true });

let failed = 0;

try {
  buildWeb();
  writeBundleManifest();

  for (const target of targets) {
    const outfile = join(DIST, target.outfile);
    process.stdout.write(`Building ${target.id.padEnd(16)} → dist/${target.outfile} … `);

    const proc = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        `--target=${target.bunTarget}`,
        `--outfile=${outfile}`,
        "--minify",
        ENTRY,
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    if (exitCode === 0) {
      // Re-sign darwin binaries: bun --compile embeds an invalid signature that
      // macOS SIGKILL's on launch. Remove the bad signature first, then re-sign.
      // Only possible on macOS — on other hosts (CI Linux) we skip and users
      // can re-sign locally with `codesign --sign - bunny-darwin-*`.
      if (target.bunTarget.includes("darwin") && process.platform === "darwin") {
        try {
          Bun.spawnSync(["codesign", "--remove-signature", outfile]);
          const sign = Bun.spawnSync(["codesign", "--sign", "-", outfile]);
          if (sign.exitCode !== 0) {
            console.warn(`  ⚠ codesign failed: ${new TextDecoder().decode(sign.stderr)}`);
          }
        } catch (err) {
          console.warn(`  ⚠ codesign skipped: ${err}`);
        }
      }

      try {
        const size = Bun.file(outfile).size;
        const mb = (size / 1_000_000).toFixed(1);
        console.log(`✓  (${mb} MB)`);
      } catch {
        console.log("✓");
      }
    } else {
      console.log("✗  FAILED");
      process.stderr.write(stderr);
      failed++;
    }
  }
} finally {
  // Always restore the stub so git stays clean and `bun test` works.
  restoreBundleStub();
}

if (failed > 0) {
  console.error(`\n${failed} target(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${targets.length} target(s) built successfully → dist/`);
}
