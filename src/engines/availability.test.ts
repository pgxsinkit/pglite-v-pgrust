import { describe, expect, test } from "bun:test";

import { CONFIGURATIONS, findConfiguration } from "../configurations";
import type { AvailabilityEnvironment } from "./availability";
import {
  configurationAvailability,
  configurationRequiresOpfsSyncAccess,
  engineRequiresJspi,
  engineRequiresSharedMemory,
  JSPI_REQUIREMENT_MESSAGE,
  OPFS_SYNC_ACCESS_REQUIREMENT_MESSAGE,
  SHARED_MEMORY_REQUIREMENT_MESSAGE,
} from "./availability";
import type { Configuration } from "./contract";

/** The corners of the capability space; every gate has to be right in all of them. */
const EVERYTHING: AvailabilityEnvironment = {
  jspiAvailable: true,
  crossOriginIsolated: true,
  opfsSyncAccessAvailable: true,
};
const WITHOUT_JSPI: AvailabilityEnvironment = { ...EVERYTHING, jspiAvailable: false };
const WITHOUT_ISOLATION: AvailabilityEnvironment = { ...EVERYTHING, crossOriginIsolated: false };
const WITHOUT_OPFS: AvailabilityEnvironment = { ...EVERYTHING, opfsSyncAccessAvailable: false };
const NOTHING: AvailabilityEnvironment = {
  jspiAvailable: false,
  crossOriginIsolated: false,
  opfsSyncAccessAvailable: false,
};

/** Every Configuration that opens a store on OPFS, whichever Engine reaches it. */
const OPFS_CONFIGURATION_IDS: readonly string[] = [
  "pglite-opfs-repacked-relaxed",
  "pglite-opfs-repacked-strict",
  "pgrust-threads-opfs-repacked-relaxed",
  "pgrust-threads-opfs-repacked-strict",
];

/** The two threads columns that need isolation and nothing else. */
const PGRUST_THREADS_MEMORY_CONFIGURATION_IDS: readonly string[] = [
  "pgrust-threads-memory",
  "pgrust-threads-memory-broker",
];

/** The two that need isolation AND a synchronous access handle. */
const PGRUST_THREADS_OPFS_CONFIGURATION_IDS: readonly string[] = [
  "pgrust-threads-opfs-repacked-relaxed",
  "pgrust-threads-opfs-repacked-strict",
];

const PGRUST_THREADS_CONFIGURATION_IDS: readonly string[] = [
  ...PGRUST_THREADS_MEMORY_CONFIGURATION_IDS,
  ...PGRUST_THREADS_OPFS_CONFIGURATION_IDS,
];

function configuration(id: string): Configuration {
  const found = findConfiguration(id);
  if (found === undefined) {
    throw new Error(`unknown Configuration "${id}"`);
  }
  return found;
}

describe("engineRequiresJspi", () => {
  test("is true for pgrust and false for PGlite and wa-sqlite", () => {
    expect(engineRequiresJspi("pgrust")).toBe(true);
    expect(engineRequiresJspi("pglite")).toBe(false);
    expect(engineRequiresJspi("wasqlite")).toBe(false);
  });

  // The whole point of the threads build: the guest's blocking read blocks a Worker instead of
  // suspending, so a browser without JSPI can still run it.
  test("is false for the threads build, which needs no JSPI at all", () => {
    expect(engineRequiresJspi("pgrust-threads")).toBe(false);
  });
});

describe("engineRequiresSharedMemory", () => {
  test("is true for the threads build and false for every other Engine", () => {
    expect(engineRequiresSharedMemory("pgrust-threads")).toBe(true);
    expect(engineRequiresSharedMemory("pgrust")).toBe(false);
    expect(engineRequiresSharedMemory("pglite")).toBe(false);
    expect(engineRequiresSharedMemory("wasqlite")).toBe(false);
  });

  test("gates no Engine on both capabilities: the two pgrust builds want opposite things", () => {
    const both = CONFIGURATIONS.filter(
      (config) => engineRequiresJspi(config.engine) && engineRequiresSharedMemory(config.engine),
    );
    expect(both).toEqual([]);
  });
});

describe("configurationRequiresOpfsSyncAccess", () => {
  test("is true for exactly the four Configurations that open a store on OPFS", () => {
    const requiring = CONFIGURATIONS.filter(configurationRequiresOpfsSyncAccess).map((config) => config.id);
    expect(requiring).toEqual([...OPFS_CONFIGURATION_IDS]);
  });

  test("is a Configuration's question, not an Engine's: the PGlite Memory columns need nothing", () => {
    expect(configurationRequiresOpfsSyncAccess(configuration("pglite-memory"))).toBe(false);
    expect(configurationRequiresOpfsSyncAccess(configuration("pglite-memory-unlogged"))).toBe(false);
    expect(configurationRequiresOpfsSyncAccess(configuration("pglite-opfs-repacked-relaxed"))).toBe(true);
  });

  // The same question of the same store on the other Engine: the broker on its memory port opens no
  // OPFS file, the same broker on its OPFS port opens four.
  test("separates the threads broker's two ports", () => {
    expect(configurationRequiresOpfsSyncAccess(configuration("pgrust-threads-memory"))).toBe(false);
    expect(configurationRequiresOpfsSyncAccess(configuration("pgrust-threads-memory-broker"))).toBe(false);
    expect(configurationRequiresOpfsSyncAccess(configuration("pgrust-threads-opfs-repacked-relaxed"))).toBe(true);
    expect(configurationRequiresOpfsSyncAccess(configuration("pgrust-threads-opfs-repacked-strict"))).toBe(true);
  });
});

