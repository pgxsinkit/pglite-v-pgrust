import { describe, expect, test } from "bun:test";

import {
  BASELINE_CONFIGURATION_DIALECT,
  BASELINE_CONFIGURATION_ID,
  BASELINE_CONFIGURATION_LABEL,
  CONFIGURATIONS,
  findConfiguration,
} from "./configurations";
import { applyModSql } from "./engines/contract";
import { OPFS_DIRECTORY_PREFIX, opfsPathSegments } from "./opfs";

describe("phase-1 Configurations", () => {
  test("are the eight Configurations, in column order", () => {
    expect(CONFIGURATIONS.map((config) => config.id)).toEqual([
      "pglite-memory",
      "pglite-memory-unlogged",
      "pglite-opfs-repacked-relaxed",
      "pglite-opfs-repacked-strict",
      "pgrust-memory",
      "pgrust-memory-unlogged",
      "wasqlite-memory",
      "wasqlite-memory-journal-off",
    ]);
  });

  test("label every column the way its header reads", () => {
    expect(CONFIGURATIONS.map((config) => config.label)).toEqual([
      "PGlite Memory",
      "PGlite Memory (unlogged)",
      "PGlite OPFS repacked (relaxed)",
      "PGlite OPFS repacked (strict)",
      "pgrust Memory",
      "pgrust Memory (unlogged)",
      "wa-sqlite Memory",
      "wa-sqlite Memory (journal off)",
    ]);
  });

  test("give a data directory to the Storage Configurations and to nothing else", () => {
    const withDataDir = CONFIGURATIONS.filter((config) => config.dataDir !== "").map((config) => config.id);
    expect(withDataDir).toEqual(["pglite-opfs-repacked-relaxed", "pglite-opfs-repacked-strict"]);
  });

  test("give each store its own OPFS directory, under this app's own prefix", () => {
    const directories = CONFIGURATIONS.filter((config) => config.dataDir !== "").map((config) => config.dataDir);
    expect(directories).toEqual([
      `${OPFS_DIRECTORY_PREFIX}/opfs-repacked-relaxed`,
      `${OPFS_DIRECTORY_PREFIX}/opfs-repacked-strict`,
    ]);
    // Two live owners of one directory is a StoreOwnedError; two columns sharing one would also be
    // one column measuring the other's data directory.
    expect(new Set(directories).size).toBe(directories.length);
    for (const directory of directories) {
      expect(opfsPathSegments(directory)[0]).toBe(OPFS_DIRECTORY_PREFIX);
    }
  });

  test("run both OPFS columns on the same Engine and store, differing only in durability", () => {
    const relaxed = findConfiguration("pglite-opfs-repacked-relaxed");
    const strict = findConfiguration("pglite-opfs-repacked-strict");
    expect(relaxed?.engine).toBe("pglite");
    expect(strict?.engine).toBe("pglite");
    expect(relaxed?.options).toEqual({ pglite: { store: "opfs-repacked", durability: "relaxed" } });
    expect(strict?.options).toEqual({ pglite: { store: "opfs-repacked", durability: "strict" } });
    // No SQL rewrite: the two columns must be the same workload on the same store.
    expect(relaxed?.modSql).toBeUndefined();
    expect(strict?.modSql).toBeUndefined();
  });

  test("take their ratios against PGlite Memory", () => {
    expect(BASELINE_CONFIGURATION_ID).toBe("pglite-memory");
    expect(BASELINE_CONFIGURATION_LABEL).toBe("PGlite Memory");
    expect(BASELINE_CONFIGURATION_DIALECT).toBe("postgres");
    expect(findConfiguration(BASELINE_CONFIGURATION_ID)?.engine).toBe("pglite");
  });

  test("give both pgrust columns their own Engine", () => {
    expect(findConfiguration("pgrust-memory")?.engine).toBe("pgrust");
    expect(findConfiguration("pgrust-memory-unlogged")?.engine).toBe("pgrust");
  });

  test("give the Reference Engine its own two columns, and never the Baseline", () => {
    const reference = findConfiguration("wasqlite-memory");
    expect(reference?.engine).toBe("wasqlite");
    expect(reference?.id).not.toBe(BASELINE_CONFIGURATION_ID);
    expect(CONFIGURATIONS.filter((config) => config.engine === "wasqlite").map((config) => config.id)).toEqual([
      "wasqlite-memory",
      "wasqlite-memory-journal-off",
    ]);
  });

  test("leave the unlogged rewrite to the Postgres builds: SQLite has no unlogged tables", () => {
    expect(findConfiguration("wasqlite-memory")?.modSql).toBeUndefined();
    expect(findConfiguration("wasqlite-memory-journal-off")?.modSql).toBeUndefined();
    expect(findConfiguration("pglite-memory")?.modSql).toBeUndefined();
    expect(findConfiguration("pgrust-memory")?.modSql).toBeUndefined();
  });

  test("give SQLite its no-durability twin as a journal mode rather than a SQL rewrite", () => {
    const journalOff = findConfiguration("wasqlite-memory-journal-off");
    expect(journalOff?.engine).toBe("wasqlite");
    expect(journalOff?.options).toEqual({ wasqlite: { journalMode: "off" } });
    // The default wa-sqlite column keeps SQLite's own default journal mode: no options at all.
    expect(findConfiguration("wasqlite-memory")?.options).toBeUndefined();
  });

  test("leave the open options to the Configurations that have them", () => {
    for (const id of ["pglite-memory", "pglite-memory-unlogged", "pgrust-memory", "pgrust-memory-unlogged"]) {
      expect(findConfiguration(id)?.options).toBeUndefined();
    }
  });

  test("rewrite CREATE TABLE for both unlogged Configurations exactly as PGlite does", () => {
    for (const id of ["pglite-memory-unlogged", "pgrust-memory-unlogged"]) {
      const unlogged = findConfiguration(id);
      expect(unlogged).toBeDefined();
      if (unlogged === undefined) {
        continue;
      }
      expect(applyModSql(unlogged, "CREATE TABLE a (x int); CREATE TABLE b (y int);")).toBe(
        "CREATE UNLOGGED TABLE a (x int); CREATE UNLOGGED TABLE b (y int);",
      );
      expect(applyModSql(unlogged, "SELECT 1;")).toBe("SELECT 1;");
    }
  });

  test("leave SQL untouched for Configurations without a rewrite", () => {
    const baseline = findConfiguration(BASELINE_CONFIGURATION_ID);
    expect(baseline).toBeDefined();
    if (baseline === undefined) {
      return;
    }
    expect(applyModSql(baseline, "CREATE TABLE a (x int);")).toBe("CREATE TABLE a (x int);");
  });
});
