/**
 * Boot a pgrust postmaster INSIDE THE CURRENT BROWSER WORKER, and hand out sessions.
 *
 * The browser twin of `./pgrust-engine.ts`: the same postmaster, the same fd contract, the same
 * broker store, reached through `new Worker` and `fetch` instead of `node:worker_threads` and
 * `node:fs`. It is the ONE browser boot in this repo — the `pgrust Postmaster` Engine
 * (`src/engines/pgrust-postmaster/pgrust-postmaster.worker.ts`) drives it to produce Measurements,
 * and `./pgrust-browser-factory.ts` drives it to produce a pgxsinkit store. Neither owns it, and
 * neither has a copy of it.
 *
 * **The host side of the fd contract** (`crates/backend/libpq/pqcomm_hostpipes`, and the vendored
 * `threads-host.js` that mirrors it). Fd numbering is the host's: the wake channel is fd 999, the
 * listener fd 1000, session `k` reads 1001+2k and writes 1002+2k, and its own wake ring is fd 900+k.
 * Every one of those pipes is created **before the guest starts**, because the registry is handed to
 * the pool workers at prewarm and there is no attaching a ring afterwards — which is why
 * {@link PgrustBrowserEngineOptions.sessions} is a ceiling rather than a hint. A session is announced
 * by writing a 16-byte `HPGP` record (magic, in_fd, out_fd, wake_fd; little-endian) to the listener
 * and one token byte to the wake fd; the postmaster wakes, accepts, spawns the backend, and the
 * backend answers the startup packet. The session's three rings share one **gate** — a futex word
 * every one of them bumps — so a blocked backend parks its `poll` over its in fd and its wake fd on a
 * single `Atomics.wait`, and another backend's `SetLatch` (an async NOTIFY, say) ends that park at
 * once rather than at the end of the guest's 100 ms interrupt poll.
 *
 * **The filesystem is the broker's, always.** With a private copy of the packed image per worker the
 * checkpointer could not see a relation file a backend had just created, and the shutdown checkpoint
 * — the thing that makes this a Postgres shutdown rather than a process kill — would fail. So the
 * storage coordinator starts first, on either of the store's two ports, and every guest thread
 * reaches that one store over a `SharedArrayBuffer` channel.
 *
 * **One channel is the host's own.** Beside the guests' — and attached with them, because the
 * coordinator can accept no channel once its blocking serve loop is entered — {@link PgrustStore}
 * gets a channel of this host's, at 1 MiB rather than the library's 64 KiB default. It is how a
 * datadir is read out of the store and written into it: the two things a wire client cannot ask its
 * server, and exactly what `dumpDataDir`/`loadDataDir` are.
 *
 * **This agent never blocks on the guest.** Every wait on shared memory that this module performs
 * goes through promises; the blocking half of the ring API belongs to the guest's own workers and to
 * {@link PgrustStore}, which may only be used where `Atomics.wait` is allowed — any Worker, never a
 * window's main thread. That is the same rule the whole engine runs under: a pgrust store needs a
 * worker, and the factory refuses the main thread rather than deadlocking on it.
 *
 * **Shutdown is Postgres's own.** The listener pipe is closed, and that EOF is what
 * `pqcomm_hostpipes` turns into a fast-shutdown request — the same flag a SIGINT raises. The guest
 * then walks its ordinary ceremony (stop backends, wait for them, shutdown checkpoint, `exit(0)`) and
 * this module waits for that exit instead of terminating a worker out from under a running server.
 * Only then does the coordinator get its doorbell stop, and only then are an OPFS store's four
 * exclusive handles released.
 */

import { SHARED_MEMORY_REQUIREMENT_MESSAGE } from "../engines/availability";
import type * as BrokerFs from "../vendor/pgrust/broker-fs.js";
import type { RepackedBundle, RepackedChannel, RepackedDoorbell } from "../vendor/pgrust/broker-fs.js";
import type { VfsManifest } from "../vendor/pgrust/pgrust-wasi.js";
import type * as SabPipes from "../vendor/pgrust/sab-pipe.js";
import type { SabPipe } from "../vendor/pgrust/sab-pipe.js";
import type * as ThreadsHost from "../vendor/pgrust/threads-host.js";
import { defaultWireArgv } from "../vendor/pgrust/wiresession.js";
import type { PgrustEngineShutdown } from "./pgrust-client-pglite";
import type { PgrustSessionPipes } from "./pgrust-pglite";
import { PgrustStore } from "./pgrust-store";

type ThreadsHostModule = typeof ThreadsHost;
type SabPipeModule = typeof SabPipes;
type BrokerFsModule = typeof BrokerFs;

const SYNC_HINT = "Run `bun run sync:pgrust` after building the pgrust wasm assets.";

/** The threads module under the asset directory, unless `threadsModule` names another. */
const DEFAULT_THREADS_MODULE = "postgres-threads.wasm";

/**
 * The prewarmed `wasi` `thread-spawn` pool: eight slots for the server, plus one per session.
 *
 * A postmaster claims far more threads than a wire session does — the startup process, the
 * checkpointer, the background writer, the WAL writer, the memory watchdog, the timeout timer, the
 * background-job dispatcher, the lease sweeper, and `max_parallel_workers` parked warm standbys —
 * and `thread-spawn` cannot create a worker on demand (it is microseconds from a futex park and may
 * not await), so an undersized pool is a hard `-EAGAIN` rather than a wait.
 *
 * Eight is the measured minimum rather than a guess: with one Session, seven refuses the spawn
 * (`the prewarmed pool of 8 is exhausted`) and so do six and five, while eight boots and runs every
 * Suite. It was twelve — pgrust's own postmaster-lane default — and each of the four slots that
 * went was a live Worker of its own in a tab that has to find room for all of them.
 */
