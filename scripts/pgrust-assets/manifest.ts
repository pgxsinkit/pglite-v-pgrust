/**
 * The release manifest that travels with the pgrust wasm assets.
 *
 * pgrust is AGPL-3.0, so a published binary has to name the exact public source it was built from.
 * The manifest is that statement in machine-readable form — commit, branch, upstream base, build
 * recipe and VFS provenance — and it doubles as the integrity record the download side checks the
 * unpacked bytes against, which `SHA256SUMS` alone cannot do (it only covers the files as uploaded,
 * i.e. the gzips).
 *
 * Everything here is pure: building, validating and re-parsing the manifest, with no filesystem and
 * no network, so `scripts/package-pgrust-assets.ts` and `scripts/sync-pgrust.ts` share one
 * definition of what a manifest is and it can be unit-tested outright.
 */

/** A 40-hex-character git commit. */
const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** An abbreviated git commit, as `git rev-parse --short` prints it. */
const SHORT_COMMIT = /^[0-9a-f]{7,40}$/;

/** The tag namespace every asset release lives in; the rest of the tag is the pgrust short commit. */
export const RELEASE_TAG_PREFIX = "pgrust-assets/";

/** How many characters of the commit go into a release tag. */
export const RELEASE_TAG_COMMIT_LENGTH = 8;

/** The file inside a release that carries the record described by this module. */
export const MANIFEST_FILE_NAME = "manifest.json";

/** The `sha256sum`-format checksum file inside a release. */
export const CHECKSUMS_FILE_NAME = "SHA256SUMS";

/** The pgrust fork these assets are built from. Its branch and commit are what AGPL-3.0 requires. */
export const PGRUST_REPOSITORY = "https://github.com/pgxsinkit/pgrust";

/** The upstream pgrust the fork tracks. */
export const PGRUST_UPSTREAM_REPOSITORY = "https://github.com/malisper/pgrust";

/**
 * The fork branch the wasm assets are built from.
 *
 * It cannot be read out of a built `.wasm`, so it is the default of `--branch` rather than a
 * discovery — and it is the branch a drop-in names itself after (`scripts/package-store-engine.ts`)
 * when `SOURCE.md` records no other one.
 */
export const PGRUST_DEFAULT_BRANCH = "spike/wasip1-threads";

/**
 * The **pre-release** store bundle the broker columns load, which no published package corresponds
 * to.
 *
 * It is not pgrust and not npm: it is one file built out of a pgxsinkit checkout, and a release that
 * carries it has to say so with the same precision the AGPL statement demands of the wasm — MIT is a
 * gentler licence, but a benchmark result that cannot be traced to a commit is worthless either way.
 */
export const STORE_PACKAGE_NAME = "@pgxsinkit/pglite-opfs-repacked";

/** The repository the store bundle is built from. */
export const STORE_REPOSITORY = "https://github.com/pgxsinkit/pgxsinkit";

/** The branch that carries the sync broker; the default of `--store-branch`. */
export const STORE_DEFAULT_BRANCH = "feat/repacked-sync-broker";

/** The store package's licence, which is not pgrust's. */
export const STORE_LICENSE = "MIT";

/** What to run in a pgxsinkit checkout to reproduce the bundle. */
export const STORE_BUILD_COMMAND = "bun run build:public-packages";

/** What that command writes, and therefore what is uploaded. */
export const STORE_BUILD_OUTPUT = "packages/pglite-opfs-repacked/dist/browser-bundle.js";

