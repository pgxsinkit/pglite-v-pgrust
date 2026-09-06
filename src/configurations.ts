/**
 * The phase-1 Configurations, in the order they appear as result columns.
 *
 * A Configuration is an Engine plus the storage and durability settings it is opened with. Six are
 * Memory Configurations — the data directory lives in the worker's heap and is discarded when the
 * worker ends — and each of the three Engines gets two of them: its default settings, and the least
 * durable settings it offers (unlogged tables for the two Postgres builds, journal mode `off` for
 * SQLite). The last two Memory columns are the Reference Engine, wa-sqlite: it is there so the
 * harness can be calibrated against published numbers, and it is never the Baseline of a ratio.
 *
 * The other two are Storage Configurations: PGlite on the `opfs-repacked` store, in each of that
 * store's two durability modes. They are the first columns whose data directory is real storage
 * rather than heap, which is the whole point of measuring them — but they still carry nothing
 * between Runs, because their worker empties the store's OPFS directory before it opens it.
 *
 * Every Configuration here is wired up; whether one can run in this browser is decided at runtime by
 * `configurationAvailability` (see `./engines/availability`).
 */

import type { Configuration, SqlDialect } from "./engines/contract";
import { configurationDialect } from "./engines/contract";
import { OPFS_DIRECTORY_PREFIX } from "./opfs";

/**
 * PGlite's own benchmark-page rewrite, shared by both Postgres builds' unlogged Configurations.
 *
 * It reaches every SQL string a Run executes, the untimed setup included — which is the only reason
 * an unlogged column differs from its logged twin at all, since that is where the tables are made.
 */
const UNLOGGED_TABLES = (sql: string): string => sql.replace(/CREATE TABLE/g, "CREATE UNLOGGED TABLE");

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
    modSql: UNLOGGED_TABLES,
  },
  {
    // The first Configuration whose data directory is not the worker's heap. `dataDir` is the OPFS
    // path the store owns in full; the worker removes and recreates it before every Run, so this
    // column measures a cold store on real storage rather than whatever an earlier Run left behind.
    id: "pglite-opfs-repacked-relaxed",
    label: "PGlite OPFS repacked (relaxed)",
    engine: "pglite",
    dataDir: `${OPFS_DIRECTORY_PREFIX}/opfs-repacked-relaxed`,
    options: { pglite: { store: "opfs-repacked", durability: "relaxed" } },
  },
  {
    // The same store under its other durability mode: every awaited host sync flushes arena data
    // before metadata, so a successful query has a stable strict boundary. The two columns differ
    // in nothing else — same Engine, same SQL, same store, one option.
    id: "pglite-opfs-repacked-strict",
    label: "PGlite OPFS repacked (strict)",
    engine: "pglite",
    dataDir: `${OPFS_DIRECTORY_PREFIX}/opfs-repacked-strict`,
    options: { pglite: { store: "opfs-repacked", durability: "strict" } },
  },
  {
    id: "pgrust-memory",
    label: "pgrust Memory",
    engine: "pgrust",
    dataDir: "",
  },
  {
    // The same rewrite as PGlite's unlogged column, on the other Postgres build: pgrust accepts
    // `CREATE UNLOGGED TABLE` and records the tables as unlogged (`relpersistence = 'u'`).
    id: "pgrust-memory-unlogged",
    label: "pgrust Memory (unlogged)",
    engine: "pgrust",
    dataDir: "",
    modSql: UNLOGGED_TABLES,
  },
  {
    id: "wasqlite-memory",
    label: "wa-sqlite Memory",
    engine: "wasqlite",
    dataDir: "",
  },
  {
    // SQLite has no unlogged tables, so the `modSql` rewrite that gives each Postgres build a
    // second column has no counterpart here. Its no-durability twin is a journal mode instead: the
    // rollback journal is switched off entirely, which is why this is an open option rather than a
    // SQL rewrite. The default wa-sqlite column above keeps SQLite's own default journal mode.
    id: "wasqlite-memory-journal-off",
    label: "wa-sqlite Memory (journal off)",
    engine: "wasqlite",
    dataDir: "",
    options: { wasqlite: { journalMode: "off" } },
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
