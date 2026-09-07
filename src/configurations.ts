/**
 * The Configurations, in the order they appear as result columns.
 *
 * A Configuration is an Engine plus the storage and durability settings it is opened with. Nine are
 * Memory Configurations — the data directory lives in the worker's heap and is discarded when the
 * worker ends. For PGlite, pgrust and wa-sqlite the pair is the Engine's default settings and the
 * least durable settings it offers (unlogged tables for the two single-session Postgres builds,
 * journal mode `off` for SQLite); for the pgrust threads build the pair is its two filesystem seams
 * instead, because that is the choice that build makes, and the postmaster has one, on the seam it
 * cannot do without. Two of those Memory columns are the Reference Engine, wa-sqlite: it is there so
 * the harness can be calibrated against published numbers, and it is never the Baseline of a ratio.
 *
 * The other five are Storage Configurations, and they are one store several times over: the
 * `opfs-repacked` store reached through PGlite's own filesystem (both durability modes), through the
 * threads build's broker coordinator (both durability modes), and through the same coordinator under
 * a real postmaster. Their data directory is real storage rather than heap, which is the whole point
 * of measuring them — but they still carry nothing between Runs, because their worker empties the
 * store's OPFS directory before it opens it and removes it after.
 *
 * Every Configuration here is wired up; whether one can run in this browser is decided at runtime by
 * `configurationAvailability` (see `./engines/availability`), and which of them a given Run actually
 * compares — and which of those is the Baseline — is decided by the reader or by a URL (see
 * `./configuration-selection`). The order below is the column order in every case.
 */

import type { Configuration, EngineId, SqlDialect } from "./engines/contract";
import { configurationDialect } from "./engines/contract";
import { OPFS_DIRECTORY_PREFIX, opfsOwnedRootDirectory } from "./opfs";

/**
 * PGlite's own benchmark-page rewrite, shared by both Postgres builds' unlogged Configurations.
 *
 * It reaches every SQL string a Run executes, the untimed setup included — which is the only reason
 * an unlogged column differs from its logged twin at all, since that is where the tables are made.
 */
const UNLOGGED_TABLES = (sql: string): string => sql.replace(/CREATE TABLE/g, "CREATE UNLOGGED TABLE");

/** The column every ratio is taken against, unless a Run chooses another one. */
export const BASELINE_CONFIGURATION_ID = "pglite-memory";

/**
 * The Reference Engine: present so the harness can be calibrated against published numbers, and
 * never the Baseline of a ratio. Its columns are the one thing the Baseline chooser will not offer.
 */
export const REFERENCE_ENGINE: EngineId = "wasqlite";

/** Why the Reference Engine's Baseline radio is greyed out. */
export const REFERENCE_ENGINE_BASELINE_REASON =
  "The Reference Engine is here to calibrate the harness against published numbers, and is never " +
  "the Baseline of a ratio";

