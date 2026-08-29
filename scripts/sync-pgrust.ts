/**
 * Populate `src/vendor/pgrust/` and `public/pgrust/` from a pgrust checkout.
 *
 * Two independent steps:
 *
 * 1. **Vendor** — the browser host JS (`pgrust-wasi.js`, `wiresession.js`, `wire.js`) plus pgrust's
 *    `LICENSE` and `NOTICE`, copied byte-verbatim into `src/vendor/pgrust/` and committed. The
 *    synced commit is written to `src/vendor/pgrust/VERSION`, which `vite.config.ts` stamps into
 *    the environment header, and provenance to `src/vendor/pgrust/SOURCE.md`.
 * 2. **Assets** — the build outputs (`postgres.wasm`, `vfs.img`, `vfs.json`) copied into
 *    `public/pgrust/`, which is gitignored. They only exist after a compile in the pgrust checkout,
 *    so their absence is reported as a clear, actionable failure rather than a stack trace.
 *
 * Usage:
 *   bun run sync:pgrust                 # vendor + assets (fails if the assets are not built)
 *   bun run sync:pgrust --vendor-only   # vendor only, never touches public/pgrust/
 *   PGRUST_DIR=/path/to/pgrust bun run sync:pgrust
 */

import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PGRUST_DIR = "../pgrust";

/** Copied byte-verbatim into `src/vendor/pgrust/`; paths are relative to the pgrust checkout. */
const VENDORED_FILES: readonly string[] = [
  "wasm/pgrust-wasi.js",
  "wasm/wiresession.js",
  "wasm/wire.js",
  "LICENSE",
  "NOTICE",
];

/** Copied into `public/pgrust/`; paths are relative to the pgrust checkout. */
const ASSET_FILES: readonly string[] = ["wasm/assets/postgres.wasm", "wasm/assets/vfs.img", "wasm/assets/vfs.json"];

/** What to run in the pgrust checkout when the assets are missing. */
const ASSET_BUILD_HINT = ["PGRUST_WASM_PROFILE=wasm-release wasm/wasm-build.sh", "wasm/build.sh"];

const VENDOR_DIR = resolve(REPO_ROOT, "src/vendor/pgrust");
const PUBLIC_DIR = resolve(REPO_ROOT, "public/pgrust");

interface Options {
  readonly vendorOnly: boolean;
  readonly sourceDir: string;
}

interface Checkout {
  readonly dir: string;
  readonly sha: string;
  readonly shortSha: string;
  readonly dirty: boolean;
}

function fail(message: string): never {
  console.error(`sync:pgrust: ${message}`);
  process.exit(1);
}

function parseOptions(argv: readonly string[]): Options {
  let vendorOnly = false;
  for (const argument of argv) {
    if (argument === "--vendor-only") {
      vendorOnly = true;
      continue;
    }
    fail(`unknown argument "${argument}" (expected --vendor-only)`);
  }
  const configured = process.env["PGRUST_DIR"];
  const raw = configured === undefined || configured === "" ? DEFAULT_PGRUST_DIR : configured;
  return { vendorOnly, sourceDir: isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw) };
}

/** Run git in `cwd` and return trimmed stdout, or null when git itself failed. */
function git(cwd: string, args: readonly string[]): string | null {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.toString().trim();
}

function readCheckout(sourceDir: string): Checkout {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    fail(`pgrust checkout not found at ${sourceDir} (set PGRUST_DIR to override)`);
  }
  const sha = git(sourceDir, ["rev-parse", "HEAD"]);
  const shortSha = git(sourceDir, ["rev-parse", "--short", "HEAD"]);
  const porcelain = git(sourceDir, ["status", "--porcelain"]);
  if (sha === null || shortSha === null || porcelain === null) {
    fail(`${sourceDir} is not a git checkout (or git is unavailable)`);
  }
  return { dir: sourceDir, sha, shortSha, dirty: porcelain !== "" };
}

function version(checkout: Checkout): string {
  return checkout.dirty ? `${checkout.shortSha}-dirty` : checkout.shortSha;
}

