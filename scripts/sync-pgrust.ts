/**
 * Populate `src/vendor/pgrust/` and `public/pgrust/`.
 *
 * Four halves, from three independent sources:
 *
 * 1. **Vendor** — the browser host JS (the `--stdio-wire` trio, and the `wasm32-wasip1-threads`
 *    host beside it) plus pgrust's `LICENSE` and `NOTICE`, copied byte-verbatim from a **pgrust
 *    checkout** into `src/vendor/pgrust/` and committed. The synced commit is written to
 *    `src/vendor/pgrust/VERSION`, which `vite.config.ts` stamps into the environment header, and
 *    provenance to `SOURCE.md`.
 * 2. **Assets** — the ~131 MB build outputs (`postgres.wasm`, `postgres-threads.wasm`, `vfs.img`,
 *    `vfs.json`) written to `public/pgrust/`, which is gitignored. They come either from a **GitHub
 *    Release** of this repo (`--release`, the normal path: no pgrust checkout and no Rust toolchain
 *    needed) or from a local pgrust checkout (the default, for a build you made yourself).
 * 3. **Host runtime** — the threads host again, laid out under `public/pgrust/host/` and served
 *    verbatim, because it builds its workers from URLs it computes at run time and therefore cannot
 *    be bundled without editing it. Copied from the committed vendored copy, not from a checkout.
 * 4. **Store bundle** — the **pre-release** `@pgxsinkit/pglite-opfs-repacked` build the broker
 *    columns load, which arrives with the release (`--release`, so a clone needs no pgxsinkit
 *    checkout either) or is copied out of a **pgxsinkit checkout** when the release predates it or
 *    when you are building the release. No published version of that package carries the sync
 *    broker, so this is the one thing here that no npm release corresponds to; it is recorded in
 *    `SOURCE.md` with its own commit — identically from either path — and the columns' own labels
 *    say so.
 *
 * `--release` deliberately never touches the vendored host JS: releases carry binaries, not source,
 * and the JS is committed here. When the two end up on different pgrust commits that is reported
 * loudly rather than silently benchmarked.
 *
 * Beside those, **alternate threads modules** (`--alt-release <tag>`, repeatable): one release's
 * `postgres-threads.wasm` and nothing else, verified like any release asset and installed at
 * `public/pgrust/alt/<short commit>/` with that release's `manifest.json` beside it. The page loads
 * one only when `?pgrustModule=<short commit>` asks for it (`src/pgrust-module.ts`), and the six
 * threads and postmaster columns then run it on this sync's host JS, image and store bundle — a
 * comparison of two threads modules and nothing else. `public/pgrust/alt/` is left holding exactly
 * the alternates asked for, so the same command gives the same `dist/` on a workstation and on the
 * Pages workflow.
 *
 * Usage:
 *   bun run sync:pgrust --release latest       # newest published assets, no checkout needed
 *   bun run sync:pgrust --release pgrust-assets/dab0f929
 *   bun run sync:pgrust --release latest --alt-release pgrust-assets/3624f82c
 *   bun run sync:pgrust                        # vendor + assets from a pgrust checkout
 *   bun run sync:pgrust --vendor-only          # host JS only, never touches public/pgrust/
 *   PGRUST_DIR=/path/to/pgrust bun run sync:pgrust
 *
 * Environment:
 *   PGRUST_DIR                        pgrust checkout (default ../pgrust)
 *   PGXSINKIT_DIR                     pgxsinkit checkout for the store bundle (default ../pgxsinkit)
 *   PGLITE_V_PGRUST_RELEASE_REPO      repo whose releases are read (default pgxsinkit/pglite-v-pgrust)
 *   PGLITE_V_PGRUST_RELEASE_BASE_URL  fetch the --release assets from this directory URL instead of
 *                                     GitHub (an --alt-release is always read from the release repo)
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ALTERNATE_MODULES_DIRECTORY, THREADS_MODULE_FILE } from "../src/pgrust-module";
import { fetchAlternateThreadsModule, fetchReleaseBundle, fetchReleaseList } from "./pgrust-assets/download";
import type { AssetManifest } from "./pgrust-assets/manifest";
import { bundleDirectoryName, STORE_DEFAULT_BRANCH, STORE_REPOSITORY } from "./pgrust-assets/manifest";
import {
  alternateModuleId,
  DEFAULT_RELEASE_REPOSITORY,
  LATEST_RELEASE,
  releaseDownloadBase,
  resolveReleaseTag,
} from "./pgrust-assets/release";
import {
  checkoutAssetsSection,
  extractAssetsSection,
  extractStoreBundleSection,
  readVendorCommit,
  releaseAssetsSection,
  replaceAssetsSection,
  replaceStoreBundleSection,
  storeBundleSection,
  storeProvenanceFromManifest,
  vendorMismatchWarning,
} from "./pgrust-assets/source-md";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PGRUST_DIR = "../pgrust";

/** Copied byte-verbatim into `src/vendor/pgrust/`; paths are relative to the pgrust checkout. */
const VENDORED_FILES: readonly string[] = [
  "wasm/pgrust-wasi.js",
  "wasm/wiresession.js",
  "wasm/wire.js",
  // The `wasm32-wasip1-threads` host: the JS half of the threads build, which imports a shared
  // `WebAssembly.Memory`, answers `wasi` `thread-spawn` out of a prewarmed worker pool and blocks
  // the guest's `read(0)` in `Atomics.wait` instead of suspending it with JSPI.
  "wasm/threads-host.js",
  // One worker bootstrap, three roles (process / thread-prewarm / thread-start).
  "wasm/thread-worker.js",
  // The two Node/bun worker entries. `threadWorkerUrl`/`storageWorkerUrl` resolve `.mjs` off the
  // host base whenever `IS_NODE`, so the bun lane (`scripts/pgxsinkit-live-scenario.ts`) cannot
  // start a thread or a store without them; each is a one-line re-export of the `.js` beside it.
  "wasm/thread-worker.mjs",
  "wasm/storage-worker.mjs",
  // The SharedArrayBuffer byte ring stdin and stdout ride on.
  "wasm/sab-pipe.js",
  // The `--fs broker` seam, and the storage coordinator on the other end of it.
  "wasm/broker-fs.js",
  "wasm/storage-worker.js",
  // The optional store counters every host above can be handed (`?brokerStats=1`): guest file
  // calls per agent, the coordinator's broker requests and its storage handle calls.
  "wasm/io-stats.js",
  "LICENSE",
  "NOTICE",
];

