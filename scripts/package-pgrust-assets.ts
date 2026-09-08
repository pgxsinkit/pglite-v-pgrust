/**
 * Package `public/pgrust/` into a publishable set of GitHub Release assets.
 *
 * The pgrust wasm build is ~87 MB of gitignored build output, which today only exists on a machine
 * that has a pgrust checkout and a Rust nightly. Publishing it as release assets of this repo is
 * what lets a clean clone run the `pgrust Memory` column with `bun run sync:pgrust --release latest`.
 *
 * pgrust is AGPL-3.0, so every release has to name the complete corresponding source. The parts of
 * that statement this repo can derive — the commit, from `src/vendor/pgrust/VERSION` and
 * `SOURCE.md` — are derived; the parts it cannot — branch, upstream base, profile, target,
 * toolchain, `initdb` version — are flags whose defaults describe the assets currently in tree, and
 * are recorded verbatim in `manifest.json` and `NOTES.md`.
 *
 * The bundle is written to `tmp/`, and the `gh release create` command is **printed, not run**:
 * publishing is a human act, and an AGPL source statement deserves to be read before it ships.
 *
 * Usage:
 *   bun run pgrust:bundle
 *   bun run pgrust:bundle --branch other/branch --toolchain nightly-2026-07-17
 *   bun run pgrust:bundle --out tmp/elsewhere --help
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatSha256Sums, sha256Hex } from "./pgrust-assets/checksums";
import type { AssetManifest, ManifestFileRecord } from "./pgrust-assets/manifest";
import type { StoreSourceRecord } from "./pgrust-assets/manifest";
import {
  bundleDirectoryName,
  buildManifest,
  CHECKSUMS_FILE_NAME,
  MANIFEST_FILE_NAME,
  ManifestError,
  PGRUST_DEFAULT_BRANCH,
  PGRUST_REPOSITORY,
  PGRUST_UPSTREAM_REPOSITORY,
  parseVersionFile,
  releaseTagForCommit,
  STORE_BUILD_COMMAND,
  STORE_BUILD_OUTPUT,
  STORE_DEFAULT_BRANCH,
  STORE_LICENSE,
  STORE_PACKAGE_NAME,
  STORE_REPOSITORY,
} from "./pgrust-assets/manifest";
import { ghReleaseCommand, releaseNotesMarkdown, releaseTitle } from "./pgrust-assets/notes";
import type { ReleaseAssetSpec } from "./pgrust-assets/release";
import { DEFAULT_RELEASE_REPOSITORY, RELEASE_ASSETS } from "./pgrust-assets/release";
import { readStoreProvenance, readVendorCommit } from "./pgrust-assets/source-md";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(REPO_ROOT, "public/pgrust");
const VENDOR_DIR = resolve(REPO_ROOT, "src/vendor/pgrust");
const DEFAULT_OUT_ROOT = resolve(REPO_ROOT, "tmp/pgrust-assets");

/** The notes uploaded with `--notes-file`; generated beside the assets, never published on its own. */
const NOTES_FILE_NAME = "NOTES.md";

/** gzip level 9: the bundle is built once and downloaded many times, so spend the CPU here. */
const GZIP_LEVEL = 9;

/**
 * Defaults describing the assets currently in `public/pgrust/`.
 *
 * None of these can be read out of the built files, and guessing them would put a guess into an
 * AGPL source statement. They are flags with the known-good values as defaults, so the common case
 * — bundling what is in tree — is `bun run pgrust:bundle` with nothing after it.
 */
const DEFAULTS = {
  branch: PGRUST_DEFAULT_BRANCH,
  upstreamCommit: "438c8c420b96b23ca61927ba57e608839f86e935",
  upstreamRepository: PGRUST_UPSTREAM_REPOSITORY,
  repository: PGRUST_REPOSITORY,
  profile: "wasm-release",
  target: "wasm32-wasip1",
  threadsTarget: "wasm32-wasip1-threads",
  toolchain: "nightly-2026-07-17",
  initdb: "PostgreSQL 18",
  storeBranch: STORE_DEFAULT_BRANCH,
  storeRepository: STORE_REPOSITORY,
} as const;

/** What to run in the pgrust checkout when `public/pgrust/` is empty. */
const ASSET_BUILD_HINT = [
  "PGRUST_WASM_PROFILE=wasm-release wasm/wasm-build.sh   # compiles postgres.wasm",
  "wasm/build.sh                                         # packs vfs.img + vfs.json beside it",
  "PGRUST_WASM_TARGET=wasm32-wasip1-threads \\",
  "  PGRUST_WASM_PROFILE=wasm-release wasm/wasm-build.sh # compiles postgres-threads.wasm",
  "bun run sync:pgrust                                   # copies them into public/pgrust/",
];

