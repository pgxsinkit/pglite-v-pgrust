/**
 * The Engine seam.
 *
 * An Engine is one of the WebAssembly databases under comparison. Everything the benchmark app
 * knows about an Engine is expressed here, so adding another Engine stays additive: a new worker
 * module plus a new entry in `engineWorkerFactories`. Whether a Configuration can run in this
 * browser is not stored here — it is computed at runtime in `./availability`.
 */

/**
 * The WebAssembly databases under comparison. `pglite` and the two pgrust builds are the subjects;
 * `wasqlite` is the Reference Engine, present only so the numbers can be calibrated against
 * published ones.
 *
 * `pgrust` and `pgrust-threads` are one pgrust commit built for two targets, and they are separate
 * Engines rather than one Engine with an option because nothing they share survives the boundary:
 * different wasm module, different host JS, different blocking primitive (JSPI versus
 * `Atomics.wait`), different browser requirement. A Configuration picks one of them, and the
 * availability gate asks each a different question.
 */
export type EngineId = "pglite" | "pgrust" | "pgrust-threads" | "wasqlite";

/**
 * The SQL dialect an Engine speaks. The Benchmarks themselves are dialect-neutral; only a Suite's
 * untimed initial setup differs, which is why the knob lives on the Engine and is read by the Suite
 * (`Suite.initialSetupFor`) rather than by anything inside the Measurement window.
 */
export type SqlDialect = "postgres" | "sqlite";

const ENGINE_DIALECTS: Readonly<Record<EngineId, SqlDialect>> = {
  pglite: "postgres",
  pgrust: "postgres",
  "pgrust-threads": "postgres",
  wasqlite: "sqlite",
};

export function engineDialect(engine: EngineId): SqlDialect {
  return ENGINE_DIALECTS[engine];
}

/** The wall time, taken inside the Engine's worker, of handing one SQL string to the Engine. */
export interface Measurement {
  readonly elapsedMs: number;
}

/** The open settings the PGlite constructor understands, and the only ones handed to it. */
export interface PgliteOpenOptions {
  readonly relaxedDurability?: boolean;
}

/**
 * wa-sqlite's own open settings, applied by its worker between `open_v2` and the untimed setup.
 *
 * `journalMode` is a literal rather than a string because the harness offers exactly one
 * non-default journal mode: `off`, SQLite's no-durability twin of an unlogged Postgres table.
 */
export interface WasqliteOpenOptions {
  readonly journalMode: "off";
}

/**
 * Where the pgrust threads guest's data directory lives.
 *
 * `copy` is the host's own default: every worker builds its own VFS from its own copy of the packed
 * image, which is enough for one session on one thread. `broker` puts a single
 * `@pgxsinkit/pglite-opfs-repacked` store in a dedicated coordinator worker that every instance
 * reaches over a `SharedArrayBuffer` channel, so all of them see one filesystem. Both keep the data
 * directory in memory and both die with their workers, so both are Memory Configurations.
 */
export type PgrustThreadsFs = "copy" | "broker";

/**
 * pgrust's threads-build settings, applied by its worker when it starts the guest.
 *
 * One knob, because one is what distinguishes the two threads columns: everything else — the same
 * wasm module, the same argv, the same pool size — is held identical so the pair measures the
 * filesystem seam and nothing else.
 */
export interface PgrustThreadsOpenOptions {
  readonly fs: PgrustThreadsFs;
}

/**
 * A storage backend PGlite's data directory can be opened through instead of its own filesystems.
 *
 * One so far: `opfs-repacked` is `@pgxsinkit/pglite-opfs-repacked`, which packs a whole data
 * directory into four exclusively owned OPFS files.
 */
export type PgliteStoreId = "opfs-repacked";

/**
 * A store's physical durability, chosen once when the store is opened and never changed after.
 *
 * `relaxed` skips the per-query strict sequence and amortizes flushes; `strict` flushes arena data
 * before metadata on every awaited host sync, so a successful query has a stable boundary. These are
 * the store's own two modes, not PGlite's `relaxedDurability` boolean, which the store owns.
 */
export type StoreDurability = "relaxed" | "strict";

/**
 * PGlite's own store settings: which storage backend to open the data directory through, and how
 * durably. Both fields travel together because a store without a durability has no defined
 * behaviour to report and a durability without a store has nothing to apply to.
 */
