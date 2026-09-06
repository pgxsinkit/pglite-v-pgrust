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
 *    column loads, copied out of a **pgxsinkit checkout**. No published version of that package
 *    carries the sync broker, so this is the one thing here that no npm release corresponds to; it
 *    is recorded in `SOURCE.md` with its own commit and the column's own label says so.
 *
 * `--release` deliberately never touches the vendored host JS: releases carry binaries, not source,
 * and the JS is committed here. When the two end up on different pgrust commits that is reported
 * loudly rather than silently benchmarked.
 *
 * Usage:
 *   bun run sync:pgrust --release latest       # newest published assets, no checkout needed
 *   bun run sync:pgrust --release pgrust-assets/dab0f929
 *   bun run sync:pgrust                        # vendor + assets from a pgrust checkout
 *   bun run sync:pgrust --vendor-only          # host JS only, never touches public/pgrust/
 *   PGRUST_DIR=/path/to/pgrust bun run sync:pgrust
 *
 * Environment:
 *   PGRUST_DIR                        pgrust checkout (default ../pgrust)
 *   PGXSINKIT_DIR                     pgxsinkit checkout for the store bundle (default ../pgxsinkit)
 *   PGLITE_V_PGRUST_RELEASE_REPO      repo whose releases are read (default pgxsinkit/pglite-v-pgrust)
 *   PGLITE_V_PGRUST_RELEASE_BASE_URL  fetch the assets from this directory URL instead of GitHub
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkChecksumCoverage,
  checkDownloadedFile,
  checkUnpackedFile,
  parseSha256Sums,
  sha256Hex,
} from "./pgrust-assets/checksums";
import type { AssetManifest, ManifestFileRecord } from "./pgrust-assets/manifest";
import {
  bundleDirectoryName,
  CHECKSUMS_FILE_NAME,
  MANIFEST_FILE_NAME,
  parseManifest,
  RELEASE_TAG_PREFIX,
} from "./pgrust-assets/manifest";
import type { ReleaseAssetSpec, ReleaseSummary } from "./pgrust-assets/release";
import {
  DEFAULT_RELEASE_REPOSITORY,
  LATEST_RELEASE,
  parseReleases,
  RELEASE_ASSETS,
  releaseAssetUrl,
  releaseDownloadBase,
  releasesApiUrl,
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
  // The SharedArrayBuffer byte ring stdin and stdout ride on.
  "wasm/sab-pipe.js",
  // The `--fs broker` seam, and the storage coordinator on the other end of it.
  "wasm/broker-fs.js",
  "wasm/storage-worker.js",
  "LICENSE",
  "NOTICE",
];

/**
 * The vendored host JS the threads Engine loads at **runtime**, copied from `src/vendor/pgrust/`
 * into `public/pgrust/host/` and served verbatim.
 *
 * These five (plus `pgrust-wasi.js`, which `threads-host.js` imports) cannot be bundled: the host
 * builds its workers from URLs it computes at run time — `threadWorkerUrl(base)`,
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

/** How to produce that bundle in a pgxsinkit checkout. */
const STORE_BUNDLE_BUILD_HINT = "bun run build:public-packages";

const VENDOR_DIR = resolve(REPO_ROOT, "src/vendor/pgrust");
const PUBLIC_DIR = resolve(REPO_ROOT, "public/pgrust");
const HOST_DIR = join(PUBLIC_DIR, "host");
const SOURCE_MD = join(VENDOR_DIR, "SOURCE.md");

/** Downloads land here first and are only promoted to `public/pgrust/` once they verify. */
const STAGING_ROOT = resolve(REPO_ROOT, "tmp/pgrust-release");

/** How often a download reports progress, as a fraction of the total. */
const PROGRESS_STEP = 0.1;

/** Below this, a download is over before a progress line would be read; only the total is printed. */
const PROGRESS_FLOOR = 4 * 1024 * 1024;