interface Options {
  readonly branch: string;
  readonly commit: string | null;
  readonly upstreamCommit: string;
  readonly upstreamRepository: string;
  readonly repository: string;
  readonly releaseRepository: string;
  readonly profile: string;
  readonly target: string;
  readonly threadsTarget: string;
  readonly toolchain: string;
  readonly initdb: string;
  readonly builtAt: string | null;
  readonly storeBranch: string;
  readonly storeCommit: string | null;
  readonly storeVersion: string | null;
  readonly storeRepository: string;
  readonly tag: string | null;
  readonly outRoot: string;
}

const USAGE = [
  "Usage: bun run pgrust:bundle [options]",
  "",
  "Packages public/pgrust/ into tmp/pgrust-assets/<tag>/ and prints the gh release create command.",
  "",
  `  --branch <name>            pgrust branch the assets were built from (default ${DEFAULTS.branch})`,
  "  --commit <sha>             full pgrust commit (default: from src/vendor/pgrust/SOURCE.md)",
  `  --upstream-commit <sha>    upstream base commit (default ${DEFAULTS.upstreamCommit})`,
  `  --upstream-repo <url>      upstream repository (default ${DEFAULTS.upstreamRepository})`,
  `  --repo <url>               pgrust repository (default ${DEFAULTS.repository})`,
  `  --release-repo <owner/name>  repo the release is published to (default ${DEFAULT_RELEASE_REPOSITORY})`,
  `  --profile <name>           cargo profile (default ${DEFAULTS.profile})`,
  `  --target <triple>          rust target for postgres.wasm (default ${DEFAULTS.target})`,
  `  --threads-target <triple>  rust target for postgres-threads.wasm (default ${DEFAULTS.threadsTarget})`,
  `  --toolchain <name>         rust toolchain (default ${DEFAULTS.toolchain})`,
  `  --initdb <version>         the initdb that minted vfs.img (default ${DEFAULTS.initdb})`,
  "  --built-at <iso>           when vfs.img was built (default: its mtime)",
  `  --store-branch <name>      pgxsinkit branch of the store bundle (default ${DEFAULTS.storeBranch})`,
  "  --store-commit <sha>       full pgxsinkit commit (default: from src/vendor/pgrust/SOURCE.md)",
  "  --store-version <version>  the store package's manifest version (default: from SOURCE.md)",
  `  --store-repo <url>         pgxsinkit repository (default ${DEFAULTS.storeRepository})`,
  "  --tag <tag>                release tag (default pgrust-assets/<first 8 of the commit>)",
  "  --out <dir>                where to write the bundle (default tmp/pgrust-assets)",
  "  --help                     this text",
];