/** The original of a file that is uploaded compressed. */
export interface UnpackedFileRecord {
  /** Name once decompressed, i.e. the name it takes in `public/pgrust/`. */
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** One file as uploaded to the release. */
export interface ManifestFileRecord {
  /** Name as uploaded, e.g. `postgres.wasm.gz`. */
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Present only when the uploaded file is a gzip; absent for files uploaded as-is. */
  readonly unpacked?: UnpackedFileRecord;
}

/** Where the binary comes from, in enough detail to rebuild it. */
export interface PgrustSourceRecord {
  readonly commit: string;
  readonly shortCommit: string;
  readonly branch: string;
  readonly repository: string;
  readonly upstream: { readonly repository: string; readonly commit: string };
}

/** How the binaries were built. */
export interface BuildRecord {
  readonly profile: string;
  /** The target `postgres.wasm` was built for. */
  readonly target: string;
  /**
   * The target `postgres-threads.wasm` was built for, when the release carries one.
   *
   * Optional because a release published before the threads artifact existed describes one target
   * and is still a complete source statement for what it contains. One profile and one toolchain
   * cover both: only the target differs.
   */
  readonly threadsTarget?: string;
  readonly toolchain: string;
}

/** How `vfs.img` was minted. */
export interface VfsRecord {
  /** The `initdb` that minted the image, e.g. `PostgreSQL 18`. */
  readonly initdb: string;
  /** ISO-8601 instant the image was built. */
  readonly builtAt: string;
}

/** How the store bundle was built, in the one command that reproduces it. */
export interface StoreBuildRecord {
  /** Run in a pgxsinkit checkout. */
  readonly command: string;
  /** What that command writes, relative to the checkout. */
  readonly output: string;
}

/**
 * Where the pre-release store bundle comes from.
 *
 * Optional on the manifest: releases published before the bundle was an asset describe a complete
 * set of what they do contain, and a sync from one simply reports that the broker columns need it.
 */
export interface StoreSourceRecord {
  /** The package name, which is a real published package — this build of it is not. */
  readonly package: string;
  /** The version in the checkout's manifest, a placeholder there: hence "pre-release". */
  readonly version: string;
  readonly repository: string;
  readonly commit: string;
  readonly branch: string;
  readonly license: string;
  readonly build: StoreBuildRecord;
}

/** The whole of `manifest.json`. */
export interface AssetManifest {
  readonly tag: string;
  readonly pgrust: PgrustSourceRecord;
  readonly build: BuildRecord;
  readonly vfs: VfsRecord;
  /** Present only when the release carries `pglite-opfs-repacked.js.gz`. */
  readonly store?: StoreSourceRecord;
  readonly files: readonly ManifestFileRecord[];
}

/** Everything `buildManifest` needs that is not implied by another field. */
export interface ManifestInput {
  readonly tag: string;
  readonly commit: string;
  readonly shortCommit: string;
  readonly branch: string;
  readonly repository?: string;
  readonly upstreamRepository?: string;
  readonly upstreamCommit: string;
  readonly profile: string;
  readonly target: string;
  /** Omitted for a release with no threads artifact in it. */
  readonly threadsTarget?: string;
  readonly toolchain: string;
  readonly initdb: string;
  readonly builtAt: string;
  /** Omitted for a release with no store bundle in it. */
  readonly store?: StoreSourceRecord;
  readonly files: readonly ManifestFileRecord[];
}

/** Raised for any manifest that is not internally consistent, on either side of the wire. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new ManifestError(`${field} must not be empty`);
  }
  return trimmed;
}

/**
 * The pgrust commit recorded in `src/vendor/pgrust/VERSION`.
 *
 * A `-dirty` suffix means the assets were built from a working tree that exists on no one else's
 * machine. Publishing that would make the AGPL source statement a lie, so it is refused here rather
 * than shipped with a caveat.
 */
export function parseVersionFile(contents: string): string {
  const version = contents.trim();
  if (version === "") {
    throw new ManifestError("src/vendor/pgrust/VERSION is empty — run `bun run sync:pgrust` first");
  }
  if (version.endsWith("-dirty")) {
    throw new ManifestError(
      `src/vendor/pgrust/VERSION is "${version}": these assets were built from a dirty working tree, ` +
        "which no one can check out. Commit and push the pgrust branch, re-sync, and rebuild.",
    );
  }
  if (!SHORT_COMMIT.test(version)) {
    throw new ManifestError(`src/vendor/pgrust/VERSION is "${version}", which is not a git commit`);
  }
  return version;
}

/** The release tag for a pgrust commit: `pgrust-assets/<first 8 of the commit>`. */
export function releaseTagForCommit(commit: string): string {
  if (!FULL_COMMIT.test(commit)) {
    throw new ManifestError(`"${commit}" is not a full 40-character git commit`);
  }
  return `${RELEASE_TAG_PREFIX}${commit.slice(0, RELEASE_TAG_COMMIT_LENGTH)}`;
}

/**
 * A directory name for a tag.
 *
 * Tags carry a `/`, which is fine in git and fine in a release download URL but would silently turn
 * one staging directory into two nested ones. Flattening keeps the tag readable in `ls` and keeps
 * `tmp/pgrust-assets/` one level deep.
 */
export function bundleDirectoryName(tag: string): string {
  return requireNonEmpty(tag, "tag").replaceAll("/", "-");
}

/**
 * Check a store record the same way the pgrust one is checked.
 *
 * The commit has to be the full 40 characters: an abbreviated one is a lookup, not a statement, and
 * this record's whole job is to say which bytes of which tree the broker columns ran.
 */
function validateStore(store: StoreSourceRecord): StoreSourceRecord {
  const commit = requireNonEmpty(store.commit, "store commit");
  if (!FULL_COMMIT.test(commit)) {
    throw new ManifestError(`store commit "${commit}" is not a full 40-character git commit`);
  }
  return {
    package: requireNonEmpty(store.package, "store package"),
    version: requireNonEmpty(store.version, "store version"),
    repository: requireNonEmpty(store.repository, "store repository"),
    commit,
    branch: requireNonEmpty(store.branch, "store branch"),
    license: requireNonEmpty(store.license, "store license"),
    build: {
      command: requireNonEmpty(store.build.command, "store build command"),
      output: requireNonEmpty(store.build.output, "store build output"),
    },
  };
}

/** Assemble and validate a manifest. Throws `ManifestError` rather than emitting a broken record. */
export function buildManifest(input: ManifestInput): AssetManifest {
  const commit = requireNonEmpty(input.commit, "commit");
  if (!FULL_COMMIT.test(commit)) {
    throw new ManifestError(`"${commit}" is not a full 40-character git commit`);
  }
  const shortCommit = requireNonEmpty(input.shortCommit, "shortCommit");
  if (!commit.startsWith(shortCommit)) {
    throw new ManifestError(`shortCommit "${shortCommit}" is not a prefix of commit "${commit}"`);
  }
  const upstreamCommit = requireNonEmpty(input.upstreamCommit, "upstreamCommit");
  if (!FULL_COMMIT.test(upstreamCommit)) {
    throw new ManifestError(`upstream commit "${upstreamCommit}" is not a full 40-character git commit`);
  }
  if (input.files.length === 0) {
    throw new ManifestError("a manifest with no files describes nothing");
  }
  const names = new Set<string>();
  for (const file of input.files) {
    if (names.has(file.name)) {
      throw new ManifestError(`duplicate file "${file.name}" in the manifest`);
    }
    names.add(file.name);
  }
  return {
    tag: requireNonEmpty(input.tag, "tag"),
    pgrust: {
      commit,
      shortCommit,
      branch: requireNonEmpty(input.branch, "branch"),
      repository: requireNonEmpty(input.repository ?? PGRUST_REPOSITORY, "repository"),
      upstream: {
        repository: requireNonEmpty(input.upstreamRepository ?? PGRUST_UPSTREAM_REPOSITORY, "upstream repository"),
        commit: upstreamCommit,
      },
    },
    build: {
      profile: requireNonEmpty(input.profile, "profile"),
      target: requireNonEmpty(input.target, "target"),
      ...(input.threadsTarget === undefined
        ? {}
        : { threadsTarget: requireNonEmpty(input.threadsTarget, "threadsTarget") }),
      toolchain: requireNonEmpty(input.toolchain, "toolchain"),
    },
    vfs: {
      initdb: requireNonEmpty(input.initdb, "initdb"),
      builtAt: requireNonEmpty(input.builtAt, "builtAt"),
    },
    ...(input.store === undefined ? {} : { store: validateStore(input.store) }),
    files: input.files,
  };
}

/** The URL of the exact store commit these assets carry, which survives the branch moving on. */
export function storeCommitUrl(store: StoreSourceRecord): string {
  return `${store.repository}/commit/${store.commit}`;
}

/** The URL of the branch the store bundle is built from. */
export function storeSourceUrl(store: StoreSourceRecord): string {
  return `${store.repository}/tree/${store.branch}`;
}

/** The URL of the exact source these assets were built from, for the AGPL statement. */
export function pgrustSourceUrl(source: PgrustSourceRecord): string {
  return `${source.repository}/tree/${source.branch}`;
}

/** The URL of the exact commit, which survives the branch moving on. */
export function pgrustCommitUrl(source: PgrustSourceRecord): string {
  return `${source.repository}/commit/${source.commit}`;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ManifestError(`${path} must be a string`);
  }
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ManifestError(`${path} must be a non-negative integer`);
  }
  return value;
}

