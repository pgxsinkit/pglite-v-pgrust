import { describe, expect, test } from "bun:test";

import { CONFIGURATIONS, findConfiguration } from "../configurations";
import { configurationAvailability, engineRequiresJspi, JSPI_REQUIREMENT_MESSAGE } from "./availability";
import type { Configuration } from "./contract";

const WITH_JSPI = { jspiAvailable: true };
const WITHOUT_JSPI = { jspiAvailable: false };

function configuration(id: string): Configuration {
  const found = findConfiguration(id);
  if (found === undefined) {
    throw new Error(`unknown Configuration "${id}"`);
  }
  return found;
}

describe("engineRequiresJspi", () => {
  test("is true for pgrust and false for PGlite", () => {
    expect(engineRequiresJspi("pgrust")).toBe(true);
    expect(engineRequiresJspi("pglite")).toBe(false);
  });
});

describe("configurationAvailability", () => {
  test("makes every Configuration available where JSPI exists", () => {
    for (const config of CONFIGURATIONS) {
      expect(configurationAvailability(config, WITH_JSPI)).toEqual({ available: true });
    }
  });

  test("keeps the PGlite Configurations available without JSPI", () => {
    expect(configurationAvailability(configuration("pglite-memory"), WITHOUT_JSPI).available).toBe(true);
    expect(configurationAvailability(configuration("pglite-memory-unlogged"), WITHOUT_JSPI).available).toBe(true);
  });

  test("reports pgrust unavailable without JSPI, naming the browsers that have it", () => {
    const availability = configurationAvailability(configuration("pgrust-memory"), WITHOUT_JSPI);
    expect(availability.available).toBe(false);
    expect(availability.reason).toBe(JSPI_REQUIREMENT_MESSAGE);
    expect(availability.reason).toContain("Chrome ≥137");
    expect(availability.reason).toContain("Firefox ≥153");
  });
});