describe("configurationAvailability", () => {
  test("makes every Configuration available where both capabilities exist", () => {
    for (const config of CONFIGURATIONS) {
      expect(configurationAvailability(config, EVERYTHING)).toEqual({ available: true });
    }
  });

  test("keeps the PGlite Memory Configurations available without either capability", () => {
    for (const id of ["pglite-memory", "pglite-memory-unlogged"]) {
      expect(configurationAvailability(configuration(id), NOTHING)).toEqual({ available: true });
    }
  });

  test("keeps both wa-sqlite Configurations available everywhere: they need nothing optional", () => {
    for (const id of ["wasqlite-memory", "wasqlite-memory-journal-off"]) {
      expect(configurationAvailability(configuration(id), NOTHING)).toEqual({ available: true });
      expect(configurationAvailability(configuration(id), EVERYTHING)).toEqual({ available: true });
    }
  });

  test("reports both pgrust Configurations unavailable without JSPI, naming the browsers that have it", () => {
    for (const id of ["pgrust-memory", "pgrust-memory-unlogged"]) {
      const availability = configurationAvailability(configuration(id), WITHOUT_JSPI);
      expect(availability.available).toBe(false);
      expect(availability.reason).toBe(JSPI_REQUIREMENT_MESSAGE);
      expect(availability.reason).toContain("Chrome ≥137");
      expect(availability.reason).toContain("Firefox ≥153");
    }
  });

  test("reports every pgrust Threads Configuration unavailable without isolation, naming both headers", () => {
    for (const id of PGRUST_THREADS_CONFIGURATION_IDS) {
      const availability = configurationAvailability(configuration(id), WITHOUT_ISOLATION);
      expect(availability.available).toBe(false);
      expect(availability.reason).toBe(SHARED_MEMORY_REQUIREMENT_MESSAGE);
      expect(availability.reason).toContain("Cross-Origin-Opener-Policy: same-origin");
      expect(availability.reason).toContain("Cross-Origin-Embedder-Policy: require-corp");
    }
  });

  test("leaves the pgrust Threads Configurations alone without JSPI, and the pgrust ones without isolation", () => {
    for (const id of PGRUST_THREADS_CONFIGURATION_IDS) {
      expect(configurationAvailability(configuration(id), WITHOUT_JSPI)).toEqual({ available: true });
    }
    for (const id of ["pgrust-memory", "pgrust-memory-unlogged"]) {
      expect(configurationAvailability(configuration(id), WITHOUT_ISOLATION)).toEqual({ available: true });
    }
  });

  test("reports every OPFS Configuration unavailable without a synchronous access handle", () => {
    for (const id of OPFS_CONFIGURATION_IDS) {
      const availability = configurationAvailability(configuration(id), WITHOUT_OPFS);
      expect(availability.available).toBe(false);
      expect(availability.reason).toBe(OPFS_SYNC_ACCESS_REQUIREMENT_MESSAGE);
      expect(availability.reason).toContain("dedicated worker");
    }
  });

  test("leaves the OPFS Configurations alone when only JSPI is missing, and pgrust alone when only OPFS is", () => {
    for (const id of OPFS_CONFIGURATION_IDS) {
      expect(configurationAvailability(configuration(id), WITHOUT_JSPI)).toEqual({ available: true });
    }
    for (const id of ["pgrust-memory", "pgrust-memory-unlogged", ...PGRUST_THREADS_MEMORY_CONFIGURATION_IDS]) {
      expect(configurationAvailability(configuration(id), WITHOUT_OPFS)).toEqual({ available: true });
    }
  });

  // The two capabilities the threads OPFS columns need are asked in one order, and a browser with
  // neither is told about the one that stops the Engine existing at all rather than the one that
  // stops its store opening.
  test("names isolation first for a threads OPFS column that is missing both capabilities", () => {
    for (const id of PGRUST_THREADS_OPFS_CONFIGURATION_IDS) {
      expect(configurationAvailability(configuration(id), NOTHING).reason).toBe(SHARED_MEMORY_REQUIREMENT_MESSAGE);
      expect(configurationAvailability(configuration(id), WITHOUT_ISOLATION).reason).toBe(
        SHARED_MEMORY_REQUIREMENT_MESSAGE,
      );
      expect(configurationAvailability(configuration(id), WITHOUT_OPFS).reason).toBe(
        OPFS_SYNC_ACCESS_REQUIREMENT_MESSAGE,
      );
    }
  });
});