/**
 * The vendored host JS the threads Engine loads at **runtime**, copied from `src/vendor/pgrust/`
 * into `public/pgrust/host/` and served verbatim.
 *
 * These five (plus `pgrust-wasi.js` and `io-stats.js`, which `threads-host.js` imports) cannot be
 * bundled: the host builds its workers from URLs it computes at run time — `threadWorkerUrl(base)`,
 * `storageWorkerUrl(base)` — and Vite only rewrites the literal
 * `new Worker(new URL("./x", import.meta.url))` form. Bundling them would either break those URLs
 * or force an edit to a file that must stay byte-identical to pgrust's. Served as static assets
 * they keep their own relative imports and their own module identity, and the engine worker
 * reaches them with one `import()` of a runtime URL.
 *
 * Names only: the source is the committed vendored copy, so the `--release` path can lay them out
 * too without a pgrust checkout.
 */
const HOST_RUNTIME_FILES: readonly string[] = [
  "threads-host.js",
  "thread-worker.js",
  "sab-pipe.js",
  "broker-fs.js",
  "storage-worker.js",
  "pgrust-wasi.js",
  // Imported by `threads-host.js`, `storage-worker.js` and `wiresession.js`.
  "io-stats.js",
  // The Node/bun worker entries, laid out beside the `.js` they re-export: the browser Engines never
  // touch them, but the bun lane loads the host from this same directory and `IS_NODE` sends
  // `threadWorkerUrl`/`storageWorkerUrl` at the `.mjs` names.
  "thread-worker.mjs",
  "storage-worker.mjs",
];

