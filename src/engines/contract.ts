/**
 * The Engine seam.
 *
 * An Engine is one of the WebAssembly Postgres builds under comparison. Everything the benchmark
 * app knows about an Engine is expressed here, so adding a second Engine (pgrust) is purely
 * additive: a new worker module plus a new entry in `engineWorkerFactories`.
 */

/** The WebAssembly Postgres builds under comparison. */
export type EngineId = "pglite" | "pgrust";

/** The wall time, taken inside the Engine's worker, of handing one SQL string to the Engine. */
export interface Measurement {
  readonly elapsedMs: number;
}

/** Engine-open settings that are structured-cloneable and therefore safe to send to the worker. */
export interface EngineOpenOptions {
  readonly relaxedDurability?: boolean;
}

/** An Engine plus the storage and durability settings it is opened with. One column of results. */
export interface Configuration {
  readonly id: string;
  readonly label: string;
  readonly engine: EngineId;
  /** Empty string means the Memory Configuration: the data directory lives in the worker's heap. */
  readonly dataDir: string;
  readonly options?: EngineOpenOptions;
  /**
   * Applied on the main thread to every Benchmark's SQL before it is handed to the worker, so the
   * rewrite never lands inside the Measurement window.
   */
  readonly modSql?: (sql: string) => string;
  /** False when the Engine is not wired up yet; the column is rendered skipped rather than run. */
  readonly available: boolean;
  /** Present only when `available` is false. */
  readonly unavailableReason?: string;
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