function sourceMarkdown(checkout: Checkout, files: readonly string[]): string {
  const lines = [
    "# Vendored from pgrust",
    "",
    "Copied byte-verbatim by `bun run sync:pgrust`. **Do not edit these files by hand** — re-run the",
    "script against an updated pgrust checkout instead. They are excluded from oxlint and oxfmt so",
    "they stay identical to their source.",
    "",
    `- Commit: \`${checkout.sha}\``,
    `- Version: \`${version(checkout)}\``,
    `- Source: \`${checkout.dir}\``,
    `- Working tree: ${checkout.dirty ? "dirty at sync time" : "clean"}`,
    `- Synced: ${new Date().toISOString()}`,
    "",
    "## Files",
    "",
    ...files.map((file) => `- \`${file}\``),
    "",
    "pgrust is AGPL-3.0-only; its `LICENSE` and `NOTICE` are vendored alongside the source.",
    "",
  ];
  return lines.join("\n");
}

/** Copy `files` from the checkout into `destination`; returns the missing ones instead of throwing. */
function copyInto(checkout: Checkout, files: readonly string[], destination: string): readonly string[] {
  const missing = files.filter((file) => !existsSync(join(checkout.dir, file)));
  if (missing.length > 0) {
    return missing;
  }
  mkdirSync(destination, { recursive: true });
  for (const file of files) {
    const from = join(checkout.dir, file);
    const to = join(destination, basename(file));
    copyFileSync(from, to);
    console.log(`  ${file} -> ${relativeToRepo(to)} (${statSync(to).size} bytes)`);
  }
  return [];
}

function relativeToRepo(path: string): string {
  return path.startsWith(`${REPO_ROOT}/`) ? path.slice(REPO_ROOT.length + 1) : path;
}

function syncVendor(checkout: Checkout): void {
  console.log(`Vendoring pgrust host JS from ${checkout.dir} @ ${version(checkout)}`);
  const missing = copyInto(checkout, VENDORED_FILES, VENDOR_DIR);
  if (missing.length > 0) {
    fail(`missing source file(s) in ${checkout.dir}: ${missing.join(", ")}`);
  }
  writeFileSync(join(VENDOR_DIR, "VERSION"), `${version(checkout)}\n`, "utf8");
  writeFileSync(join(VENDOR_DIR, "SOURCE.md"), sourceMarkdown(checkout, VENDORED_FILES), "utf8");
  console.log(`  VERSION -> ${version(checkout)}`);
}

/** Returns false when an asset is missing; the vendor step has already completed by then. */
function syncAssets(checkout: Checkout): boolean {
  console.log(`Copying pgrust build assets into ${relativeToRepo(PUBLIC_DIR)}/`);
  const missing = copyInto(checkout, ASSET_FILES, PUBLIC_DIR);
  if (missing.length === 0) {
    return true;
  }
  console.error("");
  console.error("sync:pgrust: the pgrust wasm build assets are not present:");
  for (const file of missing) {
    console.error(`  missing: ${join(checkout.dir, file)}`);
  }
  console.error("");
  console.error(`Build them in the pgrust checkout (${checkout.dir}), then re-run this script:`);
  for (const command of ASSET_BUILD_HINT) {
    console.error(`  ${command}`);
  }
  console.error("");
  console.error("The vendored host JS in src/vendor/pgrust/ was synced successfully.");
  console.error("Pass --vendor-only to sync just the host JS and skip the assets.");
  return false;
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const checkout = readCheckout(options.sourceDir);
  syncVendor(checkout);

  if (options.vendorOnly) {
    console.log("");
    console.log(`Done (vendor only): pgrust ${version(checkout)} vendored; public/pgrust/ left untouched.`);
    return;
  }

  console.log("");
  if (!syncAssets(checkout)) {
    process.exit(1);
  }
  console.log("");
  console.log(`Done: pgrust ${version(checkout)} vendored and assets copied.`);
}

main();
