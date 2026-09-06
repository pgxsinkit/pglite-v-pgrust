import { describe, expect, test } from "bun:test";

import { CONFIGURATIONS, findConfiguration } from "../configurations";
import type { AvailabilityEnvironment } from "./availability";
import {
  configurationAvailability,
  configurationRequiresOpfsSyncAccess,
  engineRequiresJspi,
  JSPI_REQUIREMENT_MESSAGE,
  OPFS_SYNC_ACCESS_REQUIREMENT_MESSAGE,
} from "./availability";
import type { Configuration } from "./contract";

/** The four corners of the capability space; every gate has to be right in all of them. */
const EVERYTHING: AvailabilityEnvironment = { jspiAvailable: true, opfsSyncAccessAvailable: true };
const WITHOUT_JSPI: AvailabilityEnvironment = { jspiAvailable: false, opfsSyncAccessAvailable: true };
const WITHOUT_OPFS: AvailabilityEnvironment = { jspiAvailable: true, opfsSyncAccessAvailable: false };
const NOTHING: AvailabilityEnvironment = { jspiAvailable: false, opfsSyncAccessAvailable: false };

const OPFS_CONFIGURATION_IDS: readonly string[] = ["pglite-opfs-repacked-relaxed", "pglite-opfs-repacked-strict"];

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
});

describe("configurationRequiresOpfsSyncAccess", () => {
  test("is true for exactly the two Configurations that open a store", () => {
    const requiring = CONFIGURATIONS.filter(configurationRequiresOpfsSyncAccess).map((config) => config.id);
    expect(requiring).toEqual([...OPFS_CONFIGURATION_IDS]);
  });

  test("is a Configuration's question, not an Engine's: the PGlite Memory columns need nothing", () => {
    expect(configurationRequiresOpfsSyncAccess(configuration("pglite-memory"))).toBe(false);
    expect(configurationRequiresOpfsSyncAccess(configuration("pglite-memory-unlogged"))).toBe(false);
    expect(configurationRequiresOpfsSyncAccess(configuration("pglite-opfs-repacked-relaxed"))).toBe(true);
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

  test("reports both OPFS Configurations unavailable without a synchronous access handle", () => {
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
    for (const id of ["pgrust-memory", "pgrust-memory-unlogged"]) {
      expect(configurationAvailability(configuration(id), WITHOUT_OPFS)).toEqual({ available: true });
    }
  });
});
