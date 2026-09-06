import { describe, expect, test } from "bun:test";

import { CONFIGURATIONS, findConfiguration } from "../configurations";
import type { Configuration, EngineId } from "./contract";
import { configurationDialect, engineDialect, pgliteOpenOptions, pgliteStore } from "./contract";

function configuration(id: string): Configuration {
  const found = findConfiguration(id);
  if (found === undefined) {
    throw new Error(`unknown Configuration "${id}"`);
  }
  return found;
}

describe("engineDialect", () => {
  test("puts both Postgres builds in the postgres dialect and wa-sqlite in the sqlite one", () => {
    expect(engineDialect("pglite")).toBe("postgres");
    expect(engineDialect("pgrust")).toBe("postgres");
    expect(engineDialect("wasqlite")).toBe("sqlite");
  });

  test("answers for every Engine a Configuration names", () => {
    const engines: readonly EngineId[] = CONFIGURATIONS.map((config) => config.engine);
    for (const engine of engines) {
      expect(["postgres", "sqlite"]).toContain(engineDialect(engine));
    }
  });
});

describe("configurationDialect", () => {
  test("reads the dialect off the Configuration's Engine", () => {
    expect(configurationDialect(configuration("pglite-memory"))).toBe("postgres");
    expect(configurationDialect(configuration("pglite-memory-unlogged"))).toBe("postgres");
    expect(configurationDialect(configuration("pglite-opfs-repacked-relaxed"))).toBe("postgres");
    expect(configurationDialect(configuration("pglite-opfs-repacked-strict"))).toBe("postgres");
    expect(configurationDialect(configuration("pgrust-memory"))).toBe("postgres");
    expect(configurationDialect(configuration("pgrust-memory-unlogged"))).toBe("postgres");
    expect(configurationDialect(configuration("wasqlite-memory"))).toBe("sqlite");
    expect(configurationDialect(configuration("wasqlite-memory-journal-off"))).toBe("sqlite");
  });
});

describe("pgliteOpenOptions", () => {
  test("hands PGlite its own settings and nothing else", () => {
    expect(pgliteOpenOptions({ relaxedDurability: true })).toEqual({ relaxedDurability: true });
    // Another Engine's key must not reach the PGlite constructor, nor turn into an empty object.
    expect(pgliteOpenOptions({ wasqlite: { journalMode: "off" } })).toBeUndefined();
    expect(pgliteOpenOptions({ pglite: { store: "opfs-repacked", durability: "strict" } })).toBeUndefined();
    expect(pgliteOpenOptions(undefined)).toBeUndefined();
  });
});

describe("pgliteStore", () => {
  test("reads the store settings of the two Storage Configurations", () => {
    expect(pgliteStore(configuration("pglite-opfs-repacked-relaxed").options)).toEqual({
      store: "opfs-repacked",
      durability: "relaxed",
    });
    expect(pgliteStore(configuration("pglite-opfs-repacked-strict").options)).toEqual({
      store: "opfs-repacked",
      durability: "strict",
    });
  });

  test("is undefined for every Configuration that opens no store", () => {
    for (const id of ["pglite-memory", "pglite-memory-unlogged", "pgrust-memory", "wasqlite-memory-journal-off"]) {
      expect(pgliteStore(configuration(id).options)).toBeUndefined();
    }
    expect(pgliteStore(undefined)).toBeUndefined();
    expect(pgliteStore({ relaxedDurability: true })).toBeUndefined();
  });
});