export interface PgliteStoreSettings {
  readonly store: PgliteStoreId;
  readonly durability: StoreDurability;
}

/**
 * Engine-open settings that are structured-cloneable and therefore safe to send to the worker.
 *
 * Engine-specific settings live under their Engine's key rather than in one flat bag, so a
 * Configuration cannot quietly hand wa-sqlite a PGlite knob (or the other way round) and each
 * worker reads a shape it can type. `relaxedDurability` is the exception, and deliberately so: it
 * is a Postgres-level durability request that both Postgres builds are asked about — PGlite honours
 * it, the pgrust worker rejects it — so it is not any single Engine's key.
 */
export interface EngineOpenOptions {
  readonly relaxedDurability?: boolean;
  readonly pglite?: PgliteStoreSettings;
  readonly pgrustThreads?: PgrustThreadsOpenOptions;
  readonly wasqlite?: WasqliteOpenOptions;
}

/** The PGlite-shaped subset of the open settings; `undefined` when there is nothing to pass. */
export function pgliteOpenOptions(options: EngineOpenOptions | undefined): PgliteOpenOptions | undefined {
  return options?.relaxedDurability === undefined ? undefined : { relaxedDurability: options.relaxedDurability };
}

/**
 * The store this Configuration opens PGlite through, or `undefined` for PGlite's own filesystem.
 *
 * The one call site that decides between `new PGlite(dataDir, …)` and the store factory, and the one
 * the availability gate asks — a store needs an OPFS synchronous access handle, which not every
 * browser grants.
 */
export function pgliteStore(options: EngineOpenOptions | undefined): PgliteStoreSettings | undefined {
  return options?.pglite;
}

/**
 * The threads-build settings this Configuration opens pgrust with, or `undefined` for the host's
 * own default (`copy`). Read only by the `pgrust-threads` worker.
 */
export function pgrustThreadsOptions(options: EngineOpenOptions | undefined): PgrustThreadsOpenOptions | undefined {
  return options?.pgrustThreads;
}

/** An Engine plus the storage and durability settings it is opened with. One column of results. */
export interface Configuration {
  readonly id: string;
  readonly label: string;
  readonly engine: EngineId;
  /**
   * Empty string means the Memory Configuration: the data directory lives in the worker's heap.
   *
   * For a Storage Configuration it names the directory the store owns in full — an OPFS path for
   * `options.pglite.store`, which the worker empties before every Run so no state survives one.
   */
  readonly dataDir: string;
  readonly options?: EngineOpenOptions;
  /**
   * Applied on the main thread to every SQL string a Run executes — the untimed setup as well as
   * every Benchmark — before it is handed to the worker, so the rewrite never lands inside the
   * Measurement window. The setup matters most: an unlogged Configuration whose `CREATE TABLE`s
   * were left alone would be the logged Configuration under a different name.
   */
  readonly modSql?: (sql: string) => string;
}

/**
 * A main-thread handle on one Engine instance living in its own dedicated module worker.
 *
 * `measure` returns the time taken inside the worker around the Engine call alone: the main<->worker
 * messaging is deliberately outside the window.
 */
export interface EngineRunner {
  /** Boot a fresh Engine for `config`, then run `preamble` (untimed) if it is non-empty. */
  open(config: Configuration, preamble: string): Promise<void>;
  /** Execute one SQL string and return its Measurement. */
  measure(sql: string): Promise<Measurement>;
  /** Tear the Engine and its worker down. Safe to call more than once. */
  close(): Promise<void>;
}

/** Narrow a Configuration to the settings that can cross the worker boundary. */
export function toOpenSettings(config: Configuration): { dataDir: string; options?: EngineOpenOptions } {
  return config.options === undefined
    ? { dataDir: config.dataDir }
    : { dataDir: config.dataDir, options: config.options };
}

/** Apply a Configuration's SQL rewrite, if it has one. */
export function applyModSql(config: Configuration, sql: string): string {
  return config.modSql ? config.modSql(sql) : sql;
}

/** The dialect this Configuration's Engine speaks. */
export function configurationDialect(config: Configuration): SqlDialect {
  return engineDialect(config.engine);
}
