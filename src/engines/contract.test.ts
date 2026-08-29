import { describe, expect, test } from "bun:test";

import { CONFIGURATIONS, findConfiguration } from "../configurations";
import type { Configuration, EngineId } from "./contract";
import { configurationDialect, engineDialect } from "./contract";

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
    expect(configurationDialect(configuration("pgrust-memory"))).toBe("postgres");
    expect(configurationDialect(configuration("wasqlite-memory"))).toBe("sqlite");
  });
});
