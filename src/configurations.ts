/**
 * The phase-1 Configurations, in the order they appear as result columns.
 *
 * A Configuration is an Engine plus the storage and durability settings it is opened with. Phase 1 is
 * memory-only: the data directory lives in the worker's heap and is discarded when the worker ends.
 * The last column is the Reference Engine, wa-sqlite: it is there so the harness can be calibrated
 * against published numbers, and it is never the Baseline of a ratio.
 *
 * Every Configuration here is wired up; whether one can run in this browser is decided at runtime by
 * `configurationAvailability` (see `./engines/availability`).
 */

import type { Configuration, SqlDialect } from "./engines/contract";
import { configurationDialect } from "./engines/contract";

/** The column every ratio is taken against. */
export const BASELINE_CONFIGURATION_ID = "pglite-memory";

export const CONFIGURATIONS: readonly Configuration[] = [
  {
    id: BASELINE_CONFIGURATION_ID,
    label: "PGlite Memory",
    engine: "pglite",
    dataDir: "",
  },
  {
    id: "pglite-memory-unlogged",
    label: "PGlite Memory (unlogged)",
    engine: "pglite",
    dataDir: "",
    modSql: (sql) => sql.replace(/CREATE TABLE/g, "CREATE UNLOGGED TABLE"),
  },
  {
    id: "pgrust-memory",
    label: "pgrust Memory",
    engine: "pgrust",
    dataDir: "",
  },
  {
    // SQLite has no unlogged tables, so the `modSql` rewrite that gives PGlite a second column has
    // no counterpart here: one Configuration is the whole Reference Engine.
    id: "wasqlite-memory",
    label: "wa-sqlite Memory",
    engine: "wasqlite",
    dataDir: "",
  },
];

export function findConfiguration(id: string): Configuration | undefined {
  return CONFIGURATIONS.find((config) => config.id === id);
}

const BASELINE_CONFIGURATION = findConfiguration(BASELINE_CONFIGURATION_ID);

export const BASELINE_CONFIGURATION_LABEL = BASELINE_CONFIGURATION?.label ?? BASELINE_CONFIGURATION_ID;

/** The dialect a Suite's editable preamble is offered in: one textarea, seeded from the Baseline. */
export const BASELINE_CONFIGURATION_DIALECT: SqlDialect =
  BASELINE_CONFIGURATION === undefined ? "postgres" : configurationDialect(BASELINE_CONFIGURATION);