/** One build output, and the name it takes in `public/pgrust/`. */
interface AssetCopy {
  /** Relative to the pgrust checkout. */
  readonly from: string;
  /** Relative to `public/pgrust/`. */
  readonly to: string;
}

/**
 * Copied into `public/pgrust/`.
 *
 * Two wasm modules from one pgrust commit: the single-user `--stdio-wire` build for the two pgrust
 * columns, and the `wasm32-wasip1-threads` build for the two pgrust Threads columns. The threads
 * module is taken straight out of `target/`, because `wasm/build.sh` packs only the default
 * target's module — it is the same source tree, built for a second target. Both share one
 * `vfs.img`/`vfs.json`: the packed image is `initdb` output and carries no pgrust code at all.
 */
const ASSET_FILES: readonly AssetCopy[] = [
  { from: "wasm/assets/postgres.wasm", to: "postgres.wasm" },
  { from: "target/wasm32-wasip1-threads/wasm-release/postgres.wasm", to: "postgres-threads.wasm" },
  { from: "wasm/assets/vfs.img", to: "vfs.img" },
  { from: "wasm/assets/vfs.json", to: "vfs.json" },
];

/** What to run in the pgrust checkout when the assets are missing. */
const ASSET_BUILD_HINT = [
  "PGRUST_WASM_PROFILE=wasm-release wasm/wasm-build.sh   # postgres.wasm (wasm32-wasip1)",
  "wasm/build.sh                                         # packs vfs.img + vfs.json beside it",
  "PGRUST_WASM_TARGET=wasm32-wasip1-threads PGRUST_WASM_PROFILE=wasm-release wasm/wasm-build.sh",
  "                                                      # postgres-threads.wasm, into target/",
];

/** The pgxsinkit checkout the pre-release store bundle is copied out of. */
const DEFAULT_PGXSINKIT_DIR = "../pgxsinkit";

/** The bundle inside that checkout, and where the vendored `broker-fs.js` expects to find it. */
const STORE_BUNDLE_SOURCE = "packages/pglite-opfs-repacked/dist/browser-bundle.js";
const STORE_BUNDLE_TARGET = "host/vendor/pglite-opfs-repacked.js";
const STORE_BUNDLE_MANIFEST = "packages/pglite-opfs-repacked/package.json";

/**
 * The same path from the repo root, which is how `SOURCE.md` names it.
 *
 * Written out rather than derived on the release path so both paths record the identical string: the
 * point of that block is that a cloner's copy and a maintainer's can be compared line for line.
 */
const STORE_BUNDLE_TARGET_RECORD = `public/pgrust/${STORE_BUNDLE_TARGET}`;

/** How to produce that bundle in a pgxsinkit checkout. */
const STORE_BUNDLE_BUILD_HINT = "bun run build:public-packages";

const VENDOR_DIR = resolve(REPO_ROOT, "src/vendor/pgrust");
const PUBLIC_DIR = resolve(REPO_ROOT, "public/pgrust");
const HOST_DIR = join(PUBLIC_DIR, "host");
const ALTERNATES_DIR = join(PUBLIC_DIR, ALTERNATE_MODULES_DIRECTORY);
const SOURCE_MD = join(VENDOR_DIR, "SOURCE.md");

/** Downloads land here first and are only promoted to `public/pgrust/` once they verify. */
const STAGING_ROOT = resolve(REPO_ROOT, "tmp/pgrust-release");