interface Options {
  readonly vendorOnly: boolean;
  readonly sourceDir: string;
  /** A tag, `latest`, or null for the checkout path. */
  readonly release: string | null;
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
    fail(`unknown argument "${argument}" (expected --vendor-only or --release <tag>)`);
  }
  if (vendorOnly && release !== null) {
    fail("--vendor-only and --release are opposite halves of the sync; pass one or the other");
  }
  const configured = process.env["PGRUST_DIR"];
  const raw = configured === undefined || configured === "" ? DEFAULT_PGRUST_DIR : configured;
  return { vendorOnly, sourceDir: isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw), release };
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
 * Copy the **pre-release** `@pgxsinkit/pglite-opfs-repacked` bundle the broker column loads.
 *
 * Not vendored and not a dependency: the sync broker and the WASI adapter those columns need exist
 * in no published version of the package, so the bytes come out of a pgxsinkit checkout and are
 * recorded — commit and all — in `SOURCE.md`. Missing is not fatal: every other column, the two
 * published-package OPFS columns included, runs without it, and each broker column reports the
 * missing bundle in its own header.
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
    console.warn("  The three `pgrust Threads` broker columns will report it missing;");
    console.warn("  every other column is unaffected. Build it in a pgxsinkit checkout:");
    console.warn(`    ${STORE_BUNDLE_BUILD_HINT}`);
    console.warn("  and point PGXSINKIT_DIR at that checkout if it is not a sibling of this repo.");
    return false;
  }

  const sha = git(checkoutDir, ["rev-parse", "HEAD"]);
  const porcelain = git(checkoutDir, ["status", "--porcelain"]);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  const bytes = statSync(target).size;
  console.log(`Copying the pre-release store bundle from ${checkoutDir}`);
  console.log(`  ${STORE_BUNDLE_SOURCE} -> ${relativeToRepo(target)} (${bytes} bytes)`);

  writeSourceMarkdown(
    previous,
    storeBundleSection({
      checkoutDir,
      commit: sha ?? "unknown",
      dirty: porcelain === null || porcelain !== "",
      packageVersion: readManifestVersion(join(checkoutDir, STORE_BUNDLE_MANIFEST)),
      target: relativeToRepo(target),
      bytes,
      syncedAt: new Date().toISOString(),
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

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function fetchOrFail(url: string, what: string, headers?: Readonly<Record<string, string>>): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, headers === undefined ? undefined : { headers });
  } catch (error) {
    return fail(`could not fetch ${what} from ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    return fail(`could not fetch ${what} from ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  return response;
}

/** Stream a URL to `destination`, printing progress; returns the size and digest of what landed. */
async function download(url: string, destination: string, label: string): Promise<{ bytes: number; sha256: string }> {
  const response = await fetchOrFail(url, label);
  const declared = Number(response.headers.get("content-length") ?? "0");
  const body = response.body;
  if (body === null) {
    fail(`${url} returned no body`);
  }
  const hasher = createHash("sha256");
  const writer = Bun.file(destination).writer();
  let written = 0;
  let nextReport = declared > PROGRESS_FLOOR ? declared * PROGRESS_STEP : Number.POSITIVE_INFINITY;
  for await (const chunk of body) {
    const bytes = chunk as Uint8Array;
    hasher.update(bytes);
    // FileSink.write returns a promise only when it has to flush; awaiting it is the backpressure.
    const flushed = writer.write(bytes);
    if (typeof flushed !== "number") {
      await flushed;
    }
    written += bytes.length;
    if (written >= nextReport) {
      console.log(`    ${label}: ${megabytes(written)} / ${megabytes(declared)}`);
      nextReport += declared * PROGRESS_STEP;
    }
  }
  await writer.end();
  console.log(`    ${label}: ${megabytes(written)} downloaded`);
  return { bytes: written, sha256: hasher.digest("hex") };
}

async function fetchText(url: string, what: string): Promise<string> {
  const response = await fetchOrFail(url, what);
  return await response.text();
}

/** The releases of the configured repo, for `--release latest`. */
async function fetchReleases(repository: string): Promise<readonly ReleaseSummary[]> {
  const url = releasesApiUrl(repository);
  console.log(`Resolving the newest ${RELEASE_TAG_PREFIX}* release from ${url}`);
  const response = await fetchOrFail(url, "the release list", {
    accept: "application/vnd.github+json",
    "user-agent": "pglite-v-pgrust sync:pgrust",
  });
  return parseReleases(await response.json());
}

/** Fail with every integrity problem at once: a partial list invites a second wasted download. */
function requireNoProblems(problems: readonly string[], what: string): void {
  if (problems.length === 0) {
    return;
  }
  console.error(`sync:pgrust: ${what}`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  fail("the download does not match what the release says it is — nothing was written to public/pgrust/");
}

/** The manifest entry for one expected asset; null for an optional one this release predates. */
function manifestFileFor(manifest: AssetManifest, spec: ReleaseAssetSpec): ManifestFileRecord | null {
  const file = manifest.files.find((candidate) => candidate.name === spec.name);
  if (file === undefined) {
    if (spec.optional === true) {
      return null;
    }
    return fail(`release ${manifest.tag} has no "${spec.name}" — it was not built by \`bun run pgrust:bundle\``);
  }
  if (spec.gzipped && file.unpacked === undefined) {
    return fail(`release ${manifest.tag} describes "${spec.name}" without the bytes it unpacks to`);
  }
  return file;
}

/**
 * Verify a staged download, unpack it if it is a gzip, and leave it beside its gzip in staging.
 *
 * Nothing reaches `public/pgrust/` until every asset has cleared this, so a release that goes wrong
 * on its second file cannot leave the directory holding one commit's `postgres.wasm` next to
 * another's `vfs.img` — a state that would run, and would measure the wrong thing.
 */
function unpackStaged(file: ManifestFileRecord, spec: ReleaseAssetSpec, stagedPath: string, staging: string): string {
  const staged = new Uint8Array(readFileSync(stagedPath));
  const unpacked = spec.gzipped ? Bun.gunzipSync(staged) : staged;
  requireNoProblems(
    checkUnpackedFile(file, { bytes: unpacked.length, sha256: sha256Hex(unpacked) }),
    `${spec.target} is not the file the manifest describes`,
  );
  const unpackedPath = join(staging, spec.target);
  writeFileSync(unpackedPath, unpacked);
  console.log(`    ${spec.target}: ${megabytes(unpacked.length)} verified`);
  return unpackedPath;
}

/** Record the release in `SOURCE.md` without disturbing what it says about the vendored host JS. */
function recordRelease(manifest: AssetManifest, releaseUrl: string, fetchedFrom: string | null): void {
  const existing = readSourceMarkdown();
  const section = releaseAssetsSection(manifest, releaseUrl, new Date().toISOString(), fetchedFrom);
  const base =
    existing ?? "# Vendored from pgrust\n\nThe host JS has not been vendored from a checkout in this clone.\n";
  writeSourceMarkdown(base, extractStoreBundleSection(base), section);
  writeFileSync(join(VENDOR_DIR, "VERSION"), `${manifest.pgrust.shortCommit}\n`, "utf8");
  console.log(`  VERSION -> ${manifest.pgrust.shortCommit}`);
  console.log(`  ${relativeToRepo(SOURCE_MD)} -> assets from ${manifest.tag}`);

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

async function syncFromRelease(requested: string): Promise<void> {
  const repository = environment("PGLITE_V_PGRUST_RELEASE_REPO") ?? DEFAULT_RELEASE_REPOSITORY;
  const baseOverride = environment("PGLITE_V_PGRUST_RELEASE_BASE_URL");
  if (baseOverride !== null && requested === LATEST_RELEASE) {
    fail(
      "PGLITE_V_PGRUST_RELEASE_BASE_URL points at a directory of assets, which has no release list to " +
        "resolve `latest` from — pass an explicit --release <tag>",
    );
  }
  const tag = await resolveReleaseTag(requested, async () => await fetchReleases(repository));
  const base = baseOverride ?? releaseDownloadBase(repository, tag);
  const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`;
  console.log(`Downloading pgrust assets from ${tag}`);
  console.log(`  ${base}`);

  const manifest = parseManifest(
    JSON.parse(await fetchText(releaseAssetUrl(base, MANIFEST_FILE_NAME), MANIFEST_FILE_NAME)) as unknown,
  );
  const checksums = parseSha256Sums(await fetchText(releaseAssetUrl(base, CHECKSUMS_FILE_NAME), CHECKSUMS_FILE_NAME));
  requireNoProblems(
    checkChecksumCoverage(manifest, checksums),
    `${MANIFEST_FILE_NAME} and ${CHECKSUMS_FILE_NAME} disagree`,
  );
  if (manifest.tag !== tag) {
    console.warn(`sync:pgrust: the manifest names ${manifest.tag}, not ${tag} — using the manifest's provenance`);
  }
  console.log(`  pgrust ${manifest.pgrust.commit} on ${manifest.pgrust.branch}`);

  const staging = join(STAGING_ROOT, bundleDirectoryName(tag));
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const verified: { readonly from: string; readonly to: string }[] = [];
  for (const spec of RELEASE_ASSETS) {
    const file = manifestFileFor(manifest, spec);
    if (file === null) {
      console.log(`  ${spec.name} is not in this release — it predates the wasm32-wasip1-threads build`);
      console.log("    the two pgrust Threads columns will report the missing asset; nothing else changes");
      // An earlier sync's copy would otherwise stay behind and run one commit's threads module
      // beside another commit's single-session one, which is the exact state SOURCE.md exists to
      // rule out.
      rmSync(join(PUBLIC_DIR, spec.target), { force: true });
      continue;
    }
    const stagedPath = join(staging, spec.name);
    console.log(`  ${spec.name} (${megabytes(file.bytes)})`);
    const landed = await download(releaseAssetUrl(base, spec.name), stagedPath, spec.name);
    requireNoProblems(checkDownloadedFile(file, checksums, landed), `${spec.name} failed verification`);
    verified.push({ from: unpackStaged(file, spec, stagedPath, staging), to: join(PUBLIC_DIR, spec.target) });
  }

  console.log("");
  mkdirSync(PUBLIC_DIR, { recursive: true });
  for (const { from, to } of verified) {
    copyFileSync(from, to);
    console.log(`  ${relativeToRepo(to)} (${statSync(to).size} bytes)`);
  }
  rmSync(staging, { recursive: true, force: true });

  console.log("");
  recordRelease(manifest, releaseUrl, baseOverride);
  console.log("");
  console.log(`Done: pgrust ${manifest.pgrust.shortCommit} assets from ${tag} in ${relativeToRepo(PUBLIC_DIR)}/.`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  if (options.release !== null) {
    await syncFromRelease(options.release);
    // The release carries binaries only, so the runtime copy of the threads host comes from the
    // committed vendored JS in this clone — the same bytes either way.
    console.log("");
    syncHostRuntime();
    console.log("");
    syncStoreBundle();
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
  console.log(`Done: pgrust ${version(checkout)} vendored and assets copied.`);
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
