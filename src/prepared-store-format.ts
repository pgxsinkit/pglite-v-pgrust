/**
 * The **prepared store**: four files, one manifest, one tarball — and the format both ends agree on.
 *
 * The idea it exists to serve. A repacked store is exactly four files (`arena.bin`, two metadata
 * logs, `activation.bin`), and the store's format lives ABOVE its port: nothing in the arena, the
 * metadata log or the activation record knows whether it is being read through OPFS sync access
 * handles, through `node:fs`, or out of a heap. So a datadir can be built ONCE, under bun, on the
 * file port — `initdb` seed, every insert, the checkpoint, the repack — and the four files it leaves
 * behind can be handed to a browser, written into an OPFS directory, and opened by the OPFS port as
 * the same store. Nothing is replayed and nothing is converted: the bytes are the same bytes.
 *
 * That is the whole difference from a datadir tarball. PGlite's `loadDataDir` carries a POSIX tree —
 * some thousands of files — and restoring it means creating each one through the filesystem it is
 * being restored INTO, which on a quarter-gigabyte datadir is the minute-plus this repo set out to
 * remove. Four files carry the same datadir with four writes.
 *
 * This module is the seam between the two halves and deliberately runtime-neutral: no `node:`
 * import, no DOM API beyond `crypto.subtle`, which bun and every browser both have. The bun half
 * (`./client/prepared-store.ts`) writes the tarball; the browser half
 * (`./engines/pgrust-postmaster/store-seed.worker.ts`) reads it and writes the four files into OPFS.
 */

/**
 * The four files, in the order the tarball carries them.
 *
 * `activation.bin` LAST, and that ordering is the one thing about the layout that is not arbitrary:
 * it is the file that says which metadata log is authoritative, so a tarball written or extracted
 * only part way leaves a store whose activation record still points at data that is fully there.
 * (`OWNED_FILE_NAMES` in `@pgxsinkit/pglite-opfs-repacked` is the same four; it is not exported from
 * the package, so it is restated here rather than guessed at.)
 */
export const PREPARED_STORE_OWNED_FILES = ["arena.bin", "metadata-a.bin", "metadata-b.bin", "activation.bin"] as const;

export type PreparedStoreFileName = (typeof PREPARED_STORE_OWNED_FILES)[number];

/** The manifest's name inside the tarball. It is the FIRST entry, so a reader verifies before writing. */
export const PREPARED_STORE_MANIFEST_NAME = "manifest.json";

/** What this repo calls the artefact, so a stray tarball cannot be mistaken for a datadir dump. */
export const PREPARED_STORE_KIND = "pgxsinkit-repacked-store";

/** The manifest's own schema version, bumped when a field's meaning changes. */
export const PREPARED_STORE_MANIFEST_VERSION = 1;

