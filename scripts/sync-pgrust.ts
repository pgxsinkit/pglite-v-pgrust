/**
 * Populate `src/vendor/pgrust/` and `public/pgrust/`.
 *
 * Two independent halves, from two independent sources:
 *
 * 1. **Vendor** — the browser host JS (`pgrust-wasi.js`, `wiresession.js`, `wire.js`) plus pgrust's
 *    `LICENSE` and `NOTICE`, copied byte-verbatim from a **pgrust checkout** into
 *    `src/vendor/pgrust/` and committed. The synced commit is written to `src/vendor/pgrust/VERSION`,
 *    which `vite.config.ts` stamps into the environment header, and provenance to `SOURCE.md`.
 * 2. **Assets** — the ~87 MB build outputs (`postgres.wasm`, `vfs.img`, `vfs.json`) written to
 *    `public/pgrust/`, which is gitignored. They come either from a **GitHub Release** of this repo
 *    (`--release`, the normal path: no pgrust checkout and no Rust toolchain needed) or from a local
 *    pgrust checkout (the default, for a build you made yourself).
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
  readVendorCommit,
  releaseAssetsSection,
  replaceAssetsSection,
  vendorMismatchWarning,
} from "./pgrust-assets/source-md";

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

function relativeToRepo(path: string): string {
  return path.startsWith(`${REPO_ROOT}/`) ? path.slice(REPO_ROOT.length + 1) : path;
}

function syncVendor(checkout: Checkout): void {
  console.log(`Vendoring pgrust host JS from ${checkout.dir} @ ${version(checkout)}`);
  const missing = copyInto(checkout, VENDORED_FILES, VENDOR_DIR);
  if (missing.length > 0) {
    fail(`missing source file(s) in ${checkout.dir}: ${missing.join(", ")}`);
  }
  // The assets half of SOURCE.md describes public/pgrust/, which this step did not touch.
  const previousAssets = extractAssetsSection(readSourceMarkdown() ?? "");
  writeFileSync(join(VENDOR_DIR, "VERSION"), `${version(checkout)}\n`, "utf8");
  writeFileSync(SOURCE_MD, replaceAssetsSection(vendorMarkdown(checkout, VENDORED_FILES), previousAssets), "utf8");
  console.log(`  VERSION -> ${version(checkout)}`);
}

/** Returns false when an asset is missing; the vendor step has already completed by then. */
function syncAssets(checkout: Checkout): boolean {
  console.log(`Copying pgrust build assets into ${relativeToRepo(PUBLIC_DIR)}/`);
  const missing = copyInto(checkout, ASSET_FILES, PUBLIC_DIR);
  if (missing.length === 0) {
    const section = checkoutAssetsSection(checkout.dir, version(checkout), new Date().toISOString());
    writeFileSync(SOURCE_MD, replaceAssetsSection(readSourceMarkdown() ?? "", section), "utf8");
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

/** The manifest entry for one expected asset. */
function manifestFileFor(manifest: AssetManifest, spec: ReleaseAssetSpec): ManifestFileRecord {
  const file = manifest.files.find((candidate) => candidate.name === spec.name);
  if (file === undefined) {
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
  writeFileSync(SOURCE_MD, replaceAssetsSection(base, section), "utf8");
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
  console.log(`Done: pgrust ${version(checkout)} vendored and assets copied.`);
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
