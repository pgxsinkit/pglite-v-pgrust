import { describe, expect, test } from "bun:test";

import { CONFIGURATIONS } from "./configurations";
import {
  isOwnedOpfsPath,
  OPFS_DIRECTORY_PREFIX,
  OPFS_PROBE_DIRECTORY,
  opfsOwnedRootDirectory,
  opfsPathSegments,
} from "./opfs";

describe("opfsPathSegments", () => {
  test("splits a nested path into the directories to walk", () => {
    expect(opfsPathSegments("pglite-v-pgrust/opfs-repacked-relaxed")).toEqual([
      "pglite-v-pgrust",
      "opfs-repacked-relaxed",
    ]);
    expect(opfsPathSegments("one")).toEqual(["one"]);
  });

  test('ignores empty segments rather than asking OPFS for a directory called ""', () => {
    expect(opfsPathSegments("/a//b/")).toEqual(["a", "b"]);
  });

  test("rejects a path that names no directory at all", () => {
    expect(() => opfsPathSegments("")).toThrow('"" is not an OPFS directory path');
    expect(() => opfsPathSegments("///")).toThrow("is not an OPFS directory path");
  });

  test("rejects relative segments instead of resolving them: they could escape the owned prefix", () => {
    expect(() => opfsPathSegments("pglite-v-pgrust/../elsewhere")).toThrow("contains a relative segment");
    expect(() => opfsPathSegments("./pglite-v-pgrust")).toThrow("contains a relative segment");
  });
});

describe("opfsOwnedRootDirectory", () => {
  // The vendored pgrust storage coordinator takes one directory NAME and resolves it against the
  // OPFS root, and `getDirectoryHandle` rejects a name containing a slash in Chromium and Firefox
  // alike — so a store it opens cannot live inside the prefix directory. The prefix moves into the
  // name instead, and the result is still one segment.
  test("names a root-level directory that still carries the prefix", () => {
    expect(opfsOwnedRootDirectory("threads-opfs-repacked-relaxed")).toBe(
      `${OPFS_DIRECTORY_PREFIX}-threads-opfs-repacked-relaxed`,
    );
    expect(opfsPathSegments(opfsOwnedRootDirectory("x"))).toHaveLength(1);
  });
});

describe("isOwnedOpfsPath", () => {
  test("accepts the two shapes this app uses and nothing else", () => {
    expect(isOwnedOpfsPath(`${OPFS_DIRECTORY_PREFIX}/opfs-repacked-relaxed`)).toBe(true);
    expect(isOwnedOpfsPath(OPFS_DIRECTORY_PREFIX)).toBe(true);
    expect(isOwnedOpfsPath(opfsOwnedRootDirectory("threads-opfs-repacked-strict"))).toBe(true);
    // A near miss is not this app's: an origin's OPFS is shared with every other page on it.
    expect(isOwnedOpfsPath("pglite-v-pgrustling")).toBe(false);
    expect(isOwnedOpfsPath("pgdata")).toBe(false);
    expect(isOwnedOpfsPath("elsewhere/pglite-v-pgrust")).toBe(false);
  });
});

describe("the directories this app owns", () => {
  test("all carry the one prefix, probe included", () => {
    const paths = [OPFS_PROBE_DIRECTORY, ...CONFIGURATIONS.map((config) => config.dataDir).filter((dir) => dir !== "")];
    for (const path of paths) {
      expect(isOwnedOpfsPath(path)).toBe(true);
    }
  });

  // Whatever an owned path's shape, it must never BE the prefix directory: that one is shared by
  // every Run and by any other tab of this app, and a store owns its directory in full.
  test("never let a Configuration or the probe own the prefix directory itself", () => {
    const paths = [OPFS_PROBE_DIRECTORY, ...CONFIGURATIONS.map((config) => config.dataDir).filter((dir) => dir !== "")];
    for (const path of paths) {
      expect(path).not.toBe(OPFS_DIRECTORY_PREFIX);
    }
  });

  test("never let the probe share a directory with a Configuration", () => {
    const dataDirs = CONFIGURATIONS.map((config) => config.dataDir);
    expect(dataDirs).not.toContain(OPFS_PROBE_DIRECTORY);
  });
});
