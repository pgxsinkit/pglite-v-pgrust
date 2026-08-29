import { describe, expect, test } from "bun:test";

import {
  BASELINE_CONFIGURATION_ID,
  BASELINE_CONFIGURATION_LABEL,
  CONFIGURATIONS,
  findConfiguration,
} from "./configurations";
import { applyModSql } from "./engines/contract";

describe("phase-1 Configurations", () => {
  test("are the three memory Configurations, in column order", () => {
    expect(CONFIGURATIONS.map((config) => config.id)).toEqual([
      "pglite-memory",
      "pglite-memory-unlogged",
      "pgrust-memory",
    ]);
    expect(CONFIGURATIONS.every((config) => config.dataDir === "")).toBe(true);
  });

  test("take their ratios against PGlite Memory", () => {
    expect(BASELINE_CONFIGURATION_ID).toBe("pglite-memory");
    expect(BASELINE_CONFIGURATION_LABEL).toBe("PGlite Memory");
    expect(findConfiguration(BASELINE_CONFIGURATION_ID)?.available).toBe(true);
  });

  test("mark pgrust unavailable with a reason until its Engine is wired up", () => {
    const pgrust = findConfiguration("pgrust-memory");
    expect(pgrust?.engine).toBe("pgrust");
    expect(pgrust?.available).toBe(false);
    expect(pgrust?.unavailableReason).toBe("pgrust engine not wired yet");
  });

  test("rewrite CREATE TABLE for the unlogged Configuration exactly as PGlite does", () => {
    const unlogged = findConfiguration("pglite-memory-unlogged");
    expect(unlogged).toBeDefined();
    if (unlogged === undefined) {
      return;
    }
    expect(applyModSql(unlogged, "CREATE TABLE a (x int); CREATE TABLE b (y int);")).toBe(
      "CREATE UNLOGGED TABLE a (x int); CREATE UNLOGGED TABLE b (y int);",
    );
    expect(applyModSql(unlogged, "SELECT 1;")).toBe("SELECT 1;");
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