export const DEFAULT_POOL_BASE_SIZE = 8;

/** The warm standby pool the postmaster keeps, and pgrust's own browser harness's number. */
const MAX_PARALLEL_WORKERS = 2;

/**
 * How deep a backend may recurse — and, on wasm, the size of every thread stack the postmaster
 * carves out of the one shared memory.
 *
 * `defaultWireArgv()` pins 60000 kB, which is what the guest's MAIN stack is linked with and what a
 * single-session wire lane needs. A postmaster is a different shape: `child_thread_stack_size()`
 * has no rlimit to read on WASI, so it reserves `max(floor, max_stack_depth + 2MB)` for every child
 * it spawns, and on wasm those stacks are bytes of the shared `WebAssembly.Memory` rather than
 * address space. At 60000 kB that is 60.6 MiB × twelve children before the first statement; at
 * 2048 kB — stock Postgres's own default, and now this engine's — it is 4 MiB each, and the
 * Speedtest Suite's peak shared memory falls from 1101 MiB to 657 MiB with no Benchmark reporting
 * `stack depth limit exceeded`. A caller's own `-c max_stack_depth=` wins the duplicate.
 */
const MAX_STACK_DEPTH_KB = 2048;

/**
 * The postmaster settings that follow from the store rather than from the transport, adopted on
 * 2026-09-24: `wal_init_zero=off` and `wal_buffers=4MB` for every store, and `fsync=off` unless the
 * store's durability is `strict`. Measured and gated in
 * `docs/results/2026-09-24-store-levers.md` (§2's S1–S3, §8, §11 and its "Adopted" section) and
 * taken on the persistent-context lane of `docs/results/2026-09-24-persistent-context.md`.
 *
 * - `wal_init_zero=off`: a new 16 MB WAL segment is not zero-filled 8 KiB at a time through the
 *   broker. On this store a new segment reads as zeros either way — a fresh extent is zero, a reused
 *   one is zeroed by the store — so those writes were pure broker traffic (2 048 of Speedtest row
 *   11's 3 370 requests).
 * - `wal_buffers=4MB`: PGlite's own value, in place of `-1` (1/32 of `shared_buffers`, 1 MB here).
 *   It costs 6 MiB of the shared memory.
 * - `fsync=off` on a `relaxed` store: the guest stops turning every WAL flush and checkpoint into a
 *   store-wide `strictSync()`, which on a disk-backed OPFS profile is a millisecond and more each.
 *   The store then reaches the platform when it amortizes, at an explicit `strictSync()` and at
 *   close — the broker's own documented relaxed loss window. A `strict` store keeps `fsync=on`.
 *
 * They go in before a caller's settings, so a caller — the factory's durability mapping, a
 * `?postmasterTuning=` Run — still wins the duplicate.
 */
const WAL_INIT_ZERO = "off";
const WAL_BUFFERS = "4MB";

/** stdin/stdout of the postmaster process itself: nothing rides them, but the host wants the pair. */
const STDIN_CAPACITY = 1 << 16;
const STDOUT_CAPACITY = 1 << 16;

/** The listener ring carries 16-byte records; one page holds far more sessions than any caller opens. */
const LISTENER_CAPACITY = 1 << 12;
/** The wake ring: sized far past anything that can queue, because a full one would block a SetLatch. */
const WAKE_CAPACITY = 1 << 16;
/** One session's own wake ring, sized for the same reason as the postmaster's. */
const SESSION_WAKE_CAPACITY = 1 << 16;
/** Per session, client to backend: 1 MiB, the size the guest's own stdin ring uses. */
const SESSION_TO_GUEST_CAPACITY = 1 << 20;
/** Per session, backend to client: 4 MiB, because result sets are the large direction. */
const SESSION_FROM_GUEST_CAPACITY = 1 << 22;

/**
 * The host's own store channel, at 1 MiB rather than the library's 64 KiB default.
 *
 * `read`/`write` chunk themselves against the payload, so this is purely how many blocking round
 * trips a whole-datadir dump or restore costs: 41 MB of datadir is ~40 turns here against ~640 at
 * the default. No guest channel is touched — this is one extra channel, minted for this host.
 */
const STORE_CHANNEL_PAYLOAD_BYTES = 1 << 20;

/** `HPGP` in stream order: the connection record's magic. */
const CONNECTION_MAGIC = 0x50475048;
/** The connection record is four little-endian 32-bit words. */
const CONNECTION_RECORD_BYTES = 16;

/**
 * How many times the storage coordinator may be started before a still-owned store is given up on,
 * and the linear backoff between attempts (500, 1000, 1500, … ms).
 *
 * Six attempts is ~7.5 s of patience, which is what a browser needs to reap a page's worth of
 * workers after a navigation — the one moment a repacked store has two would-be owners.
 */
const DEFAULT_STORAGE_OPEN_ATTEMPTS = 6;
const DEFAULT_STORAGE_RETRY_MS = 500;

/** The `errorName` the coordinator reports when the store is already open somewhere else. */
const STORE_OWNED_ERROR_NAME = "StoreOwnedError";

/**
 * The store is open somewhere else — the ONE storage failure that is worth waiting out.
 *
 * A repacked store owns its four OPFS files exclusively, and the owner releases them when its worker
 * dies. After a page navigation that death happens a moment AFTER the next page has begun booting,
 * so the new owner meets the old one. Distinct from every other storage failure, which says
 * something true about the store and must be thrown at once.
 */
export class PgrustStoreOwnedError extends Error {
  override readonly name = "PgrustStoreOwnedError";
}

