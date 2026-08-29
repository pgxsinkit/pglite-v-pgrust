/**
 * `SHA256SUMS` — the same format `sha256sum` writes and `sha256sum -c` reads, so a release asset can
 * be verified by hand without this repo:
 *
 * ```sh
 * sha256sum -c SHA256SUMS
 * ```
 *
 * Formatting, parsing and the comparisons that decide whether a download is trustworthy all live
 * here as pure functions over already-computed digests: hashing bytes is the caller's job, deciding
 * whether those digests are acceptable is this module's.
 */

import { createHash } from "node:crypto";

import type { AssetManifest, ManifestFileRecord } from "./manifest";

/** A lowercase hex SHA-256. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** One line of a `SHA256SUMS` file. */
export interface ChecksumEntry {
  readonly name: string;
  readonly sha256: string;
}

/** Raised when a checksum file is unreadable; a mismatch is reported as a problem list instead. */
export class ChecksumFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecksumFormatError";
  }
}

/**
 * Render entries in `sha256sum` text mode: the digest, two spaces, the name.
 *
 * Text mode (two spaces) rather than binary mode (` *`) because GNU `sha256sum -c` reads both and
 * text mode is what the plain `sha256sum file...` invocation produces, which is what a reader will
 * compare against.
 */
export function formatSha256Sums(entries: readonly ChecksumEntry[]): string {
  return `${entries.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n")}\n`;
}

/**
 * Parse a `SHA256SUMS` file into name -> digest.
 *
 * Both `sha256sum` modes are accepted — `<hex>  <name>` and `<hex> *<name>` — because a file
 * produced by `sha256sum -b` is still a valid statement about the same bytes.
 */
export function parseSha256Sums(contents: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  const lines = contents.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    const match = /^([0-9a-fA-F]{64})[ ](?:[ ]|\*)(.+)$/.exec(line);
    if (match === null) {
      throw new ChecksumFormatError(`SHA256SUMS line ${index + 1} is not a sha256sum line: ${JSON.stringify(line)}`);
    }
    const digest = (match[1] ?? "").toLowerCase();
    const name = (match[2] ?? "").trim();
    if (entries.has(name)) {
      throw new ChecksumFormatError(`SHA256SUMS lists "${name}" twice`);
    }
    entries.set(name, digest);
  }
  if (entries.size === 0) {
    throw new ChecksumFormatError("SHA256SUMS is empty");
  }
  return entries;
}

/** The lowercase hex SHA-256 of some bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True for a well-formed lowercase hex SHA-256. */
export function isSha256(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * Everything wrong with a downloaded file, as human-readable lines; empty means it verified.
 *
 * A file has to clear two independent records: `SHA256SUMS`, which is what a reader checks by hand,
 * and the manifest, which additionally pins the size and the digest of the *unpacked* bytes. Both
 * are checked, because a gzip that unpacks to something other than what was published would still
 * satisfy `SHA256SUMS` alone.
 */
export function checkDownloadedFile(
  file: ManifestFileRecord,
  checksums: ReadonlyMap<string, string>,
  actual: { readonly bytes: number; readonly sha256: string },
): readonly string[] {
  const problems: string[] = [];
  if (actual.bytes !== file.bytes) {
    problems.push(`${file.name}: expected ${file.bytes} bytes, got ${actual.bytes}`);
  }
  if (actual.sha256 !== file.sha256) {
    problems.push(`${file.name}: manifest sha256 ${file.sha256}, downloaded ${actual.sha256}`);
  }
  const published = checksums.get(file.name);
  if (published === undefined) {
    problems.push(`${file.name}: not listed in SHA256SUMS`);
  } else if (published !== actual.sha256) {
    problems.push(`${file.name}: SHA256SUMS says ${published}, downloaded ${actual.sha256}`);
  }
  return problems;
}

/** Everything wrong with the bytes a downloaded gzip decompressed to; empty means it verified. */
export function checkUnpackedFile(
  file: ManifestFileRecord,
  actual: { readonly bytes: number; readonly sha256: string },
): readonly string[] {
  const unpacked = file.unpacked;
  if (unpacked === undefined) {
    return [];
  }
  const problems: string[] = [];
  if (actual.bytes !== unpacked.bytes) {
    problems.push(`${unpacked.name}: expected ${unpacked.bytes} bytes unpacked, got ${actual.bytes}`);
  }
  if (actual.sha256 !== unpacked.sha256) {
    problems.push(`${unpacked.name}: manifest sha256 ${unpacked.sha256}, unpacked ${actual.sha256}`);
  }
  return problems;
}

/**
 * Whether `SHA256SUMS` and the manifest agree about which files a release contains.
 *
 * They are written together, so a disagreement means the release was assembled or edited by
 * something other than `bun run pgrust:bundle` and none of it should be trusted.
 */
export function checkChecksumCoverage(
  manifest: AssetManifest,
  checksums: ReadonlyMap<string, string>,
): readonly string[] {
  const problems: string[] = [];
  const expected = new Set(manifest.files.map((file) => file.name));
  for (const name of checksums.keys()) {
    if (!expected.has(name)) {
      problems.push(`SHA256SUMS lists "${name}", which the manifest does not describe`);
    }
  }
  for (const file of manifest.files) {
    if (!checksums.has(file.name)) {
      problems.push(`the manifest describes "${file.name}", which SHA256SUMS does not list`);
    }
  }
  return problems;
}