function fail(message: string): never {
  console.error(`pgrust:bundle: ${message}`);
  process.exit(1);
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set([
    "--branch",
    "--commit",
    "--upstream-commit",
    "--upstream-repo",
    "--repo",
    "--release-repo",
    "--profile",
    "--target",
    "--threads-target",
    "--toolchain",
    "--initdb",
    "--built-at",
    "--store-branch",
    "--store-commit",
    "--store-version",
    "--store-repo",
    "--tag",
    "--out",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--help" || argument === "-h") {
      console.log(USAGE.join("\n"));
      process.exit(0);
    }
    if (!flags.has(argument)) {
      fail(`unknown argument "${argument}" (try --help)`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${argument} needs a value`);
    }
    values.set(argument, value);
    index += 1;
  }
  const outRaw = values.get("--out");
  return {
    branch: values.get("--branch") ?? DEFAULTS.branch,
    commit: values.get("--commit") ?? null,
    upstreamCommit: values.get("--upstream-commit") ?? DEFAULTS.upstreamCommit,
    upstreamRepository: values.get("--upstream-repo") ?? DEFAULTS.upstreamRepository,
    repository: values.get("--repo") ?? DEFAULTS.repository,
    releaseRepository: values.get("--release-repo") ?? DEFAULT_RELEASE_REPOSITORY,
    profile: values.get("--profile") ?? DEFAULTS.profile,
    target: values.get("--target") ?? DEFAULTS.target,
    threadsTarget: values.get("--threads-target") ?? DEFAULTS.threadsTarget,
    toolchain: values.get("--toolchain") ?? DEFAULTS.toolchain,
    initdb: values.get("--initdb") ?? DEFAULTS.initdb,
    builtAt: values.get("--built-at") ?? null,
    storeBranch: values.get("--store-branch") ?? DEFAULTS.storeBranch,
    storeCommit: values.get("--store-commit") ?? null,
    storeVersion: values.get("--store-version") ?? null,
    storeRepository: values.get("--store-repo") ?? DEFAULTS.storeRepository,
    tag: values.get("--tag") ?? null,
    outRoot: outRaw === undefined ? DEFAULT_OUT_ROOT : resolve(REPO_ROOT, outRaw),
  };
}

function relativeToRepo(path: string): string {
  return path.startsWith(`${REPO_ROOT}/`) ? path.slice(REPO_ROOT.length + 1) : path;
}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fail(`cannot read ${what} at ${relativeToRepo(path)} — run \`bun run sync:pgrust\` first`);
  }
}

/** The full commit these assets were built from: `--commit`, else the vendored provenance record. */
function resolveCommit(options: Options, shortCommit: string): string {
  if (options.commit !== null) {
    return options.commit;
  }
  const sourceMd = readText(join(VENDOR_DIR, "SOURCE.md"), "src/vendor/pgrust/SOURCE.md");
  const commit = readVendorCommit(sourceMd);
  if (commit === null) {
    fail("src/vendor/pgrust/SOURCE.md records no commit; pass --commit <sha>");
  }
  if (!commit.startsWith(shortCommit)) {
    fail(
      `src/vendor/pgrust/VERSION says ${shortCommit} but SOURCE.md says ${commit}; ` +
        "re-run `bun run sync:pgrust` or pass --commit <sha>",
    );
  }
  return commit;
}

/**
 * The store bundle's source statement: `--store-*` flags over what `SOURCE.md` recorded.
 *
 * The sync wrote that block when it installed the bundle, so it already names the commit these bytes
 * came from — reading it back is the same move `resolveCommit` makes for pgrust, and for the same
 * reason: a published provenance that was typed in by hand is a provenance nobody checked. A bundle
 * built from a dirty pgxsinkit tree is refused outright, exactly as a dirty pgrust one is.
 */
function resolveStore(options: Options): StoreSourceRecord {
  const recorded = readStoreProvenance(readText(join(VENDOR_DIR, "SOURCE.md"), "src/vendor/pgrust/SOURCE.md"));
  const commit = options.storeCommit ?? recorded?.commit ?? null;
  if (commit === null) {
    fail(
      "src/vendor/pgrust/SOURCE.md records no store-bundle commit, so the bundle in public/pgrust/ " +
        "cannot be attributed; re-run `bun run sync:pgrust` or pass --store-commit <sha>",
    );
  }
  if (options.storeCommit === null && recorded?.dirty === true) {
    fail(
      `the store bundle was copied from a dirty pgxsinkit working tree at ${commit.slice(0, 10)}, which ` +
        "no one can check out. Commit and push that branch, re-run `bun run sync:pgrust`, and bundle again.",
    );
  }
  return {
    package: STORE_PACKAGE_NAME,
    version: options.storeVersion ?? recorded?.packageVersion ?? "unknown",
    repository: options.storeRepository,
    commit,
    branch: options.storeBranch,
    license: STORE_LICENSE,
    build: { command: STORE_BUILD_COMMAND, output: STORE_BUILD_OUTPUT },
  };
}

/** The bytes of one asset, or a clear failure naming what still has to be built. */
function readAsset(name: string, optional: boolean): Uint8Array<ArrayBuffer> | null {
  const path = join(PUBLIC_DIR, name);
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    if (optional) {
      // The threads module and the store bundle are the assets a release may legitimately not
      // carry, so a bundle without one is publishable — it simply describes less.
      console.log(`  ${name} is not in public/pgrust/ — packaging without it`);
      return null;
    }
    console.error(`pgrust:bundle: ${relativeToRepo(path)} is missing.`);
    console.error("");
    console.error("There is nothing to package until the pgrust wasm build is in public/pgrust/:");
    for (const line of ASSET_BUILD_HINT) {
      console.error(`  ${line}`);
    }
    return process.exit(1);
  }
}