interface Options {
  readonly vendorOnly: boolean;
  readonly sourceDir: string;
  /** A tag, `latest`, or null for the checkout path. */
  readonly release: string | null;
  /** Releases whose threads module is installed as an alternate under `public/pgrust/alt/`. */
  readonly altReleases: readonly string[];
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
  let release: string | null = null;
  const altReleases: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--vendor-only") {
      vendorOnly = true;
      continue;
    }
    if (argument === "--release") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`--release needs a tag or "${LATEST_RELEASE}"`);
      }
      release = value;
      index += 1;
      continue;
    }
    if (argument === "--alt-release") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail("--alt-release needs a pgrust-assets/<short commit> tag");
      }
      try {
        alternateModuleId(value);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      if (!altReleases.includes(value.trim())) {
        altReleases.push(value.trim());
      }
      index += 1;
      continue;
    }
    fail(`unknown argument "${argument}" (expected --vendor-only, --release <tag> or --alt-release <tag>)`);
  }
  if (vendorOnly && release !== null) {
    fail("--vendor-only and --release are opposite halves of the sync; pass one or the other");
  }
  if (vendorOnly && altReleases.length > 0) {
    fail("--vendor-only never touches public/pgrust/, which is where --alt-release installs; pass one or the other");
  }
  const configured = process.env["PGRUST_DIR"];
  const raw = configured === undefined || configured === "" ? DEFAULT_PGRUST_DIR : configured;
  return { vendorOnly, sourceDir: isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw), release, altReleases };
}