const STORAGE_READY_TIMEOUT_MS = 180_000;
const POOL_READY_TIMEOUT_MS = 120_000;
/** How long to wait for the postmaster to log that it is accepting connections. */
const POSTMASTER_READY_TIMEOUT_MS = 180_000;
/** How long to wait for the guest's own exit after the listener has been closed. */
const EXIT_TIMEOUT_MS = 60_000;
const STORAGE_STOP_TIMEOUT_MS = 5_000;

/** Keep only the tail of the server log: enough to explain a failure, bounded for a long run. */
const MAX_SERVER_LOG_CHARS = 8_000;

/** What the postmaster logs once it will accept a connection record. */
const READY_LOG_PATTERN = /database system is ready to accept connections/i;
/** What a clean stop logs, and the difference between a shutdown and a process that merely stopped. */
const SHUTDOWN_CHECKPOINT_PATTERN = /checkpoint starting: shutdown/i;

/** The two store ports a browser has. There is no `file` port here; that one is bun's. */
export type PgrustBrowserPort = "memory" | "opfs";

/** How durable the broker is between the guest's own fsyncs; see `wasm/storage-worker.js`. */
export type PgrustBrowserDurability = "relaxed" | "strict";

export interface PgrustBrowserStorage {
  readonly port: PgrustBrowserPort;
  /**
   * The OPFS directory the coordinator owns in full, as a `/`-separated path. Required on `opfs`.
   *
   * Nested since pgrust `9bab6bff11`: the coordinator walks a `getDirectoryHandle` per segment, so
   * a store may live under a namespace of its host's choosing (`pgxsinkit/stores/<identity>`).
   */
  readonly opfsDir?: string;
  /** Broker durability. `relaxed` by default, which is the mode both pgxsinkit durability modes use. */
  readonly durability?: PgrustBrowserDurability;
  /** Empty the store's directory before opening it. Ignored on the memory port, which is always fresh. */
  readonly reset?: boolean;
  /**
   * Fail the boot if the coordinator opened an EXISTING data directory.
   *
   * A measurement lane sets it: it asked for a reset, so a coordinator reporting `restored` found a
   * store this run did not put there, and those would be a warm store's numbers under a cold store's
   * label. A pgxsinkit store is the opposite case — finding last session's datadir is the whole point
   * — so the factory leaves it off.
   */
  readonly refuseExisting?: boolean;
}

/** What the coordinator reports once its store is open and seeded; none of it is inside a Measurement. */
export interface PgrustBrowserStorageReport {
  readonly port?: string;
  readonly opfsDir?: string | null;
  readonly durability?: string;
  readonly restored?: boolean;
  readonly openMs?: number;
  readonly seedMs?: number;
  readonly files?: number;
  readonly bytes?: number;
  readonly datadirFiles?: number;
  readonly datadirBytes?: number;
  readonly arenaBytes?: number;
}

export interface PgrustBrowserEngineOptions {
  /**
   * Where the pgrust build outputs are served from: an ABSOLUTE URL naming a directory (trailing
   * separator optional). `postgres-threads.wasm`, `vfs.img` and `vfs.json` sit in it, and the
   * vendored host JS plus the store bundle under `host/`.
   *
   * Absolute because `new Worker(url)` requires a same-origin script and the vendored host resolves
   * its own siblings from it; a caller derives it from `import.meta.url` or from the app's base.
   */
  readonly assetBase: string;
  /**
   * The threads module, relative to {@link assetBase}: `postgres-threads.wasm` by default. The
   * benchmark page's `?pgrustModule=` points it at an alternate module under `alt/<id>/`; the host
   * JS, `vfs.img` and the store bundle are the asset directory's either way.
   */
  readonly threadsModule?: string;
  /** How many sessions may be opened. Every ring is created before the guest starts, so this is a ceiling. */
  readonly sessions?: number;
  /** Pool slots for the server's own children, before the one added per session. Eight by default. */
  readonly poolBase?: number;
  /** Bytes the one shared `WebAssembly.Memory` is created with; the host's own default otherwise. */
  readonly initialMemoryBytes?: number;
  /** Where this engine's one store lives and how durably. */
  readonly storage: PgrustBrowserStorage;
  /** Extra `name=value` settings, each appended to the postmaster's argv as `-c name=value`. */
  readonly settings?: readonly string[];
  /** Extra guest environment entries, merged over the transport's own. */
  readonly env?: Readonly<Record<string, string>>;
  /** Where the server's stderr goes. Silent by default; the log tail rides on any thrown error regardless. */
  readonly onServerLog?: (text: string) => void;
  /** One line describing what the store cost, and the raw report behind it. */
  readonly onStorageReady?: (line: string, report: PgrustBrowserStorageReport) => void;
  /**
   * A fatal event AFTER the boot returned: the guest exited, a pool slot refused a spawn, a worker
   * threw. A caller with sessions in flight settles them here rather than leaving them waiting for a
   * ReadyForQuery that can no longer come.
   */
  readonly onFatal?: (error: Error) => void;
  /**
   * Run before the storage coordinator opens anything.
   *
   * The window in which a prepared store may be written into the OPFS directory — after that, the
   * coordinator owns four exclusive handles on it. The engine deliberately does not know what a
   * prepared store is; the Engine worker that has one passes it in.
   */
  readonly beforeStorage?: () => Promise<void>;
  /**
   * Run against the seeded store BEFORE the guest starts.
   *
   * The one window in which a datadir may be replaced wholesale: the coordinator has opened its
   * store and seeded it from the packed image, and no postmaster exists yet. `loadDataDir` is the
   * only caller — it empties `/pgdata` and writes a backup's entries in their place.
   */
  readonly prepareStore?: (store: PgrustStore) => Promise<void> | void;
  /** How long the guest gets to exit after the listener closes, before the workers go anyway. */
  readonly exitDeadlineMs?: number;
  /**
   * How many times to start the storage coordinator before giving up on a store its LAST owner has
   * not released yet ({@link PgrustStoreOwnedError}). Six by default; 1 disables the wait.
   */
  readonly storageOpenAttempts?: number;
  /** The linear backoff between those attempts, in milliseconds. 500 by default. */
  readonly storageRetryMs?: number;
}

