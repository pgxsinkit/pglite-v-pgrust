/**
 * The phase-1 Configurations, in the order they appear as result columns.
 *
 * A Configuration is an Engine plus the storage and durability settings it is opened with. Phase 1 is
 * memory-only: the data directory lives in the worker's heap and is discarded when the worker ends.
 */

import type { Configuration } from "./engines/contract";

/** The column every ratio is taken against. */
export const BASELINE_CONFIGURATION_ID = "pglite-memory";

export const CONFIGURATIONS: readonly Configuration[] = [
  {
    id: BASELINE_CONFIGURATION_ID,
    label: "PGlite Memory",
    engine: "pglite",
    dataDir: "",
    available: true,
  },
  {
    id: "pglite-memory-unlogged",
    label: "PGlite Memory (unlogged)",
    engine: "pglite",
    dataDir: "",
    modSql: (sql) => sql.replace(/CREATE TABLE/g, "CREATE UNLOGGED TABLE"),
    available: true,
  },
  {
    id: "pgrust-memory",
    label: "pgrust Memory",
    engine: "pgrust",
    dataDir: "",
    available: false,
    unavailableReason: "pgrust engine not wired yet",
  },
];

export function findConfiguration(id: string): Configuration | undefined {
  return CONFIGURATIONS.find((config) => config.id === id);
}

export const BASELINE_CONFIGURATION_LABEL =
  findConfiguration(BASELINE_CONFIGURATION_ID)?.label ?? BASELINE_CONFIGURATION_ID;