function parseUnpacked(value: unknown, path: string): UnpackedFileRecord {
  const record = asRecord(value, path);
  return {
    name: asString(record["name"], `${path}.name`),
    bytes: asNumber(record["bytes"], `${path}.bytes`),
    sha256: asString(record["sha256"], `${path}.sha256`),
  };
}

function parseFile(value: unknown, path: string): ManifestFileRecord {
  const record = asRecord(value, path);
  const base = {
    name: asString(record["name"], `${path}.name`),
    bytes: asNumber(record["bytes"], `${path}.bytes`),
    sha256: asString(record["sha256"], `${path}.sha256`),
  };
  const unpacked = record["unpacked"];
  return unpacked === undefined ? base : { ...base, unpacked: parseUnpacked(unpacked, `${path}.unpacked`) };
}

function parseStore(value: unknown, path: string): StoreSourceRecord {
  const record = asRecord(value, path);
  const build = asRecord(record["build"], `${path}.build`);
  return {
    package: asString(record["package"], `${path}.package`),
    version: asString(record["version"], `${path}.version`),
    repository: asString(record["repository"], `${path}.repository`),
    commit: asString(record["commit"], `${path}.commit`),
    branch: asString(record["branch"], `${path}.branch`),
    license: asString(record["license"], `${path}.license`),
    build: {
      command: asString(build["command"], `${path}.build.command`),
      output: asString(build["output"], `${path}.build.output`),
    },
  };
}

