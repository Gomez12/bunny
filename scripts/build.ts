#!/usr/bin/env bun
/**
 * Cross-platform build script.
 *
 * Compiles src/index.ts to self-contained executables for all supported
 * platforms and places them in dist/. Each binary embeds the Bun runtime
 * (no installation required on the target machine).
 *
 * Usage:
 *   bun run build                              # build all platforms
 *   bun run build:platform darwin-arm64        # single platform
 *   bun run scripts/build.ts --list            # list targets
 *
 * Output:
 *   dist/bunny-darwin-arm64
 *   dist/bunny-darwin-x64
 *   dist/bunny-linux-arm64
 *   dist/bunny-linux-x64
 *   dist/bunny-windows-x64.exe
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

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

const ROOT  = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "src", "index.ts");
const DIST  = join(ROOT, "dist");

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

const targets = platformArg
  ? TARGETS.filter((t) => t.id === platformArg)
  : TARGETS;

if (platformArg && targets.length === 0) {
  console.error(`Unknown platform: ${platformArg}`);
  console.error(`Run with --list to see available targets.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build

mkdirSync(DIST, { recursive: true });

let failed = 0;

for (const target of targets) {
  const outfile = join(DIST, target.outfile);
  process.stdout.write(`Building ${target.id.padEnd(16)} → dist/${target.outfile} … `);

  const proc = Bun.spawn(
    [
      process.execPath,           // the bun binary
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
    if (target.bunTarget.includes("darwin")) {
      Bun.spawnSync(["codesign", "--remove-signature", outfile]);
      const sign = Bun.spawnSync(["codesign", "--sign", "-", outfile]);
      if (sign.exitCode !== 0) {
        console.warn(`  ⚠ codesign failed: ${new TextDecoder().decode(sign.stderr)}`);
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

if (failed > 0) {
  console.error(`\n${failed} target(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${targets.length} target(s) built successfully → dist/`);
}