/** Compress and write one asset, returning what the manifest should say about it. */
function packageAsset(spec: ReleaseAssetSpec, bundleDir: string): ManifestFileRecord | null {
  const raw = readAsset(spec.target, spec.optional === true);
  if (raw === null) {
    return null;
  }
  const rawSha = sha256Hex(raw);
  if (!spec.gzipped) {
    writeFileSync(join(bundleDir, spec.name), raw);
    console.log(`  ${spec.name}  ${raw.length} bytes (uploaded as-is)`);
    return { name: spec.name, bytes: raw.length, sha256: rawSha };
  }
  const started = performance.now();
  const packed = Bun.gzipSync(raw, { level: GZIP_LEVEL });
  writeFileSync(join(bundleDir, spec.name), packed);
  const ratio = ((packed.length / raw.length) * 100).toFixed(1);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`  ${spec.name}  ${raw.length} -> ${packed.length} bytes (${ratio}%, gzip -9, ${seconds}s)`);
  return {
    name: spec.name,
    bytes: packed.length,
    sha256: sha256Hex(packed),
    unpacked: { name: spec.target, bytes: raw.length, sha256: rawSha },
  };
}

/** When `vfs.img` was built, which is when `initdb` minted it. */
function defaultBuiltAt(): string {
  try {
    return statSync(join(PUBLIC_DIR, "vfs.img")).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function writeBundle(manifest: AssetManifest, bundleDir: string): void {
  const checksums = formatSha256Sums(manifest.files.map((file) => ({ name: file.name, sha256: file.sha256 })));
  writeFileSync(join(bundleDir, CHECKSUMS_FILE_NAME), checksums, "utf8");
  writeFileSync(join(bundleDir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(bundleDir, NOTES_FILE_NAME), releaseNotesMarkdown(manifest), "utf8");
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const shortCommit = parseVersionFile(readText(join(VENDOR_DIR, "VERSION"), "src/vendor/pgrust/VERSION"));
  const commit = resolveCommit(options, shortCommit);
  const tag = options.tag ?? releaseTagForCommit(commit);
  const bundleDir = join(options.outRoot, bundleDirectoryName(tag));

  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });

  console.log(`Packaging public/pgrust/ for release ${tag}`);
  console.log(`  pgrust ${commit} on ${options.branch}`);
  console.log("");

  const files = RELEASE_ASSETS.map((spec) => packageAsset(spec, bundleDir)).filter(
    (file): file is ManifestFileRecord => file !== null,
  );
  // Claimed only when the bundle is really in the release, like the threads target: the record has
  // to describe what was uploaded, not what the flags default to.
  const store = files.some((file) => file.name.startsWith("pglite-opfs-repacked.")) ? resolveStore(options) : null;
  const manifest = buildManifest({
    tag,
    commit,
    shortCommit,
    branch: options.branch,
    repository: options.repository,
    upstreamRepository: options.upstreamRepository,
    upstreamCommit: options.upstreamCommit,
    profile: options.profile,
    target: options.target,
    // Only claimed when the threads module is actually in the bundle: the source statement has to
    // describe what was uploaded, not what the flags default to.
    ...(files.some((file) => file.name.startsWith("postgres-threads."))
      ? { threadsTarget: options.threadsTarget }
      : {}),
    toolchain: options.toolchain,
    initdb: options.initdb,
    builtAt: options.builtAt ?? defaultBuiltAt(),
    ...(store === null ? {} : { store }),
    files,
  });
  writeBundle(manifest, bundleDir);
  if (store !== null) {
    console.log("");
    console.log(`  store bundle: ${store.package} @ ${store.commit.slice(0, 10)} (${store.branch}, ${store.license})`);
  }

  const uploaded = manifest.files.reduce((total, file) => total + file.bytes, 0);
  console.log(`  ${CHECKSUMS_FILE_NAME}, ${MANIFEST_FILE_NAME}, ${NOTES_FILE_NAME}`);
  console.log("");
  console.log(`Bundle: ${relativeToRepo(bundleDir)}/  (${(uploaded / 1024 / 1024).toFixed(1)} MiB of assets)`);
  console.log(`Title:  ${releaseTitle(manifest)}`);
  console.log("");
  console.log("Review NOTES.md — it carries the AGPL source statement — then publish with:");
  console.log("");
  console.log(
    ghReleaseCommand(
      manifest,
      options.releaseRepository,
      relativeToRepo(bundleDir),
      `${relativeToRepo(bundleDir)}/${NOTES_FILE_NAME}`,
    ),
  );
  console.log("");
  console.log(`Then: bun run sync:pgrust --release ${tag}`);
}

try {
  main();
} catch (error) {
  if (error instanceof ManifestError) {
    fail(error.message);
  }
  throw error;
}
