import { describe, expect, test } from "bun:test";

import { CONFIGURATIONS } from "./configurations";
import { OPFS_DIRECTORY_PREFIX, OPFS_PROBE_DIRECTORY, opfsPathSegments } from "./opfs";

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

describe("the directories this app owns", () => {
  test("all sit under the one prefix, probe included", () => {
    const paths = [OPFS_PROBE_DIRECTORY, ...CONFIGURATIONS.map((config) => config.dataDir).filter((dir) => dir !== "")];
    for (const path of paths) {
      expect(opfsPathSegments(path)[0]).toBe(OPFS_DIRECTORY_PREFIX);
      expect(opfsPathSegments(path).length).toBeGreaterThan(1);
    }
  });

  test("never let the probe share a directory with a Configuration", () => {
    const dataDirs = CONFIGURATIONS.map((config) => config.dataDir);
    expect(dataDirs).not.toContain(OPFS_PROBE_DIRECTORY);
  });
});
