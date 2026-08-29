import { describe, expect, test } from "bun:test";

import {
  ChecksumFormatError,
  checkChecksumCoverage,
  checkDownloadedFile,
  checkUnpackedFile,
  formatSha256Sums,
  isSha256,
  parseSha256Sums,
  sha256Hex,
} from "./checksums";
import type { AssetManifest, ManifestFileRecord } from "./manifest";
import { buildManifest } from "./manifest";

const WASM_SHA = "a".repeat(64);
const RAW_SHA = "b".repeat(64);
const JSON_SHA = "c".repeat(64);

const PACKED: ManifestFileRecord = {
  name: "postgres.wasm.gz",
  bytes: 100,
  sha256: WASM_SHA,
  unpacked: { name: "postgres.wasm", bytes: 400, sha256: RAW_SHA },
};

const PLAIN: ManifestFileRecord = { name: "vfs.json", bytes: 20, sha256: JSON_SHA };

const SUMS: ReadonlyMap<string, string> = new Map([
  ["postgres.wasm.gz", WASM_SHA],
  ["vfs.json", JSON_SHA],
]);

function manifest(files: readonly ManifestFileRecord[] = [PACKED, PLAIN]): AssetManifest {
  return buildManifest({
    tag: "pgrust-assets/dab0f929",
    commit: "dab0f92940dcf893d981f766f34baf776b59ed33",
    shortCommit: "dab0f92940",
    branch: "bench/parse-source-text-borrow",
    upstreamCommit: "438c8c420b96b23ca61927ba57e608839f86e935",
    profile: "wasm-release",
    target: "wasm32-wasip1",
    toolchain: "nightly-2026-07-17",
    initdb: "PostgreSQL 18",
    builtAt: "2026-08-29T11:19:00.000Z",
    files,
  });
}

describe("formatSha256Sums", () => {
  test("writes sha256sum text mode: digest, two spaces, name, trailing newline", () => {
    expect(formatSha256Sums([{ name: "vfs.json", sha256: JSON_SHA }])).toBe(`${JSON_SHA}  vfs.json\n`);
  });

  test("keeps the given order, one file per line", () => {
    const rendered = formatSha256Sums([
      { name: "postgres.wasm.gz", sha256: WASM_SHA },
      { name: "vfs.json", sha256: JSON_SHA },
    ]);
    expect(rendered.split("\n")).toEqual([`${WASM_SHA}  postgres.wasm.gz`, `${JSON_SHA}  vfs.json`, ""]);
  });

  test("round-trips through the parser", () => {
    const entries = [
      { name: "postgres.wasm.gz", sha256: WASM_SHA },
      { name: "vfs.json", sha256: JSON_SHA },
    ];
    expect([...parseSha256Sums(formatSha256Sums(entries))]).toEqual(entries.map((e) => [e.name, e.sha256]));
  });
});

describe("parseSha256Sums", () => {
  test("accepts binary mode and uppercase digests, and ignores blank lines", () => {
    const parsed = parseSha256Sums(`\n${WASM_SHA.toUpperCase()} *postgres.wasm.gz\n\n${JSON_SHA}  vfs.json\n`);
    expect(parsed.get("postgres.wasm.gz")).toBe(WASM_SHA);
    expect(parsed.get("vfs.json")).toBe(JSON_SHA);
  });

  test("rejects a line that is not a checksum line", () => {
    expect(() => parseSha256Sums("not a checksum\n")).toThrow(ChecksumFormatError);
    expect(() => parseSha256Sums(`${WASM_SHA} onespace\n`)).toThrow(/line 1/);
  });

  test("rejects a duplicated name and an empty file", () => {
    expect(() => parseSha256Sums(`${WASM_SHA}  a\n${JSON_SHA}  a\n`)).toThrow(/twice/);
    expect(() => parseSha256Sums("\n\n")).toThrow(/empty/);
  });
});

describe("sha256Hex", () => {
  test("hashes bytes to lowercase hex", () => {
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(isSha256(sha256Hex(new TextEncoder().encode("pgrust")))).toBe(true);
  });
});

describe("checkDownloadedFile", () => {
  test("passes a file that matches the manifest and SHA256SUMS", () => {
    expect(checkDownloadedFile(PACKED, SUMS, { bytes: 100, sha256: WASM_SHA })).toEqual([]);
  });

  test("reports a wrong size, a wrong digest and an absent SHA256SUMS entry", () => {
    expect(checkDownloadedFile(PACKED, SUMS, { bytes: 99, sha256: WASM_SHA })).toEqual([
      "postgres.wasm.gz: expected 100 bytes, got 99",
    ]);
    expect(checkDownloadedFile(PACKED, SUMS, { bytes: 100, sha256: RAW_SHA })).toHaveLength(2);
    expect(checkDownloadedFile(PACKED, new Map(), { bytes: 100, sha256: WASM_SHA })).toEqual([
      "postgres.wasm.gz: not listed in SHA256SUMS",
    ]);
  });

  test("catches SHA256SUMS disagreeing with the manifest about the same file", () => {
    const rogue = new Map([["postgres.wasm.gz", RAW_SHA]]);
    expect(checkDownloadedFile(PACKED, rogue, { bytes: 100, sha256: WASM_SHA })).toEqual([
      `postgres.wasm.gz: SHA256SUMS says ${RAW_SHA}, downloaded ${WASM_SHA}`,
    ]);
  });
});

describe("checkUnpackedFile", () => {
  test("checks the bytes a gzip decompressed to, which SHA256SUMS cannot cover", () => {
    expect(checkUnpackedFile(PACKED, { bytes: 400, sha256: RAW_SHA })).toEqual([]);
    expect(checkUnpackedFile(PACKED, { bytes: 400, sha256: WASM_SHA })).toEqual([
      `postgres.wasm: manifest sha256 ${RAW_SHA}, unpacked ${WASM_SHA}`,
    ]);
    expect(checkUnpackedFile(PACKED, { bytes: 1, sha256: RAW_SHA })).toEqual([
      "postgres.wasm: expected 400 bytes unpacked, got 1",
    ]);
  });

  test("has nothing to check for a file uploaded as-is", () => {
    expect(checkUnpackedFile(PLAIN, { bytes: 0, sha256: "" })).toEqual([]);
  });
});

describe("checkChecksumCoverage", () => {
  test("passes when both records name the same files", () => {
    expect(checkChecksumCoverage(manifest(), SUMS)).toEqual([]);
  });

  test("reports files either record is missing", () => {
    expect(checkChecksumCoverage(manifest([PACKED]), SUMS)).toEqual([
      'SHA256SUMS lists "vfs.json", which the manifest does not describe',
    ]);
    expect(checkChecksumCoverage(manifest(), new Map([["vfs.json", JSON_SHA]]))).toEqual([
      'the manifest describes "postgres.wasm.gz", which SHA256SUMS does not list',
    ]);
  });
});
