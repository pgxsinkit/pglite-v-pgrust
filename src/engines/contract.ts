/**
 * The Engine seam.
 *
 * An Engine is one of the WebAssembly databases under comparison. Everything the benchmark app
 * knows about an Engine is expressed here, so adding another Engine stays additive: a new worker
 * module plus a new entry in `engineWorkerFactories`. Whether a Configuration can run in this
 * browser is not stored here — it is computed at runtime in `./availability`.
 */

import type { EngineStats } from "./protocol";
import type { ConcurrentScenario, ScenarioReport } from "./scenario";

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
 *
 * `pgrust-postmaster` is the same wasm module as `pgrust-threads` driven a different way: a real
 * `PostmasterMain` over host-pipe file descriptors, with one backend thread per session, instead of
 * one `--stdio-wire-threaded` session on fds 0/1. It is a separate Engine because what it can be
 * asked is different in kind — several sessions at once, on several real backends — and because its
 * boot, its pool size and its shutdown are the postmaster's rather than a session's.
 */
export type EngineId = "pglite" | "pgrust" | "pgrust-threads" | "pgrust-postmaster" | "wasqlite";

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
  "pgrust-postmaster": "postgres",
  wasqlite: "sqlite",
};

export function engineDialect(engine: EngineId): SqlDialect {
  return ENGINE_DIALECTS[engine];
}

/**
 * What one row of one column carries in it.
 *
 * The number in the cell is `elapsedMs`, and for the two single-statement Suites that is all there
 * is: the wall time, taken inside the Engine's worker, of handing one SQL string to the Engine.
 *
 * `detail` exists for a Benchmark whose one number cannot say what happened — a Concurrency
 * Benchmark reports a percentile or a rate in the cell, and the per-Client spread, the statement
 * counts and the SQLSTATEs behind it belong beside it rather than in a second table. It is rendered
 * under the table in the Markdown export and under the row in the page, never inside the cell.
 */
export interface Measurement {
  readonly elapsedMs: number;
  readonly detail?: MeasurementDetail;
}

/** A Measurement's supporting numbers, in the order they should be read. Keys carry their own units. */
export type MeasurementDetail = Readonly<Record<string, number | string>>;

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
 * Where the one store behind the broker seam lives.
 *
 * `memory` keeps it in the coordinator worker's heap, so it dies with that worker and the column
 * stays a Memory Configuration. `opfs` puts it in one dedicated OPFS directory the coordinator owns
 * in full — the same four exclusively owned files the `PGlite OPFS repacked` columns run on, reached
 * through the coordinator instead of through PGlite — which makes the column a Storage Configuration
 * and makes an OPFS synchronous access handle a requirement. Only meaningful with `fs: "broker"`:
 * the copy seam has no store and no coordinator to hold one.
 */
export type PgrustThreadsPort = "memory" | "opfs";

/**
 * pgrust's threads-build settings, applied by its worker when it starts the guest.
 *
 * Three knobs, and every one of them is a difference between two threads columns: the filesystem
 * seam (`copy` against `broker`), the port the broker's store sits on (`memory` against `opfs`) and
 * that store's durability. Everything else — the same wasm module, the same argv, the same pool
 * size — is held identical, so a pair of columns measures the knob that differs and nothing else.
 *
 * `port` and `durability` are optional because the two Memory columns predate them and mean exactly
 * what their absence says: the host's own default, a store in the coordinator's heap.
 */
export interface PgrustThreadsOpenOptions {
  readonly fs: PgrustThreadsFs;
  readonly port?: PgrustThreadsPort;
  readonly durability?: StoreDurability;
}

/**
 * The postmaster Engine's settings: where its one store lives, and how durably.
 *
 * There is no `fs` knob, and deliberately so. A postmaster is not one session: its checkpointer,
 * background writer and every backend are separate guest threads, and on the copy seam each of them
 * would build its own filesystem out of its own copy of the packed image — so the checkpointer could
 * not see a relation file a backend had just created. The broker seam, where one store lives in a
 * coordinator worker every instance reaches over a `SharedArrayBuffer` channel, is what makes the
 * postmaster lane a single Postgres rather than N private ones, and it is therefore not optional.
 *
 * How many sessions to open is not here either: that is the Suite's question, not the
 * Configuration's, and it travels as `EngineOpenOptions.sessions`.
 */
