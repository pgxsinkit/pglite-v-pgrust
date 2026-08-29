import { describe, expect, test } from "bun:test";

import type { ManifestFileRecord, ManifestInput } from "./manifest";
import {
  bundleDirectoryName,
  buildManifest,
  ManifestError,
  parseManifest,
  parseVersionFile,
  pgrustCommitUrl,
  pgrustSourceUrl,
  releaseTagForCommit,
} from "./manifest";

const COMMIT = "dab0f92940dcf893d981f766f34baf776b59ed33";
const UPSTREAM = "438c8c420b96b23ca61927ba57e608839f86e935";

const FILES: readonly ManifestFileRecord[] = [
  {
    name: "postgres.wasm.gz",
    bytes: 100,
    sha256: "a".repeat(64),
    unpacked: { name: "postgres.wasm", bytes: 400, sha256: "b".repeat(64) },
  },
  { name: "vfs.json", bytes: 20, sha256: "c".repeat(64) },
];

function input(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    tag: "pgrust-assets/dab0f929",
    commit: COMMIT,
    shortCommit: "dab0f92940",
    branch: "bench/parse-source-text-borrow",
    upstreamCommit: UPSTREAM,
    profile: "wasm-release",
    target: "wasm32-wasip1",
    toolchain: "nightly-2026-07-17",
    initdb: "PostgreSQL 18",
    builtAt: "2026-08-29T11:19:00.000Z",
    files: FILES,
    ...overrides,
  };
}

describe("parseVersionFile", () => {
  test("returns the short commit, trimmed", () => {
    expect(parseVersionFile("dab0f92940\n")).toBe("dab0f92940");
  });

  test("refuses a dirty build, which no one else can check out", () => {
    expect(() => parseVersionFile("dab0f92940-dirty\n")).toThrow(ManifestError);
    expect(() => parseVersionFile("dab0f92940-dirty\n")).toThrow(/dirty working tree/);
  });

  test("refuses an empty or non-commit VERSION", () => {
    expect(() => parseVersionFile("  \n")).toThrow(/empty/);
    expect(() => parseVersionFile("not-synced\n")).toThrow(/not a git commit/);
  });
});

describe("releaseTagForCommit", () => {
  test("namespaces the first eight characters of the commit", () => {
    expect(releaseTagForCommit(COMMIT)).toBe("pgrust-assets/dab0f929");
  });

  test("refuses an abbreviated commit, which cannot be resolved later", () => {
    expect(() => releaseTagForCommit("dab0f929")).toThrow(ManifestError);
  });
});

describe("bundleDirectoryName", () => {
  test("flattens the tag's slash so one tag is one directory", () => {
    expect(bundleDirectoryName("pgrust-assets/dab0f929")).toBe("pgrust-assets-dab0f929");
  });

  test("rejects an empty tag", () => {
    expect(() => bundleDirectoryName("   ")).toThrow(ManifestError);
  });
});

describe("buildManifest", () => {
  test("fills in the pgrust repositories and keeps every stated field", () => {
    const manifest = buildManifest(input());
    expect(manifest.tag).toBe("pgrust-assets/dab0f929");
    expect(manifest.pgrust.repository).toBe("https://github.com/pgxsinkit/pgrust");
    expect(manifest.pgrust.upstream).toEqual({
      repository: "https://github.com/malisper/pgrust",
      commit: UPSTREAM,
    });
    expect(manifest.build).toEqual({
      profile: "wasm-release",
      target: "wasm32-wasip1",
      toolchain: "nightly-2026-07-17",
    });
    expect(manifest.vfs).toEqual({ initdb: "PostgreSQL 18", builtAt: "2026-08-29T11:19:00.000Z" });
    expect(manifest.files).toEqual(FILES);
  });

  test("keeps `unpacked` only on the files that are uploaded compressed", () => {
    const manifest = buildManifest(input());
    expect(manifest.files[0]?.unpacked?.name).toBe("postgres.wasm");
    expect(manifest.files[1]).not.toHaveProperty("unpacked");
  });

  test("refuses a short commit that is not a prefix of the commit", () => {
    expect(() => buildManifest(input({ shortCommit: "deadbee" }))).toThrow(/not a prefix/);
  });

  test("refuses an abbreviated or absent commit on either side", () => {
    expect(() => buildManifest(input({ commit: "dab0f929" }))).toThrow(/40-character/);
    expect(() => buildManifest(input({ upstreamCommit: "438c8c42" }))).toThrow(/upstream commit/);
  });

  test("refuses an empty field rather than publishing a blank source statement", () => {
    expect(() => buildManifest(input({ branch: "  " }))).toThrow(/branch/);
    expect(() => buildManifest(input({ toolchain: "" }))).toThrow(/toolchain/);
  });

  test("refuses a file list that is empty or names a file twice", () => {
    expect(() => buildManifest(input({ files: [] }))).toThrow(/describes nothing/);
    const first = FILES[0] as ManifestFileRecord;
    expect(() => buildManifest(input({ files: [first, first] }))).toThrow(/duplicate file/);
  });
});

describe("source URLs", () => {
  test("name the branch and the commit the binary came from", () => {
    const manifest = buildManifest(input());
    expect(pgrustSourceUrl(manifest.pgrust)).toBe(
      "https://github.com/pgxsinkit/pgrust/tree/bench/parse-source-text-borrow",
    );
    expect(pgrustCommitUrl(manifest.pgrust)).toBe(`https://github.com/pgxsinkit/pgrust/commit/${COMMIT}`);
  });
});

describe("parseManifest", () => {
  test("round-trips a manifest through JSON unchanged", () => {
    const manifest = buildManifest(input());
    expect(parseManifest(JSON.parse(JSON.stringify(manifest)) as unknown)).toEqual(manifest);
  });

  test("holds a downloaded manifest to the same rules as a built one", () => {
    const manifest = buildManifest(input());
    const tampered = { ...manifest, pgrust: { ...manifest.pgrust, shortCommit: "0000000" } };
    expect(() => parseManifest(tampered)).toThrow(/not a prefix/);
  });

  test("rejects anything that is not the shape of a manifest", () => {
    expect(() => parseManifest(null)).toThrow(/must be an object/);
    expect(() => parseManifest({ tag: "t" })).toThrow(/manifest.pgrust/);
    const manifest = buildManifest(input());
    expect(() => parseManifest({ ...manifest, files: "postgres.wasm.gz" })).toThrow(/files must be an array/);
    expect(() => parseManifest({ ...manifest, files: [{ name: "a", bytes: -1, sha256: "x" }] })).toThrow(
      /non-negative integer/,
    );
  });
});
