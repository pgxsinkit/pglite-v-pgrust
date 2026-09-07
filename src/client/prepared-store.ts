/**
 * Seal a store the file port built, and write it out as one tarball a browser can boot on.
 *
 * This is the bun half of the prepared-store lane (`../prepared-store-format.ts` has the idea and
 * the format; `../engines/pgrust-postmaster/store-seed.worker.ts` is the other half). It runs after
 * the postmaster has stopped and its coordinator has closed the store — never beside a live one:
 *
 *  1. reopen the store DIRECTLY on the file port, with no engine and no broker in between. There is
 *     nothing to serve at this point, and `repack()` has no broker opcode anyway: the coordinator's
 *     protocol is a filesystem, and compaction is a property of the store rather than of the tree
 *     inside it;
 *  2. `repack()` — the store's own compaction, and the reason the artefact is worth shipping at all.
 *     An arena that grew a quarter-gigabyte datadir a write at a time holds every superseded extent
 *     it ever wrote; a repack projects the live set forward and leaves an arena whose size is the
 *     DATA rather than its history;
 *  3. `strictSync()` and `close()`, so the four files on disk are the store and nothing is pending;
 *  4. read them, hash them, and write `<name>.repacked.tar.gz`: the manifest first, then the four
 *     files with `activation.bin` last.
 *
 * `Bun.gzipSync` rather than `CompressionStream`, because this side is bun by construction and one
 * synchronous call over a whole buffer is what it is for; the browser reads it back with
 * `DecompressionStream("gzip")`, which is the same format.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REGTYPE, tar, type TarFile } from "tinytar";

import {
  PREPARED_STORE_KIND,
  PREPARED_STORE_MANIFEST_NAME,
  PREPARED_STORE_MANIFEST_VERSION,
  PREPARED_STORE_OWNED_FILES,
  readArenaFormat,
} from "../prepared-store-format";
import type { PreparedStoreFileRecord, PreparedStoreManifest } from "../prepared-store-format";
import { loadRepackedBundle, repackedBundleUrl } from "../vendor/pgrust/broker-fs.js";

/** The gitignored build outputs `bun run sync:pgrust` writes; the store bundle lives under `host/`. */
const DEFAULT_ASSET_DIR = fileURLToPath(new URL("../../public/pgrust/", import.meta.url));

/** The synced pgrust commit, which is what the datadir in the store was produced by. */
const VENDOR_VERSION_FILE = fileURLToPath(new URL("../vendor/pgrust/VERSION", import.meta.url));

/** The extent size every pgrust lane in this repo opens its store with; see `wasm/storage-worker.js`. */
const DEFAULT_EXTENT_SIZE = 8192;

/** tar's own default mode for a regular file. Nothing here is executable and nothing is a directory. */
const TAR_FILE_MODE = 0o644;

export interface PrepareStoreTarOptions {
  /** The directory the file port owns: the four files, and nothing else. */
  readonly fileDir: string;
  /** Where to write the tarball. `.repacked.tar.gz` by convention; the caller names it in full. */
  readonly tarPath: string;
  /**
   * Compact the arena before sealing. On by default, and the difference between shipping the data
   * and shipping every version of it that was ever written.
   */
  readonly repack?: boolean;
  /** The extent size the store was created with; the open fails by name if it disagrees. */
  readonly extentSize?: number;
  /** Where the pgrust build outputs live. `public/pgrust/` by default. */
  readonly assetDir?: string;
  /** What the datadir held when it was sealed, recorded in the manifest for the restoring side. */
  readonly datadir?: { readonly path: string; readonly files: number; readonly bytes: number };
}

/** One file's size on either side of the repack, which is the number the whole exercise is about. */
export interface PreparedStoreFileSizes {
  readonly name: string;
  readonly bytesBeforeRepack: number;
  readonly bytesAfterRepack: number;
  readonly sha256: string;
}