export interface PgrustPostmasterOpenOptions {
  readonly port?: PgrustThreadsPort;
  readonly durability?: StoreDurability;
  /**
   * Extra `name=value` settings, each appended to the postmaster's argv as `-c name=value`.
   *
   * No Configuration sets any of its own: the fourteen columns must all run the same server, or
   * their numbers are not comparable. It exists for `scripts/probe-idle-cpu.ts`, which asks what an
   * idle server costs with its background writer, WAL writer and checkpointer turned down — the only
   * honest way to ask that is to start the same Engine twice with two argvs — and for the
   * `?postmasterTuning=` URL (see `src/postmaster-tuning.ts`), which asks the same kind of question
   * about memory and announces itself in the environment line of every table it produces.
   */
  readonly settings?: readonly string[];
  /**
   * Extra guest environment entries, merged over the transport's own.
   *
   * The same escape hatch as {@link settings}, for the pgrust-only knobs that are environment
   * variables rather than GUCs — `PGRUST_WAITER_RECHECK_MS` above all, which is the period every
   * parked guest thread rechecks its predicate on.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Pool slots for the server's own children, before the one this Engine adds per Session.
   *
   * The Engine's own default is the number this repo's tables were produced with; this is here so a
   * Run can be asked what it costs on another one (`?postmasterTuning=pool:N`, see
   * `src/postmaster-tuning.ts`), because a slot is a live host Worker and a guest thread stack, and
   * both of those are memory a phone has to find.
   */
  readonly poolBase?: number;
  /**
   * Bytes the one shared `WebAssembly.Memory` is created with, when the Engine's own default is not
   * what is wanted.
   *
   * It may not go below the wasm module's own declared minimum — that is a link-time constant of
   * the pgrust build (`--initial-memory` in `wasm/wasm-build.sh`) and a smaller claim is a
   * `LinkError` at instantiation rather than a smaller memory.
   */
  readonly initialMemoryBytes?: number;
  /**
   * A **prepared store** to boot on: one `.repacked.tar.gz` holding the four files a repacked store
   * IS, written into this Configuration's OPFS store directory before the coordinator opens it.
   *
   * It is not `loadDataDir` and not a datadir tarball. A datadir tarball is a POSIX tree of some
   * thousands of files that has to be recreated one at a time through the filesystem it is restored
   * into; this is the store's own four files, written whole, after which the coordinator opens them
   * and finds a datadir already there. See `src/prepared-store-format.ts`.
   *
   * Only on the OPFS port — there is nowhere to put it on the memory port — and it implies
   * `reset: false`, because the seed IS the reset.
   */
  readonly seedFromTar?: ArrayBuffer;
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
  /**
   * A PGlite **datadir tarball** to boot on, as PGlite's own `loadDataDir` create option.
   *
   * The reference point the prepared-store lane is measured against, and the shape of the thing it
   * replaces: a POSIX tree of some thousands of files, recreated one at a time through the store it
   * is being restored INTO. Set by a probe only; no Configuration on the page carries one, because a
   * column that started from somebody else's datadir would not be measuring a cold store.
   */
  readonly loadDataDir?: ArrayBuffer;
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
  readonly pgrustPostmaster?: PgrustPostmasterOpenOptions;
  readonly wasqlite?: WasqliteOpenOptions;
  /**
   * How many sessions the Run needs, asked for by the **Suite** rather than by the Configuration.
   *
   * The two existing Suites need one and never set it; the Concurrency Suite needs one per Client.
   * Every Engine is told, and only one can act on it: the postmaster opens that many host-pipe
   * sessions, each on its own backend thread, and everything else has exactly one place to run SQL
   * and runs every Client's work on it, interleaved per statement (`./single-session.ts`). That is
   * not a refusal and not a serialisation; it is the mode those Engines have, and the Concurrency
   * Suite says which mode each column ran in.
   */
  readonly sessions?: number;
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

/**
 * Whether this Configuration puts the threads broker's one store on OPFS rather than in the
 * coordinator's heap.
 *
 * The threads twin of `pgliteStore`, and asked by the same availability gate: a store on the OPFS
 * port needs a synchronous access handle in a dedicated worker just as PGlite's does, whichever
 * Engine is on the other side of it.
 */
export function pgrustThreadsOpensOpfsStore(options: EngineOpenOptions | undefined): boolean {
  return options?.pgrustThreads?.port === "opfs";
}

/**
 * The postmaster settings this Configuration opens pgrust with, or `undefined` for the defaults
 * (one store on the coordinator's memory port, relaxed). Read only by the `pgrust-postmaster` worker.
 */
export function pgrustPostmasterOptions(
  options: EngineOpenOptions | undefined,
): PgrustPostmasterOpenOptions | undefined {
  return options?.pgrustPostmaster;
}

/**
 * Whether this Configuration puts the postmaster's one store on OPFS rather than in the
 * coordinator's heap — the third way into the same gate `pgliteStore` and
 * `pgrustThreadsOpensOpfsStore` answer, and asked for the same reason: the store needs a
 * synchronous access handle whichever Engine is on the other side of it.
 */
export function pgrustPostmasterOpensOpfsStore(options: EngineOpenOptions | undefined): boolean {
  return options?.pgrustPostmaster?.port === "opfs";
}

/** How many sessions a Run asked for; one unless a Suite asked for more. */
export function requestedSessions(options: EngineOpenOptions | undefined): number {
  const sessions = options?.sessions;
  return sessions === undefined || !Number.isInteger(sessions) || sessions < 1 ? 1 : sessions;
}

/** An Engine plus the storage and durability settings it is opened with. One column of results. */
export interface Configuration {
  readonly id: string;
  readonly label: string;
  readonly engine: EngineId;
  /**
   * Empty string means the Memory Configuration: the data directory lives in the worker's heap.
   *
   * For a Storage Configuration it names the directory the store owns in full: a nested OPFS path
   * for `options.pglite.store`, a root-level OPFS directory name for the threads broker's OPFS port
   * (whose vendored coordinator can address nothing else). Either way the Run starts from an empty
   * directory and removes it on close, so no state survives one.
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
  /**
   * Boot a fresh Engine for `config`, then run `preamble` (untimed) if it is non-empty.
   *
   * `sessions` is the Suite's request, not the Configuration's: the Concurrency Suite needs one
   * session per Client, and everything else needs the one every Engine has anyway.
   */
  open(config: Configuration, preamble: string, sessions?: number): Promise<void>;
  /**
   * Execute one SQL string untimed, on the first session.
   *
   * What `open` does with its preamble, for a caller that has to put something between the boot and
   * the setup: a Suite Run opens with no preamble, times its Warm-up, and only then runs its setup.
   */
  exec(sql: string): Promise<void>;
  /** Execute one SQL string and return its Measurement. */
  measure(sql: string): Promise<Measurement>;
  /**
   * Execute one SQL string and return its wall time AND its first value.
   *
   * For a probe that has to CHECK what it is timing — a restored datadir's row count against the
   * count that was written into it. Only the two Engines a probe drives answer it.
   */
  scalar(sql: string): Promise<{ readonly elapsedMs: number; readonly value: string | null }>;
  /** Run one scripted Scenario — every Client at once — and return what each of them did. */
  concurrent(scenario: ConcurrentScenario): Promise<ScenarioReport>;
  /** What memory this Engine is holding right now. Untimed, and never asked during a Run. */
  stats(): Promise<EngineStats>;
  /** Tear the Engine and its worker down. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Narrow a Configuration to the settings that can cross the worker boundary.
 *
 * The Suite's session count is folded in here, and only when it is more than one: a Run of the two
 * single-session Suites then sends byte-identical open settings to what it always did.
 */
export function toOpenSettings(config: Configuration, sessions = 1): { dataDir: string; options?: EngineOpenOptions } {
  const options: EngineOpenOptions | undefined = sessions > 1 ? { ...config.options, sessions } : config.options;
  return options === undefined ? { dataDir: config.dataDir } : { dataDir: config.dataDir, options };
}

/** Apply a Configuration's SQL rewrite, if it has one. */
export function applyModSql(config: Configuration, sql: string): string {
  return config.modSql ? config.modSql(sql) : sql;
}

/** The dialect this Configuration's Engine speaks. */
export function configurationDialect(config: Configuration): SqlDialect {
  return engineDialect(config.engine);
}