/**
 * One session's rings, reserved but not yet announced.
 *
 * The two halves are separate because a caller that measures the accept latency has to install its
 * reader BEFORE the postmaster is told the session exists. A caller that does not care calls
 * {@link PgrustBrowserEngine.openSession}, which does both.
 */
export interface PgrustBrowserSession extends PgrustSessionPipes {
  readonly index: number;
  readonly inFd: number;
  readonly outFd: number;
  /** This session's wake fd, which travels in its connection record; 0 would mean "none". */
  readonly wakeFd: number;
  /**
   * Write this session's connection record to the listener and wake the postmaster.
   *
   * A bound closure rather than a method: a caller holds onto it (the Engine worker stores it on its
   * own session object), and a method torn off its receiver would lose the engine it belongs to.
   */
  readonly announce: () => void;
}

export interface PgrustBrowserEngine {
  /** Reserve the next session's rings WITHOUT announcing it. */
  reserveSession(): PgrustBrowserSession;
  /** Reserve and announce in one call — the `PgrustClientEngine` shape. */
  openSession(): PgrustSessionPipes;
  /**
   * The coordinator's store, over this host's own broker channel.
   *
   * Blocking, like every broker client (see {@link PgrustStore}). It is live for as long as the
   * coordinator is: after `shutdown()` the doorbell has stopped and every call would time out.
   */
  readonly store: PgrustStore;
  /** The one shared `WebAssembly.Memory` every instance imports; `buffer.byteLength` is what the guest took. */
  readonly sharedMemory: WebAssembly.Memory;
  /** The tail of the server's stderr, for a caller building its own error message. */
  serverLog(): string;
  /** Close the listener — the fast-shutdown request — and wait for the guest's own `exit(0)`. Idempotent. */
  shutdown(): Promise<PgrustEngineShutdown>;
}

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
  readonly fail: (error: Error) => void;
}

function gate(): Gate {
  let open: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  // Every gate is awaited, but one that fails after its await has returned would otherwise be an
  // unobserved rejection, which is a console error in every browser.
  promise.catch(() => {});
  return { promise, open, fail };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Messages the process worker and every pool slot send back; only these fields are read. */
interface HostEvent {
  readonly type?: string;
  readonly from?: string;
  readonly code?: number;
  readonly message?: string;
  readonly bytes?: Uint8Array;
  readonly poolSize?: number;
}

/** Messages the storage coordinator sends back; a different protocol from the process worker's. */
interface StorageEvent extends PgrustBrowserStorageReport {
  readonly type?: string;
  readonly message?: string;
  readonly errorName?: string;
}

function asRecord<T>(message: unknown): T {
  return typeof message === "object" && message !== null ? (message as T) : ({} as T);
}

/** One line of what the store cost, none of which is inside any Measurement window. */
export function describeStorageReady(report: PgrustBrowserStorageReport): string {
  const where = report.opfsDir === undefined || report.opfsDir === null ? "" : ` dir=${report.opfsDir}`;
  const seeded = `seeded ${report.files ?? 0} files (${report.bytes ?? 0} bytes) in ${report.seedMs ?? 0} ms`;
  return (
    `pgrust postmaster storage: port=${report.port ?? "?"}${where} durability=${report.durability ?? "?"}; ` +
    `store opened in ${report.openMs ?? 0} ms, ${seeded}; /pgdata holds ${report.datadirFiles ?? 0} files ` +
    `(${report.datadirBytes ?? 0} bytes) in a ${((report.arenaBytes ?? 0) / 1_048_576).toFixed(1)} MiB arena`
  );
}

/**
 * The postmaster's argv: the wire lanes' GUCs, `PostmasterMain`'s shape.
 *
 * `defaultWireArgv()` is the shared source of the engine GUCs, so the postmaster lane and the
 * session lanes cannot drift apart on one. What changes is the dispatch (`--host-pipes`, which picks
 * a transport and then falls through to the ordinary postmaster), the trailing database name (a
 * postmaster's getopt rejects it), the two GUCs that make the host fd the only way in, the warm
 * standby pool, which has to be bounded because a fixed host thread pool is what backs it,
 * `max_stack_depth`, which here sizes every child's stack inside the shared memory, and the three
 * store settings above, `fsync` from the store's `durability`.
 *
 * `extra` is appended last, so a caller's `-c` wins the duplicate.
 */
function postmasterArgv(durability: PgrustBrowserDurability, extra: readonly string[]): string[] {
  const argv = defaultWireArgv();
  argv[1] = "--host-pipes";
  argv.pop();
  argv.push(
    "-c",
    "listen_addresses=",
    "-c",
    "unix_socket_directories=",
    // So a shutdown that did or did not run its checkpoint says which in the log this module keeps.
    "-c",
    "log_checkpoints=on",
    "-c",
    `max_parallel_workers=${MAX_PARALLEL_WORKERS}`,
    "-c",
    `max_stack_depth=${MAX_STACK_DEPTH_KB}`,
    "-c",
    `wal_init_zero=${WAL_INIT_ZERO}`,
    "-c",
    `wal_buffers=${WAL_BUFFERS}`,
    "-c",
    `fsync=${durability === "strict" ? "on" : "off"}`,
  );
  for (const setting of extra) {
    argv.push("-c", setting);
  }
  return argv;
}

/** The guest environment: the wire lanes' plus the two fds that are this transport's whole contract. */
function guestEnv(host: ThreadsHostModule, extra: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return {
    USER: "postgres",
    PGRUST_TZDIR: "/share/timezone",
    PGRUST_PGSHAREDIR: "/share",
    // The guest's own async runtime is off: this build runs every backend on a real wasi thread.
    PGRUST_RUNTIME: "0",
    RUST_BACKTRACE: "1",
    // Required: `pqcomm_hostpipes` reads the listener fd here and `PostmasterMain` FATALs without
    // it. The wake fd is optional — without it the postmaster falls back to a timed accept probe,
    // which would put tens of milliseconds into every session open for nothing.
    PGRUST_HOSTPIPES_LISTEN_FD: String(host.HOSTPIPES_LISTEN_FD),
    PGRUST_HOSTPIPES_WAKE_FD: String(host.HOSTPIPES_WAKE_FD),
    // Last, so the one caller that passes any can turn a pgrust knob down; empty for every column.
    ...extra,
  };
}

/**
 * The connection record `pqcomm_hostpipes` accepts: magic, in fd, out fd, wake fd; little-endian.
 *
 * The fourth word was `reserved` until pgrust `d2da198f48`; it now carries the session's own wake
 * fd. A backend whose record says 0 blocks with its interrupt poll alone, which is a 100 ms floor on
 * anything another backend has to tell it — an async NOTIFY above all.
 */
function connectionRecord(inFd: number, outFd: number, wakeFd: number): Uint8Array {
  const record = new Uint8Array(CONNECTION_RECORD_BYTES);
  const view = new DataView(record.buffer);
  view.setUint32(0, CONNECTION_MAGIC, true);
  view.setInt32(4, inFd, true);
  view.setInt32(8, outFd, true);
  view.setInt32(12, wakeFd, true);
  return record;
}

/** A directory URL, with the trailing separator a `new URL("./x", base)` needs. */
function directoryUrl(base: string): string {
  return base.endsWith("/") ? base : `${base}/`;
}

async function fetchAsset(url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error: unknown) {
    throw new Error(`pgrust asset ${url} could not be fetched (${describe(error)}). ${SYNC_HINT}`);
  }
  if (!response.ok) {
    throw new Error(`pgrust asset ${url} returned HTTP ${response.status}. ${SYNC_HINT}`);
  }
  return response;
}