/** Whether a Configuration may be the column every other one is measured against. */
export function canBeBaseline(configuration: Configuration): boolean {
  return configuration.engine !== REFERENCE_ENGINE;
}

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
    // The same pgrust commit, built for wasm32-wasip1-threads instead. Real threads, no JSPI, and a
    // cross-origin isolated page — the guest's blocking stdin read blocks a Worker in
    // `Atomics.wait` rather than suspending. `copy` is the host's own default: this instance's
    // filesystem is its own copy of the packed image, which is what a single session on a single
    // spawned thread needs.
    id: "pgrust-threads-memory",
    label: "pgrust Threads Memory",
    engine: "pgrust-threads",
    dataDir: "",
    options: { pgrustThreads: { fs: "copy" } },
  },
  {
    // The same threads Engine with its filesystem moved: one repacked store in a dedicated
    // coordinator worker that every instance reaches over a SharedArrayBuffer channel, instead of a
    // private copy of the image per worker. The store is still in memory and still dies with its
    // worker, so this is a Memory Configuration too — the pair measures the broker seam and nothing
    // else.
    //
    // The label says `pre-release store` because it is: the broker and the WASI adapter this column
    // loads exist in no published `@pgxsinkit/pglite-opfs-repacked`, so the bundle is copied out of
    // a pgxsinkit checkout by `bun run sync:pgrust` and recorded in `src/vendor/pgrust/SOURCE.md`.
    // The two `PGlite OPFS repacked` columns are a different thing entirely: they run the published
    // package this repo depends on.
    id: "pgrust-threads-memory-broker",
    label: "pgrust Threads Memory (broker, pre-release store)",
    engine: "pgrust-threads",
    dataDir: "",
    options: { pgrustThreads: { fs: "broker" } },
  },
  {
    // The broker column's store moved off the coordinator's heap and onto OPFS: the same four
    // exclusively owned files the two `PGlite OPFS repacked` columns run on, reached through the
    // coordinator worker rather than through PGlite. That makes this a Storage Configuration, and
    // `dataDir` the OPFS directory the coordinator owns in full.
    //
    // A root-level directory, not one under `pglite-v-pgrust/`: the vendored coordinator takes a
    // single `opfsDir` name and resolves it with one `root.getDirectoryHandle(name)`, which rejects
    // a name containing `/` in both browsers (see `opfsOwnedRootDirectory`). The name carries this
    // app's prefix instead, and the Run empties the directory before it opens and removes it after.
    id: "pgrust-threads-opfs-repacked-relaxed",
    label: "pgrust Threads OPFS repacked (relaxed, pre-release store)",
    engine: "pgrust-threads",
    dataDir: opfsOwnedRootDirectory("threads-opfs-repacked-relaxed"),
    options: { pgrustThreads: { fs: "broker", port: "opfs", durability: "relaxed" } },
  },
  {
    // The same store under its other durability mode. Strict is the coordinator's own reading of
    // what the package's PGlite adapter does: every mutating broker request is followed by a
    // store-wide `strictSync()`, arena before metadata, because a postmaster offers no awaited host
    // sync to hang one off. One option apart from the column above, exactly as with PGlite's pair.
    id: "pgrust-threads-opfs-repacked-strict",
    label: "pgrust Threads OPFS repacked (strict, pre-release store)",
    engine: "pgrust-threads",
    dataDir: opfsOwnedRootDirectory("threads-opfs-repacked-strict"),
    options: { pgrustThreads: { fs: "broker", port: "opfs", durability: "strict" } },
  },
  {
    // The same wasm module as the four columns above, driven as a real `PostmasterMain` over
    // host-pipe file descriptors instead of as one `--stdio-wire-threaded` session: a postmaster,
    // its auxiliary processes and one backend thread per session, all sharing one shared memory and
    // one filesystem. The filesystem has to be the broker's — the checkpointer is its own guest
    // thread and could see nothing a backend wrote if every thread had its own copy of the image —
    // so this pair is the broker seam's third and fourth column and loads the same pre-release store.
    //
    // On the memory port nothing leaves the coordinator's heap, so this is a Memory Configuration
    // and the twin of `pgrust Threads Memory (broker, pre-release store)`: same commit, same store,
    // same port, one postmaster instead of one session.
    id: "pgrust-postmaster-memory-broker",
    label: "pgrust Postmaster Memory (broker, pre-release store)",
    engine: "pgrust-postmaster",
    dataDir: "",
    options: { pgrustPostmaster: { port: "memory", durability: "relaxed" } },
  },
  {
    // The postmaster's store on OPFS: the same four exclusively owned files the other OPFS repacked
    // columns run on, in the coordinator's own root-level directory, at `relaxed` durability. A
    // Storage Configuration, emptied before the Run and removed after it like every other one.
    id: "pgrust-postmaster-opfs-repacked-relaxed",
    label: "pgrust Postmaster OPFS repacked (relaxed, pre-release store)",
    engine: "pgrust-postmaster",
    dataDir: opfsOwnedRootDirectory("postmaster-opfs-repacked-relaxed"),
    options: { pgrustPostmaster: { port: "opfs", durability: "relaxed" } },
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

/** Every Configuration id, in column order: what a `?configurations=` list is resolved against. */
export const CONFIGURATION_IDS: readonly string[] = CONFIGURATIONS.map((config) => config.id);

/** The Configurations a ratio may be taken against, in column order. */
export const BASELINE_CANDIDATE_IDS: readonly string[] = CONFIGURATIONS.filter(canBeBaseline).map(
  (config) => config.id,
);

const BASELINE_CONFIGURATION = findConfiguration(BASELINE_CONFIGURATION_ID);

export const BASELINE_CONFIGURATION_LABEL = BASELINE_CONFIGURATION?.label ?? BASELINE_CONFIGURATION_ID;

/** The dialect a Suite's editable preamble is offered in: one textarea, seeded from the Baseline. */
export const BASELINE_CONFIGURATION_DIALECT: SqlDialect =
  BASELINE_CONFIGURATION === undefined ? "postgres" : configurationDialect(BASELINE_CONFIGURATION);