/**
 * Re-parse a downloaded `manifest.json`.
 *
 * The download side must not trust a release asset's shape, and `JSON.parse` gives back `unknown`,
 * so every field is checked on the way in. The result is run back through `buildManifest`, which
 * means a manifest is held to exactly the same rules whether it was just built or just fetched.
 */
export function parseManifest(value: unknown): AssetManifest {
  const root = asRecord(value, "manifest");
  const pgrust = asRecord(root["pgrust"], "manifest.pgrust");
  const upstream = asRecord(pgrust["upstream"], "manifest.pgrust.upstream");
  const build = asRecord(root["build"], "manifest.build");
  const vfs = asRecord(root["vfs"], "manifest.vfs");
  const files = root["files"];
  if (!Array.isArray(files)) {
    throw new ManifestError("manifest.files must be an array");
  }
  const fileList: readonly unknown[] = files;
  return buildManifest({
    tag: asString(root["tag"], "manifest.tag"),
    commit: asString(pgrust["commit"], "manifest.pgrust.commit"),
    shortCommit: asString(pgrust["shortCommit"], "manifest.pgrust.shortCommit"),
    branch: asString(pgrust["branch"], "manifest.pgrust.branch"),
    repository: asString(pgrust["repository"], "manifest.pgrust.repository"),
    upstreamRepository: asString(upstream["repository"], "manifest.pgrust.upstream.repository"),
    upstreamCommit: asString(upstream["commit"], "manifest.pgrust.upstream.commit"),
    profile: asString(build["profile"], "manifest.build.profile"),
    target: asString(build["target"], "manifest.build.target"),
    ...(build["threadsTarget"] === undefined
      ? {}
      : { threadsTarget: asString(build["threadsTarget"], "manifest.build.threadsTarget") }),
    toolchain: asString(build["toolchain"], "manifest.build.toolchain"),
    initdb: asString(vfs["initdb"], "manifest.vfs.initdb"),
    builtAt: asString(vfs["builtAt"], "manifest.vfs.builtAt"),
    ...(root["store"] === undefined ? {} : { store: parseStore(root["store"], "manifest.store") }),
    files: fileList.map((file, index) => parseFile(file, `manifest.files[${index}]`)),
  });
}