/** One file's identity in the manifest. `sha256` is lower-case hex of the file's whole contents. */
export interface PreparedStoreFileRecord {
  readonly name: PreparedStoreFileName;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * The store's own format identity, read out of the arena header rather than restated.
 *
 * Bytes 0–8 are the magic `PGXRPA01`, 8–12 the format version, 12–16 the limits-profile version and
 * 16–20 the extent size, all little-endian. The extent size matters as much as the versions: a store
 * is reopened with the size it was created with, and the two must agree or the open fails by name
 * (`ExtentSizeMismatchError`).
 */
export interface PreparedStoreFormat {
  readonly magic: string;
  readonly formatVersion: number;
  readonly limitsProfileVersion: number;
  readonly extentSize: number;
}

export interface PreparedStoreManifest {
  readonly kind: typeof PREPARED_STORE_KIND;
  readonly manifestVersion: number;
  readonly createdAt: string;
  readonly store: PreparedStoreFormat;
  /** The pgrust build the datadir was produced by: `src/vendor/pgrust/VERSION`, the synced commit. */
  readonly pgrustAssetCommit: string;
  /** What the datadir held when the store was sealed, for a probe to check its restore against. */
  readonly datadir: { readonly path: string; readonly files: number; readonly bytes: number } | null;
  readonly files: readonly PreparedStoreFileRecord[];
}

/** The arena magic, as the store writes it. */
export const ARENA_MAGIC = "PGXRPA01";

/** The arena header's first twenty bytes are all this needs; anything shorter is not a store. */
export const ARENA_HEADER_PREFIX_BYTES = 20;

/**
 * Read the store's format identity out of an arena header.
 *
 * Deliberately not a validation of the store — the store validates itself when it opens, with its
 * own checksums and its own error classes. This is the manifest's record of WHAT was packed, and the
 * one check it makes is the magic, because a tarball whose `arena.bin` is not an arena is a mistake
 * worth naming before four files are written over somebody's store.
 */
export function readArenaFormat(arena: Uint8Array): PreparedStoreFormat {
  if (arena.byteLength < ARENA_HEADER_PREFIX_BYTES) {
    throw new Error(`arena.bin is ${arena.byteLength} bytes, too short to carry a store header`);
  }
  const magic = new TextDecoder().decode(arena.subarray(0, 8));
  if (magic !== ARENA_MAGIC) {
    throw new Error(`arena.bin does not start with the store magic (${JSON.stringify(magic)} != ${ARENA_MAGIC})`);
  }
  const view = new DataView(arena.buffer, arena.byteOffset, ARENA_HEADER_PREFIX_BYTES);
  return {
    magic,
    formatVersion: view.getUint32(8, true),
    limitsProfileVersion: view.getUint32(12, true),
    extentSize: view.getUint32(16, true),
  };
}

/** Lower-case hex SHA-256, through the one digest API bun and every browser share. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A fresh copy, because `crypto.subtle` will not take a view onto a SharedArrayBuffer and a
  // subarray of a larger buffer would hash the wrong range on some engines.
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse and check a manifest, or say exactly which part of it is wrong.
 *
 * Structural only: it proves the document describes this kind of artefact, at a schema version this
 * code understands, naming all four files exactly once. Whether the BYTES match is
 * {@link verifyPreparedStoreFiles}'s question, and it is asked separately because the manifest has to
 * be trusted enough to read the entry names out of before the entries can be hashed.
 */
export function parsePreparedStoreManifest(json: string): PreparedStoreManifest {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new Error("the prepared-store manifest is not an object");
  }
  if (parsed["kind"] !== PREPARED_STORE_KIND) {
    throw new Error(
      `the tarball is not a prepared store (kind ${JSON.stringify(parsed["kind"])}, expected ${PREPARED_STORE_KIND})`,
    );
  }
  if (parsed["manifestVersion"] !== PREPARED_STORE_MANIFEST_VERSION) {
    throw new Error(
      `prepared-store manifest version ${String(parsed["manifestVersion"])} is not ` +
        `${PREPARED_STORE_MANIFEST_VERSION}, which is the only one this build reads`,
    );
  }
  const files = parsed["files"];
  if (!Array.isArray(files)) {
    throw new Error("the prepared-store manifest lists no files");
  }
  const named = new Map<string, PreparedStoreFileRecord>();
  for (const entry of files as unknown[]) {
    if (!isRecord(entry) || typeof entry["name"] !== "string") {
      throw new Error("a prepared-store manifest file entry has no name");
    }
    const name = entry["name"];
    if (!(PREPARED_STORE_OWNED_FILES as readonly string[]).includes(name)) {
      throw new Error(`the prepared-store manifest names ${JSON.stringify(name)}, which is not a store file`);
    }
    if (named.has(name)) {
      throw new Error(`the prepared-store manifest names ${name} twice`);
    }
    if (typeof entry["bytes"] !== "number" || typeof entry["sha256"] !== "string") {
      throw new Error(`the prepared-store manifest entry for ${name} has no size or digest`);
    }
    named.set(name, { name: name as PreparedStoreFileName, bytes: entry["bytes"], sha256: entry["sha256"] });
  }
  const missing = PREPARED_STORE_OWNED_FILES.filter((name) => !named.has(name));
  if (missing.length > 0) {
    throw new Error(`the prepared-store manifest is missing ${missing.join(", ")}`);
  }
  return parsed as unknown as PreparedStoreManifest;
}

/**
 * Check the four extracted files against the manifest: every size, every digest.
 *
 * Both, not one: a size check catches a truncated download and costs nothing, and the digest is what
 * catches a corrupted middle. It runs BEFORE anything is written into OPFS, because the destination
 * is a store directory somebody may already be using and a half-written store is worse than no
 * store at all.
 */
export async function verifyPreparedStoreFiles(
  manifest: PreparedStoreManifest,
  extracted: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  for (const record of manifest.files) {
    const bytes = extracted.get(record.name);
    if (bytes === undefined) {
      throw new Error(`the prepared-store tarball has no ${record.name}`);
    }
    if (bytes.byteLength !== record.bytes) {
      throw new Error(`${record.name} is ${bytes.byteLength} bytes, the manifest says ${record.bytes}`);
    }
    const digest = await sha256Hex(bytes);
    if (digest !== record.sha256) {
      throw new Error(`${record.name} hashes to ${digest}, the manifest says ${record.sha256}`);
    }
  }
}

/** Gunzip through the one streaming API bun and every browser share. */
export async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // Deliberately not awaited before the reads start: a big buffer fills the transform's queue and
  // the write only settles once the reader has drained it.
  const written = writer.write(bytes).then(async () => await writer.close());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value !== undefined) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  await written;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