function environment(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value.trim();
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
    fail(`pgrust checkout not found at ${sourceDir} (set PGRUST_DIR to override, or use --release)`);
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

function readSourceMarkdown(): string | null {
  return existsSync(SOURCE_MD) ? readFileSync(SOURCE_MD, "utf8") : null;
}

/** The vendored-JS half of `SOURCE.md`; the assets half is a marked block appended to it. */
function vendorMarkdown(checkout: Checkout, files: readonly string[]): string {
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

/** Copy build outputs out of the checkout under the names `public/pgrust/` gives them. */
function copyAssets(checkout: Checkout, assets: readonly AssetCopy[], destination: string): readonly string[] {
  const missing = assets.filter((asset) => !existsSync(join(checkout.dir, asset.from))).map((asset) => asset.from);
  if (missing.length > 0) {
    return missing;
  }
  mkdirSync(destination, { recursive: true });
  for (const asset of assets) {
    const to = join(destination, asset.to);
    copyFileSync(join(checkout.dir, asset.from), to);
    console.log(`  ${asset.from} -> ${relativeToRepo(to)} (${statSync(to).size} bytes)`);
  }
  return [];
}

function relativeToRepo(path: string): string {
  return path.startsWith(`${REPO_ROOT}/`) ? path.slice(REPO_ROOT.length + 1) : path;
}

/** Rewrite `SOURCE.md` with both marked blocks in one fixed order, whatever order they were in. */
function writeSourceMarkdown(body: string, storeBundle: string | null, assets: string | null): void {
  writeFileSync(SOURCE_MD, replaceAssetsSection(replaceStoreBundleSection(body, storeBundle), assets), "utf8");
}

function syncVendor(checkout: Checkout): void {
  console.log(`Vendoring pgrust host JS from ${checkout.dir} @ ${version(checkout)}`);
  const missing = copyInto(checkout, VENDORED_FILES, VENDOR_DIR);
  if (missing.length > 0) {
    fail(`missing source file(s) in ${checkout.dir}: ${missing.join(", ")}`);
  }
  // Both marked blocks describe public/pgrust/, which this step did not touch.
  const previous = readSourceMarkdown() ?? "";
  writeFileSync(join(VENDOR_DIR, "VERSION"), `${version(checkout)}\n`, "utf8");
  writeSourceMarkdown(
    vendorMarkdown(checkout, VENDORED_FILES),
    extractStoreBundleSection(previous),
    extractAssetsSection(previous),
  );
  console.log(`  VERSION -> ${version(checkout)}`);
}

/**
 * Lay the runtime copy of the vendored threads host out under `public/pgrust/host/`.
 *
 * Copied from `src/vendor/pgrust/` rather than from a checkout, so this is the same byte-verbatim
 * JS that is committed here, and so the `--release` path (which has no checkout at all) can do it
 * too. Nothing is rewritten: the files keep their own relative imports, which is the whole reason
 * they are served instead of bundled.
 */
function syncHostRuntime(): void {
  console.log(`Laying out the vendored threads host in ${relativeToRepo(HOST_DIR)}/`);
  const missing = HOST_RUNTIME_FILES.filter((name) => !existsSync(join(VENDOR_DIR, name)));
  if (missing.length > 0) {
    fail(
      `src/vendor/pgrust/ is missing ${missing.join(", ")} — re-run \`bun run sync:pgrust\` against a ` +
        "pgrust checkout that carries the wasm32-wasip1-threads host",
    );
  }
  mkdirSync(HOST_DIR, { recursive: true });
  for (const name of HOST_RUNTIME_FILES) {
    const to = join(HOST_DIR, name);
    copyFileSync(join(VENDOR_DIR, name), to);
    console.log(`  src/vendor/pgrust/${name} -> ${relativeToRepo(to)} (${statSync(to).size} bytes)`);
  }
}

/**
 * Copy the **pre-release** `@pgxsinkit/pglite-opfs-repacked` bundle the broker columns load out of a
 * pgxsinkit checkout.
 *
 * Not vendored and not a dependency: the sync broker and the WASI adapter those columns need exist
 * in no published version of the package, so the bytes come out of a checkout — or, since it became
 * a release asset, out of the release itself, which is the path a cloner takes. This is the other
 * one: the path that produces the bundle a release is built from. Missing is not fatal: every other
 * column, the two published-package OPFS columns included, runs without it, and each broker column
 * reports the missing bundle in its own header.
 */
function syncStoreBundle(): boolean {
  const configured = process.env["PGXSINKIT_DIR"];
  const raw = configured === undefined || configured === "" ? DEFAULT_PGXSINKIT_DIR : configured;
  const checkoutDir = isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
  const source = join(checkoutDir, STORE_BUNDLE_SOURCE);
  const target = join(PUBLIC_DIR, STORE_BUNDLE_TARGET);
  const previous = readSourceMarkdown() ?? "";

  if (!existsSync(source)) {
    console.warn("");
    console.warn(`sync:pgrust: the pre-release store bundle is not at ${source}.`);
    console.warn("  The four `pgrust Threads` and `pgrust Postmaster` broker columns will report it");
    console.warn("  missing; every other column is unaffected. Either sync a release that carries it:");
    console.warn("    bun run sync:pgrust --release latest");
    console.warn("  or build it in a pgxsinkit checkout:");
    console.warn(`    ${STORE_BUNDLE_BUILD_HINT}`);
    console.warn("  and point PGXSINKIT_DIR at that checkout if it is not a sibling of this repo.");
    return false;
  }

  const sha = git(checkoutDir, ["rev-parse", "HEAD"]);
  const porcelain = git(checkoutDir, ["status", "--porcelain"]);
  const branch = git(checkoutDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  const bytes = statSync(target).size;
  console.log(`Copying the pre-release store bundle from ${checkoutDir}`);
  console.log(`  ${STORE_BUNDLE_SOURCE} -> ${relativeToRepo(target)} (${bytes} bytes)`);

  writeSourceMarkdown(
    previous,
    storeBundleSection({
      commit: sha ?? "unknown",
      // A detached HEAD says `HEAD`, which names no branch anyone can fetch; the default branch is
      // the honest answer there, and the commit — which is the record that matters — is exact.
      branch: branch === null || branch === "HEAD" ? STORE_DEFAULT_BRANCH : branch,
      repository: STORE_REPOSITORY,
      dirty: porcelain === null || porcelain !== "",
      packageVersion: readManifestVersion(join(checkoutDir, STORE_BUNDLE_MANIFEST)),
      target: relativeToRepo(target),
      bytes,
    }),
    extractAssetsSection(previous),
  );
  return true;
}

/** The `version` field of a package manifest, or `unknown` when it cannot be read. */
function readManifestVersion(manifestPath: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const value = (parsed as { version: unknown }).version;
      return typeof value === "string" ? value : "unknown";
    }
  } catch {
    // A manifest we cannot read is a footnote in a provenance record, not a reason to stop.
  }
  return "unknown";
}

/** Returns false when an asset is missing; the vendor step has already completed by then. */
function syncAssets(checkout: Checkout): boolean {
  console.log(`Copying pgrust build assets into ${relativeToRepo(PUBLIC_DIR)}/`);
  const missing = copyAssets(checkout, ASSET_FILES, PUBLIC_DIR);
  if (missing.length === 0) {
    const section = checkoutAssetsSection(checkout.dir, version(checkout), new Date().toISOString());
    const previous = readSourceMarkdown() ?? "";
    writeSourceMarkdown(previous, extractStoreBundleSection(previous), section);
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
  console.error("Or download a published build instead: bun run sync:pgrust --release latest");
  console.error("The vendored host JS in src/vendor/pgrust/ was synced successfully.");
  console.error("Pass --vendor-only to sync just the host JS and skip the assets.");
  return false;
}

/**
 * Record the release in `SOURCE.md` without disturbing what it says about the vendored host JS.
 *
 * The store block is rewritten from the release's own `store` record when the release carried the
 * bundle, and removed when it did not: a block left behind would claim a commit whose bytes are no
 * longer on disk. When it is removed the caller falls back to a pgxsinkit checkout, which writes the
 * block again — with the same text, for the same commit.
 */
function recordRelease(
  manifest: AssetManifest,
  releaseUrl: string,
  fetchedFrom: string | null,
  storeBytes: number | null,
): void {
  const existing = readSourceMarkdown();
  const section = releaseAssetsSection(manifest, releaseUrl, new Date().toISOString(), fetchedFrom);
  const base =
    existing ?? "# Vendored from pgrust\n\nThe host JS has not been vendored from a checkout in this clone.\n";
  const store = manifest.store;
  const storeSection =
    store === undefined || storeBytes === null
      ? null
      : storeBundleSection(storeProvenanceFromManifest(store, STORE_BUNDLE_TARGET_RECORD, storeBytes));
  writeSourceMarkdown(base, storeSection, section);
  writeFileSync(join(VENDOR_DIR, "VERSION"), `${manifest.pgrust.shortCommit}\n`, "utf8");
  console.log(`  VERSION -> ${manifest.pgrust.shortCommit}`);
  console.log(`  ${relativeToRepo(SOURCE_MD)} -> assets from ${manifest.tag}`);
  if (storeSection !== null) {
    console.log(`  ${relativeToRepo(SOURCE_MD)} -> store bundle from ${store?.commit.slice(0, 10) ?? ""}`);
  }

  const warning = vendorMismatchWarning(readVendorCommit(existing ?? ""), manifest);
  if (warning.length === 0) {
    return;
  }
  console.warn("");
  console.warn("!".repeat(96));
  console.warn(`sync:pgrust: ${warning[0] ?? ""}`);
  for (const line of warning.slice(1)) {
    console.warn(`  ${line}`);
  }
  console.warn("!".repeat(96));
}

/**
 * Download one release into `public/pgrust/`.
 *
 * Returns whether the release carried the store bundle: when it did not, the caller falls back to a
 * pgxsinkit checkout for it, exactly as a sync from a checkout does.
 */
async function syncFromRelease(requested: string): Promise<boolean> {
  const repository = environment("PGLITE_V_PGRUST_RELEASE_REPO") ?? DEFAULT_RELEASE_REPOSITORY;
  const baseOverride = environment("PGLITE_V_PGRUST_RELEASE_BASE_URL");
  if (baseOverride !== null && requested === LATEST_RELEASE) {
    fail(
      "PGLITE_V_PGRUST_RELEASE_BASE_URL points at a directory of assets, which has no release list to " +
        "resolve `latest` from — pass an explicit --release <tag>",
    );
  }
  const tag = await resolveReleaseTag(requested, async () => await fetchReleaseList(repository, console.log));
  const base = baseOverride ?? releaseDownloadBase(repository, tag);
  const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`;
  console.log(`Downloading pgrust assets from ${tag}`);
  console.log(`  ${base}`);

  const bundle = await fetchReleaseBundle({
    base,
    tag,
    publicDir: PUBLIC_DIR,
    stagingDir: join(STAGING_ROOT, bundleDirectoryName(tag)),
    log: console.log,
  });
  for (const warning of bundle.warnings) {
    console.warn(`sync:pgrust: ${warning}`);
  }
  for (const spec of bundle.absent) {
    const note = spec.absentNote ?? [];
    console.log(`  ${spec.name} is not in this release — ${note[0] ?? "it is optional"}`);
    for (const line of note.slice(1)) {
      console.log(`    ${line}`);
    }
  }

  console.log("");
  for (const asset of bundle.installed) {
    console.log(`  ${relativeToRepo(join(PUBLIC_DIR, asset.target))} (${asset.bytes} bytes)`);
  }

  const store = bundle.installed.find((asset) => asset.target === STORE_BUNDLE_TARGET);
  console.log("");
  recordRelease(bundle.manifest, releaseUrl, baseOverride, store?.bytes ?? null);
  console.log("");
  console.log(
    `Done: pgrust ${bundle.manifest.pgrust.shortCommit} assets from ${tag} in ${relativeToRepo(PUBLIC_DIR)}/.`,
  );
  return store !== undefined;
}

/**
 * Install each `--alt-release` threads module under `public/pgrust/alt/<id>/`, and leave that
 * directory holding exactly those.
 *
 * An alternate from an earlier sync that this one did not ask for is removed rather than left to be
 * served: the page offers whatever the build carries, and a build must carry what its command line
 * says. Each alternate is fetched from the same repo as `--release` and verified the same way.
 */
async function syncAlternates(tags: readonly string[]): Promise<void> {
  const ids = tags.map((tag) => alternateModuleId(tag));
  if (existsSync(ALTERNATES_DIR)) {
    for (const entry of readdirSync(ALTERNATES_DIR)) {
      if (!ids.includes(entry)) {
        rmSync(join(ALTERNATES_DIR, entry), { recursive: true, force: true });
        console.log(`Removed the alternate ${relativeToRepo(join(ALTERNATES_DIR, entry))}/ — not asked for`);
      }
    }
    if (ids.length === 0) {
      rmSync(ALTERNATES_DIR, { recursive: true, force: true });
    }
  }
  if (tags.length === 0) {
    return;
  }

  const repository = environment("PGLITE_V_PGRUST_RELEASE_REPO") ?? DEFAULT_RELEASE_REPOSITORY;
  for (const tag of tags) {
    const id = alternateModuleId(tag);
    const base = releaseDownloadBase(repository, tag);
    const targetDir = join(ALTERNATES_DIR, id);
    console.log(`Downloading the alternate threads module from ${tag}`);
    console.log(`  ${base}`);
    const alternate = await fetchAlternateThreadsModule({
      base,
      tag,
      targetDir,
      stagingDir: join(STAGING_ROOT, `alt-${bundleDirectoryName(tag)}`),
      log: console.log,
    });
    for (const warning of alternate.warnings) {
      console.warn(`sync:pgrust: ${warning}`);
    }
    console.log(
      `  ${relativeToRepo(join(targetDir, THREADS_MODULE_FILE))} (${alternate.bytes} bytes, sha256 ${alternate.sha256})`,
    );
    console.log(
      `  pgrust ${alternate.manifest.pgrust.shortCommit}, loaded by the threads and postmaster columns on ?pgrustModule=${id}`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  if (options.release !== null) {
    const storeFromRelease = await syncFromRelease(options.release);
    // The release carries binaries only, so the runtime copy of the threads host comes from the
    // committed vendored JS in this clone — the same bytes either way.
    console.log("");
    syncHostRuntime();
    // A release that carried the store bundle has already installed it, and a pgxsinkit checkout
    // sitting beside this clone must not silently replace a verified download with whatever that
    // checkout happens to have built.
    if (!storeFromRelease) {
      console.log("");
      syncStoreBundle();
    }
    console.log("");
    await syncAlternates(options.altReleases);
    return;
  }

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
  syncHostRuntime();
  console.log("");
  syncStoreBundle();
  console.log("");
  await syncAlternates(options.altReleases);
  console.log("");
  console.log(`Done: pgrust ${version(checkout)} vendored and assets copied.`);
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