async function compileEngineModule(url: string): Promise<WebAssembly.Module> {
  const response = await fetchAsset(url);
  const buffered = response.clone();
  if (typeof WebAssembly.compileStreaming === "function") {
    try {
      return await WebAssembly.compileStreaming(response);
    } catch {
      // A server that does not serve application/wasm rejects the streaming compile; buffer instead.
    }
  }
  return await WebAssembly.compile(await buffered.arrayBuffer());
}

/**
 * Load one vendored host module from `<assetBase>host/`.
 *
 * A run-time URL, never a bundled import: these files are served verbatim, and a bundled copy would
 * resolve `./thread-worker.js` against a hashed chunk name. `@vite-ignore` is for the Engine worker's
 * build; a bundler that sees a non-literal specifier leaves it alone regardless.
 */
async function loadHostModule<T>(hostBase: string, name: string): Promise<T> {
  const url = `${hostBase}${name}`;
  try {
    return (await import(/* @vite-ignore */ url)) as T;
  } catch (error: unknown) {
    throw new Error(`pgrust threads host module ${url} could not be loaded (${describe(error)}). ${SYNC_HINT}`);
  }
}

/**
 * Start the whole thing: the storage coordinator, then the process worker with its prewarmed pool,
 * then wait for the postmaster to say it will accept connections.
 *
 * Everything this creates is taken away again by the returned engine's `shutdown()`, INCLUDING on a
 * boot that never finished: a half-started server leaves live workers and, on OPFS, four exclusively
 * held handles, so the failure path shuts down before it rethrows.
 */