export interface PrepareStoreTarResult {
  readonly tarPath: string;
  readonly manifest: PreparedStoreManifest;
  readonly files: readonly PreparedStoreFileSizes[];
  /** The tarball before gzip, and after. Both, because the ratio is the interesting part. */
  readonly tarBytes: number;
  readonly gzipBytes: number;
  readonly openMs: number;
  readonly repackMs: number;
  readonly syncMs: number;
  readonly readMs: number;
  readonly tarMs: number;
  readonly gzipMs: number;
  readonly totalMs: number;
  /** Arena extents held after the repack, times the extent size: the store's own view of its size. */
  readonly arenaBytesAfterRepack: number;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readVendorCommit(): string {
  try {
    return readFileSync(VENDOR_VERSION_FILE, "utf8").trim();
  } catch {
    return "unknown";
  }
}

/** Synchronous SHA-256 over a whole file, which is all this side needs. */
function sha256File(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Seal the store in `fileDir` and write it out as one gzipped tarball.
 *
 * The store must be CLOSED — the postmaster stopped, the coordinator's worker gone. Opening it here
 * beside a live coordinator would be two owners of one store, which the file port cannot prevent
 * across processes and which nothing in this repo has any reason to do.
 */
export async function prepareStoreTar(options: PrepareStoreTarOptions): Promise<PrepareStoreTarResult> {
  const startedAt = performance.now();
  const extentSize = options.extentSize ?? DEFAULT_EXTENT_SIZE;
  const assetDir = options.assetDir ?? DEFAULT_ASSET_DIR;
  const bundleUrl = repackedBundleUrl(pathToFileURL(`${assetDir}host/`).href);
  const bundle = await loadRepackedBundle(bundleUrl);

  const paths = PREPARED_STORE_OWNED_FILES.map((name) => ({ name, path: `${options.fileDir}/${name}` }));
  const before = new Map(paths.map(({ name, path }) => [name, sizeOf(path)]));

  const openedAt = performance.now();
  const vfs = await bundle.RepackedVfs.open(new bundle.FileRepackedPort(options.fileDir), { extentSize });
  const openMs = performance.now() - openedAt;

  let repackMs = 0;
  let syncMs = 0;
  let arenaBytesAfterRepack = 0;
  try {
    if (options.repack !== false) {
      const repackedAt = performance.now();
      vfs.repack("manual");
      repackMs = performance.now() - repackedAt;
    }
    const syncedAt = performance.now();
    vfs.strictSync();
    syncMs = performance.now() - syncedAt;
    arenaBytesAfterRepack = Number(vfs.metrics().totalExtents) * extentSize;
  } finally {
    // The four fds go here, and they must: the tarball is read from the same files, and a store left
    // open is a store whose last flush may still be this process's business.
    vfs.close();
  }

  const readAt = performance.now();
  const contents = paths.map(({ name, path }) => ({ name, bytes: readFileSync(path) }));
  const readMs = performance.now() - readAt;

  const records: PreparedStoreFileRecord[] = contents.map(({ name, bytes }) => ({
    name,
    bytes: bytes.byteLength,
    sha256: sha256File(bytes),
  }));
  const arena = contents.find((entry) => entry.name === "arena.bin");
  if (arena === undefined) {
    throw new Error(`${options.fileDir} holds no arena.bin; it is not a repacked store directory`);
  }

  const manifest: PreparedStoreManifest = {
    kind: PREPARED_STORE_KIND,
    manifestVersion: PREPARED_STORE_MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    store: readArenaFormat(arena.bytes),
    pgrustAssetCommit: readVendorCommit(),
    datadir: options.datadir ?? null,
    files: records,
  };

  const modifyTime = new Date();
  const entry = (name: string, data: Uint8Array): TarFile => ({
    name,
    mode: TAR_FILE_MODE,
    size: data.byteLength,
    type: REGTYPE,
    modifyTime,
    data,
  });
  const tarAt = performance.now();
  // The manifest FIRST so a reader can verify before it writes, and the four files in their own
  // order so `activation.bin` — the record that says which metadata log is authoritative — is last.
  const tarball = tar([
    entry(PREPARED_STORE_MANIFEST_NAME, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)),
    ...contents.map(({ name, bytes }) => entry(name, bytes)),
  ]);
  const tarMs = performance.now() - tarAt;

  const gzipAt = performance.now();
  const gzipped = Bun.gzipSync(tarball);
  const gzipMs = performance.now() - gzipAt;

  mkdirSync(dirname(options.tarPath), { recursive: true });
  writeFileSync(options.tarPath, gzipped);

  return {
    tarPath: options.tarPath,
    manifest,
    files: records.map((record) => ({
      name: record.name,
      bytesBeforeRepack: before.get(record.name) ?? 0,
      bytesAfterRepack: record.bytes,
      sha256: record.sha256,
    })),
    tarBytes: tarball.byteLength,
    gzipBytes: gzipped.byteLength,
    openMs,
    repackMs,
    syncMs,
    readMs,
    tarMs,
    gzipMs,
    totalMs: performance.now() - startedAt,
    arenaBytesAfterRepack,
  };
}
