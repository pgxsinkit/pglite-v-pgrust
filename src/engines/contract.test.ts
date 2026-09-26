import { describe, expect, test } from "bun:test";

import { BROKER_SPIN_DEFAULT_US } from "../broker-switches";
import { CONFIGURATIONS, findConfiguration } from "../configurations";
import type { Configuration, EngineId } from "./contract";
import {
  configurationDialect,
  engineDialect,
  pgliteOpenOptions,
  pgliteStore,
  pgrustThreadsOpensOpfsStore,
  pgrustThreadsOptions,
} from "./contract";

function configuration(id: string): Configuration {
  const found = findConfiguration(id);
  if (found === undefined) {
    throw new Error(`unknown Configuration "${id}"`);
  }
  return found;
}

describe("engineDialect", () => {
  test("puts all three Postgres builds in the postgres dialect and wa-sqlite in the sqlite one", () => {
    expect(engineDialect("pglite")).toBe("postgres");
    expect(engineDialect("pgrust")).toBe("postgres");
    expect(engineDialect("pgrust-threads")).toBe("postgres");
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
    expect(configurationDialect(configuration("pgrust-threads-memory"))).toBe("postgres");
    expect(configurationDialect(configuration("pgrust-threads-memory-broker"))).toBe("postgres");
    expect(configurationDialect(configuration("pgrust-threads-opfs-repacked-relaxed"))).toBe("postgres");
    expect(configurationDialect(configuration("pgrust-threads-opfs-repacked-strict"))).toBe("postgres");
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
    expect(pgliteOpenOptions({ pgrustThreads: { fs: "broker" } })).toBeUndefined();
    expect(pgliteOpenOptions(undefined)).toBeUndefined();
  });
});

describe("pgrustThreadsOptions", () => {
  test("reads the filesystem seam, the port and the durability of the four threads Configurations", () => {
    // The three broker columns carry the default spin before parking; the copy seam has no broker.
    const brokerSpinUs = BROKER_SPIN_DEFAULT_US;
    expect(pgrustThreadsOptions(configuration("pgrust-threads-memory").options)).toEqual({ fs: "copy" });
    expect(pgrustThreadsOptions(configuration("pgrust-threads-memory-broker").options)).toEqual({
      fs: "broker",
      brokerSpinUs,
    });
    expect(pgrustThreadsOptions(configuration("pgrust-threads-opfs-repacked-relaxed").options)).toEqual({
      fs: "broker",
      port: "opfs",
      durability: "relaxed",
      brokerSpinUs,
    });
    expect(pgrustThreadsOptions(configuration("pgrust-threads-opfs-repacked-strict").options)).toEqual({
      fs: "broker",
      port: "opfs",
      durability: "strict",
      brokerSpinUs,
    });
  });

  test("is undefined for every Configuration on another Engine, and for another Engine's key", () => {
    for (const id of ["pglite-memory", "pgrust-memory", "pglite-opfs-repacked-strict", "wasqlite-memory"]) {
      expect(pgrustThreadsOptions(configuration(id).options)).toBeUndefined();
    }
    expect(pgrustThreadsOptions(undefined)).toBeUndefined();
    expect(pgrustThreadsOptions({ wasqlite: { journalMode: "off" } })).toBeUndefined();
  });
});

describe("pgrustThreadsOpensOpfsStore", () => {
  test("is true for exactly the two threads columns whose store is on OPFS", () => {
    expect(pgrustThreadsOpensOpfsStore(configuration("pgrust-threads-opfs-repacked-relaxed").options)).toBe(true);
    expect(pgrustThreadsOpensOpfsStore(configuration("pgrust-threads-opfs-repacked-strict").options)).toBe(true);
    // The broker seam alone is not a store on OPFS: on the memory port it opens no file at all.
    expect(pgrustThreadsOpensOpfsStore(configuration("pgrust-threads-memory-broker").options)).toBe(false);
    expect(pgrustThreadsOpensOpfsStore(configuration("pgrust-threads-memory").options)).toBe(false);
  });

  test("is false for every other Engine, PGlite's own OPFS columns included", () => {
    for (const id of ["pglite-memory", "pglite-opfs-repacked-strict", "pgrust-memory", "wasqlite-memory"]) {
      expect(pgrustThreadsOpensOpfsStore(configuration(id).options)).toBe(false);
    }
    expect(pgrustThreadsOpensOpfsStore(undefined)).toBe(false);
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
    for (const id of [
      "pglite-memory",
      "pglite-memory-unlogged",
      "pgrust-memory",
      "pgrust-threads-memory",
      "pgrust-threads-memory-broker",
      // A store, but not one PGlite opens: this key is the PGlite constructor's and nothing else's.
      "pgrust-threads-opfs-repacked-relaxed",
      "pgrust-threads-opfs-repacked-strict",
      "wasqlite-memory-journal-off",
    ]) {
      expect(pgliteStore(configuration(id).options)).toBeUndefined();
    }
    expect(pgliteStore(undefined)).toBeUndefined();
    expect(pgliteStore({ relaxedDurability: true })).toBeUndefined();
  });
});