export async function startPgrustBrowserPostmaster(options: PgrustBrowserEngineOptions): Promise<PgrustBrowserEngine> {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
    throw new Error(SHARED_MEMORY_REQUIREMENT_MESSAGE);
  }
  const storage = options.storage;
  if (storage.port === "opfs" && (storage.opfsDir === undefined || storage.opfsDir === "")) {
    throw new Error("pgrust postmaster: the opfs storage port needs an `opfsDir` to own");
  }
  const sessionCount = options.sessions ?? 1;
  const poolSize = (options.poolBase ?? DEFAULT_POOL_BASE_SIZE) + sessionCount;
  const assetBase = directoryUrl(options.assetBase);
  const hostBase = `${assetBase}host/`;

  /** One decoder for the whole run: a multi-byte character can straddle two stderr chunks. */
  const stderrDecoder = new TextDecoder("utf-8", { fatal: false });
  let serverLog = "";
  const logTail = (): string => serverLog;

  /** A dead server is only explicable from its log, so carry the tail into the thrown Error. */
  function withServerLog(message: string): Error {
    const log = serverLog.trim();
    return new Error(log === "" ? message : `${message}\nserver log:\n${log}`);
  }

  async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(withServerLog(`pgrust postmaster: ${what} after ${ms} ms`));
      }, ms);
    });
    // The loser of the race is never awaited; without this its rejection is an unhandled one.
    deadline.catch(() => {});
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  const [host, sab, brokerFs] = await Promise.all([
    loadHostModule<ThreadsHostModule>(hostBase, "threads-host.js"),
    loadHostModule<SabPipeModule>(hostBase, "sab-pipe.js"),
    loadHostModule<BrokerFsModule>(hostBase, "broker-fs.js"),
  ]);

  const [wasmModule, manifest] = await Promise.all([
    compileEngineModule(`${assetBase}${options.threadsModule ?? DEFAULT_THREADS_MODULE}`),
    fetchAsset(`${assetBase}vfs.json`).then(async (response) => (await response.json()) as VfsManifest),
  ]);

  /**
   * The packed image, fetched fresh for every coordinator attempt.
   *
   * It is TRANSFERRED to the coordinator, so a failed attempt leaves a detached buffer and a retry
   * has nothing to send. Re-fetching costs a browser-cache read rather than the 40 MiB copy that
   * keeping a spare would cost for every boot that never retries.
   */
  const fetchImage = async (): Promise<ArrayBuffer> =>
    await fetchAsset(`${assetBase}vfs.img`).then(async (response) => await response.arrayBuffer());

  // The prepared store, if there is one, goes in BEFORE the coordinator opens anything: after that
  // it owns four exclusive handles on the directory.
  if (options.beforeStorage !== undefined) {
    await options.beforeStorage();
  }

  const exited = gate();
  const poolReady = gate();
  const postmasterReady = gate();
  let exitCode: number | null = null;

  // ---- the storage coordinator, first and always -------------------------------------------
  // Its store must be seeded before the startup process can read a file, and once its blocking serve
  // loop is entered it never reaches its event loop again. It also takes ownership of the image.
  const bundleUrl = brokerFs.repackedBundleUrl(hostBase);
  let bundle: RepackedBundle;
  try {
    bundle = await brokerFs.loadRepackedBundle(bundleUrl);
  } catch (error: unknown) {
    throw new Error(
      `the pre-release @pgxsinkit/pglite-opfs-repacked bundle at ${bundleUrl} could not be loaded ` +
        `(${describe(error)}). ${SYNC_HINT}`,
    );
  }

  interface Coordinator {
    readonly worker: Worker;
    readonly doorbell: RepackedDoorbell;
    /** One per pool slot, plus one for the process instance. */
    readonly channels: readonly RepackedChannel[];
    /** This host's own channel: how a datadir is read out of the store and written into it. */
    readonly storeChannel: RepackedChannel;
    readonly stopped: Gate;
  }

  /** Start one coordinator and wait for it to open and seed its store. Owns nothing on failure. */
  async function attemptStorage(): Promise<Coordinator> {
    const doorbell: RepackedDoorbell = bundle.RepackedDoorbell.create();
    // One channel per pool slot PLUS one for the process instance: the protocol is one request in
    // flight per channel, so two agents may never share one.
    const channels: RepackedChannel[] = Array.from({ length: poolSize + 1 }, (_unused, index) =>
      bundle.RepackedChannel.create({ id: index + 1, doorbell }),
    );
    // And one more for THIS host, which is an agent like any other. Attached with the rest, because
    // the coordinator can accept no channel once its blocking serve loop is entered.
    const storeChannel: RepackedChannel = bundle.RepackedChannel.create({
      id: channels.length + 1,
      doorbell,
      payloadBytes: STORE_CHANNEL_PAYLOAD_BYTES,
    });

    const ready = gate();
    const stopped = gate();
    const worker = host.makeWorker(host.storageWorkerUrl(hostBase), { name: "pgrust-postmaster-storage" });
    host.onWorkerMessage(worker, (raw: unknown) => {
      const event = asRecord<StorageEvent>(raw);
      switch (event.type) {
        case "storage-ready":
          // A `reset` was asked for, so a coordinator reporting it RESTORED a data directory found
          // one this run did not put there. For a Measurement those would be a warm store's numbers
          // under a cold store's label, which is worse than a failed column.
          if (event.restored === true && storage.refuseExisting === true) {
            ready.fail(
              new Error(
                `pgrust postmaster storage opened an existing data directory in "${storage.opfsDir ?? ""}" ` +
                  "despite being asked to reset it; this run would be measuring an earlier run's store",
              ),
            );
            return;
          }
          options.onStorageReady?.(describeStorageReady(event), event);
          ready.open();
          return;
        case "storage-stopped":
          stopped.open();
          return;
        case "storage-error": {
          const message = `pgrust postmaster storage ${event.errorName ?? "Error"}: ${event.message ?? ""}`;
          ready.fail(
            event.errorName === STORE_OWNED_ERROR_NAME ? new PgrustStoreOwnedError(message) : new Error(message),
          );
          stopped.open();
          return;
        }
        default:
          return;
      }
    });
    host.onWorkerError(worker, (error: Error) => {
      ready.fail(new Error(`pgrust postmaster storage worker threw: ${error.message}`));
      stopped.open();
    });

    const image = await fetchImage();
    worker.postMessage(
      {
        kind: "boot",
        bundleUrl,
        image,
        manifest,
        channels: [...channels.map((channel) => channel.transfer()), storeChannel.transfer()],
        doorbell: doorbell.buffer,
        options:
          storage.port === "opfs"
            ? {
                port: "opfs",
                opfsDir: storage.opfsDir,
                durability: storage.durability ?? "relaxed",
                reset: storage.reset === true,
              }
            : { port: "memory", durability: storage.durability ?? "relaxed" },
      },
      [image],
    );

    try {
      await withTimeout(ready.promise, STORAGE_READY_TIMEOUT_MS, "the storage coordinator did not seed its store");
    } catch (error: unknown) {
      // A coordinator that never became ready may still hold synchronous access handles on the
      // directory. Terminating it is what releases them — and what lets a retry have them.
      worker.terminate();
      stopped.open();
      throw error;
    }
    return { worker, doorbell, channels, storeChannel, stopped };
  }

  /**
   * The coordinator, with patience for a store the LAST owner has not let go of yet.
   *
   * A repacked store is exclusively owned, and an owner releases it when its worker dies — which,
   * after a page navigation, is a moment AFTER the next page has already started booting. Observed
   * on pgxsinkit's board: a reload's mint refused with `StoreOwnedError` inside 300 ms of the
   * reload, while the same store opened cleanly a few seconds later. So a store that is merely
   * still-owned is waited out; every other failure is what it says it is and is thrown at once.
   */
  const attempts = Math.max(1, options.storageOpenAttempts ?? DEFAULT_STORAGE_OPEN_ATTEMPTS);
  const retryMs = options.storageRetryMs ?? DEFAULT_STORAGE_RETRY_MS;
  let coordinator: Coordinator | undefined;
  for (let attempt = 1; coordinator === undefined; attempt += 1) {
    try {
      coordinator = await attemptStorage();
    } catch (error: unknown) {
      if (!(error instanceof PgrustStoreOwnedError) || attempt >= attempts) {
        throw error;
      }
      options.onServerLog?.(
        `pgrust postmaster storage: the store is still owned by its last opener; retrying (${attempt}/${attempts - 1})\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, retryMs * attempt));
    }
  }

  const { worker: storageWorker, doorbell, channels, storeChannel, stopped: storageStopped } = coordinator;

  // datadir may be replaced. `loadDataDir` is what runs here.
  const store = new PgrustStore(new bundle.RepackedSyncClient(storeChannel), bundle);
  if (options.prepareStore !== undefined) {
    try {
      await options.prepareStore(store);
    } catch (error: unknown) {
      doorbell.requestStop();
      await Promise.race([
        storageStopped.promise,
        new Promise((resolve) => setTimeout(resolve, STORAGE_STOP_TIMEOUT_MS)),
      ]);
      storageWorker.terminate();
      throw error;
    }
  }

  // The packed image now lives in the coordinator's store (and its ArrayBuffer was transferred
  // there); every instance gets an empty base VFS the broker adapter sits on top of.
  const guestImage = new ArrayBuffer(0);
  const guestManifest: VfsManifest = { dirs: ["/"], files: [] };

  const memory =
    options.initialMemoryBytes === undefined
      ? host.createSharedMemory()
      : host.createSharedMemory({ initialBytes: options.initialMemoryBytes });

  const stdin = sab.SabPipe.create(STDIN_CAPACITY);
  const stdout = sab.SabPipe.create(STDOUT_CAPACITY);

  // Every host-owned pipe, created before the guest starts: the registry travels to the process
  // worker and to every pool slot at prewarm, and a ring registered later would be invisible to the
  // backend thread that has to read it.
  const registry = new host.PipeRegistry();
  const listener = sab.SabPipe.create(LISTENER_CAPACITY);
  registry.register(host.HOSTPIPES_LISTEN_FD, { in: listener });
  // Both ends of one ring on one fd: this host writes a token after every announcement and after the
  // listener close, any guest thread whose SetLatch finds the postmaster parked on it writes one
  // too, and the postmaster drains and discards them.
  const wake = sab.SabPipe.create(WAKE_CAPACITY);
  registry.register(host.HOSTPIPES_WAKE_FD, { in: wake, out: wake });

  interface Slot {
    readonly index: number;
    readonly inFd: number;
    readonly outFd: number;
    readonly wakeFd: number;
    readonly toGuest: SabPipe;
    readonly fromGuest: SabPipe;
  }

  // ONE HOST GATE FOR EVERY SESSION: the driver reads N backend-to-client rings at once and may
  // not block, so without it it would hold N outstanding `Atomics.waitAsync` — which is the shape
  // that intermittently freezes a WebKit agent for a second at a time (see `SabPipe`'s own note).
  // The guest never waits on it, so no backend is woken by another session's byte.
  const hostGate = sab.SabPipe.createHostGate();

  const slots: Slot[] = Array.from({ length: sessionCount }, (_unused, index) => {
    const { inFd, outFd } = host.sessionFds(index);
    // ONE GATE PER SESSION: the rings a backend can be waiting on share a futex word, so the host
    // parks its `poll` over the session's in fd AND its wake fd on one `Atomics.wait` instead of
    // slicing between them. Per session, never global — an idle backend wakes on its own traffic.
    const sessionGate = sab.SabPipe.createGate();
    const toGuest = sab.SabPipe.create(SESSION_TO_GUEST_CAPACITY, { gate: sessionGate });
    // Only the ring the HOST reads carries the host gate: it is the one this driver parks on.
    const fromGuest = sab.SabPipe.create(SESSION_FROM_GUEST_CAPACITY, { gate: sessionGate, hostGate });
    registry.register(inFd, { in: toGuest });
    registry.register(outFd, { out: fromGuest });
    // Both ends of one ring on one fd, exactly as the postmaster's: any guest thread whose
    // `SetLatch` finds this backend fd-parked writes a token here, and the backend drains it.
    const wakeFd = host.sessionWakeFd(index);
    const sessionWake = sab.SabPipe.create(SESSION_WAKE_CAPACITY, { gate: sessionGate });
    registry.register(wakeFd, { in: sessionWake, out: sessionWake });
    return { index, inFd, outFd, wakeFd, toGuest, fromGuest };
  });

  function handleEvent(raw: unknown): void {
    const event = asRecord<HostEvent>(raw);
    switch (event.type) {
      case "pool-ready":
        poolReady.open();
        return;
      case "stderr": {
        if (event.bytes === undefined) {
          return;
        }
        const text = stderrDecoder.decode(event.bytes, { stream: true });
        options.onServerLog?.(text);
        serverLog += text;
        if (READY_LOG_PATTERN.test(serverLog)) {
          postmasterReady.open();
        }
        if (serverLog.length > MAX_SERVER_LOG_CHARS) {
          serverLog = serverLog.slice(-MAX_SERVER_LOG_CHARS);
        }
        return;
      }
      case "spawn-refused": {
        // A pool too small is a hard -EAGAIN inside the guest, and the run cannot recover from it.
        const error = withServerLog(
          `pgrust postmaster: wasi thread-spawn refused, the prewarmed pool of ${event.poolSize ?? poolSize} ` +
            "is exhausted",
        );
        poolReady.fail(error);
        postmasterReady.fail(error);
        options.onFatal?.(error);
        return;
      }
      case "exit": {
        exitCode = event.code ?? -1;
        exited.open();
        // A server that exits mid-cycle would otherwise leave every session waiting for a
        // ReadyForQuery that can no longer come.
        const error = withServerLog(`pgrust postmaster: the server exited with code ${exitCode}`);
        postmasterReady.fail(error);
        options.onFatal?.(error);
        return;
      }
      case "error": {
        const error = withServerLog(`pgrust postmaster ${event.from ?? "worker"}: ${event.message ?? "unknown error"}`);
        poolReady.fail(error);
        postmasterReady.fail(error);
        options.onFatal?.(error);
        exited.open();
        return;
      }
      default:
        return;
    }
  }

  const processWorker = host.makeWorker(host.threadWorkerUrl(hostBase), { name: "pgrust-postmaster-process" });
  host.onWorkerMessage(processWorker, handleEvent);
  host.onWorkerError(processWorker, (error: Error) => {
    handleEvent({ type: "error", from: "process", message: error.message });
  });

  // A spawned thread reports here directly: from the moment the postmaster's own thread joins, the
  // process worker is parked in a futex and relays nothing.
  const relayChannels = Array.from({ length: poolSize }, () => host.newMessageChannel());
  for (const channel of relayChannels) {
    host.onPortMessage(channel.port1, handleEvent);
  }

  processWorker.postMessage(
    {
      role: "process",
      module: wasmModule,
      memory,
      image: guestImage,
      manifest: guestManifest,
      fs: "broker",
      bundleUrl,
      channel: channels[0]?.transfer() ?? null,
      poolChannels: channels.slice(1).map((channel) => channel.transfer()),
      stdin: stdin.descriptor(),
      stdout: stdout.descriptor(),
      // The whole of this transport: the listener, the wake channel and every session's pair.
      pipes: registry.descriptors(),
      argv: postmasterArgv(storage.durability ?? "relaxed", options.settings ?? []),
      env: guestEnv(host, options.env ?? {}),
      poolSize,
      trace: 0,
      relayPorts: relayChannels.map((channel) => channel.port2),
    },
    [guestImage, ...relayChannels.map((channel) => channel.port2)],
  );

  let nextSession = 0;
  let stopped = false;

  function announce(slot: Slot): void {
    const written = listener.write(connectionRecord(slot.inFd, slot.outFd, slot.wakeFd), { block: false });
    if (written !== CONNECTION_RECORD_BYTES) {
      throw new Error(`pgrust postmaster: the listener ring would not take a whole record (${written}/16)`);
    }
    // The wake token is what turns the postmaster's next accept probe into an immediate one.
    wake.write(new Uint8Array([0]), { block: false });
  }

  function reserveSession(): PgrustBrowserSession {
    const slot = slots[nextSession];
    nextSession += 1;
    if (slot === undefined) {
      throw new Error(`pgrust postmaster: only ${slots.length} session ring(s) were created`);
    }
    return {
      index: slot.index,
      inFd: slot.inFd,
      outFd: slot.outFd,
      wakeFd: slot.wakeFd,
      toGuest: slot.toGuest,
      fromGuest: slot.fromGuest,
      announce: () => {
        announce(slot);
      },
    };
  }

  const engine: PgrustBrowserEngine = {
    store,
    sharedMemory: memory,
    serverLog: logTail,
    reserveSession,

    openSession(): PgrustSessionPipes {
      const session = reserveSession();
      session.announce();
      return session;
    },

    async shutdown(): Promise<PgrustEngineShutdown> {
      if (stopped) {
        return { exitCode: exitCode ?? -1, shutdownMs: 0, checkpointed: SHUTDOWN_CHECKPOINT_PATTERN.test(serverLog) };
      }
      stopped = true;
      const startedAt = performance.now();
      // The listener reaching EOF IS the fast-shutdown request: `pqcomm_hostpipes` turns it into the
      // very handler a SIGINT runs, and what follows is Postgres's own ceremony.
      listener.close();
      wake.write(new Uint8Array([0]), { block: false });
      await Promise.race([
        exited.promise,
        new Promise((resolve) => setTimeout(resolve, options.exitDeadlineMs ?? EXIT_TIMEOUT_MS)),
      ]);
      const shutdownMs = performance.now() - startedAt;
      // The last stderr chunks can still be in flight when `exit` lands; give them one turn.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const checkpointed = SHUTDOWN_CHECKPOINT_PATTERN.test(serverLog);
      processWorker.terminate();
      doorbell.requestStop();
      await Promise.race([
        storageStopped.promise,
        new Promise((resolve) => setTimeout(resolve, STORAGE_STOP_TIMEOUT_MS)),
      ]);
      // Last: the coordinator closes the store — releasing its four synchronous access handles —
      // before it reports it has stopped, so an OPFS directory can only be removed after this.
      storageWorker.terminate();
      return { exitCode: exitCode ?? -1, shutdownMs, checkpointed };
    },
  };

  try {
    await withTimeout(poolReady.promise, POOL_READY_TIMEOUT_MS, "the thread pool did not prewarm");
    await withTimeout(
      postmasterReady.promise,
      POSTMASTER_READY_TIMEOUT_MS,
      'the postmaster never reached "ready to accept connections"',
    );
  } catch (error: unknown) {
    // A server that never accepted leaves live workers behind; close them before rethrowing so a
    // failed boot cannot leave a shared memory and a tree of workers alive for the rest of the page.
    await engine.shutdown().catch(() => {});
    throw error;
  }

  return engine;
}
