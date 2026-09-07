/**
 * The pgrust Postmaster Engine worker — the same wasm module as the `pgrust Threads` Engine, driven
 * as a real Postgres server rather than as one session.
 *
 * **What is different from the threads worker.** That one runs `postgres --stdio-wire-threaded`:
 * one session, on one spawned thread, reading fd 0 and writing fd 1. This one runs
 * `postgres --host-pipes`, which selects a transport and then falls through to `PostmasterMain` —
 * so what boots is a postmaster with a startup process, a checkpointer, a background writer, a WAL
 * writer and a warm standby pool, and every session is a **real backend** on its own guest thread,
 * reached over its own pair of `SharedArrayBuffer` ring pipes. Two sessions here are two backends
 * contending in shared memory and in the lock manager, not two callers of one queue.
 *
 * **The host side of the fd contract** (`crates/backend/libpq/pqcomm_hostpipes`, and the vendored
 * `threads-host.js` that mirrors it). Fd numbering is the host's: the wake channel is fd 999, the
 * listener fd 1000, session `k` reads 1001+2k and writes 1002+2k, and its own wake ring is fd 900+k.
 * Every one of those pipes is created **before the guest starts**, because the registry is handed to
 * the pool workers at prewarm and there is no attaching a ring afterwards — which is why `open` takes
 * the session count rather than growing sessions on demand. A session is announced by writing a
 * 16-byte `HPGP` record (magic, in_fd, out_fd, wake_fd; little-endian) to the listener and one token
 * byte to the wake fd; the postmaster wakes, accepts, spawns the backend, and the backend answers the
 * startup packet. The session's three rings share one **gate** — a futex word every one of them bumps
 * — so a blocked backend parks its `poll` over its in fd and its wake fd on a single `Atomics.wait`,
 * and another backend's `SetLatch` (an async NOTIFY, say) ends that park at once rather than at the
 * end of the guest's 100 ms interrupt poll.
 *
 * **The filesystem is the broker's, always.** With a private copy of the packed image per worker the
 * checkpointer could not see a relation file a backend had just created, and the shutdown checkpoint
 * — the thing that makes this a Postgres shutdown rather than a process kill — would fail. So this
 * Engine starts the storage coordinator first, on either of the store's two ports, exactly as the
 * broker threads columns do.
 *
 * **This thread never blocks.** Every wait on shared memory goes through `SabPipe.readAsync`
 * (`Atomics.waitAsync`); the blocking half of that API belongs to the guest's own workers. Each
 * session has its own pump, so a backend blocked on another backend's row lock parks that backend
 * and nothing else — which is the whole property the Concurrency Suite is here to measure.
 *
 * **Shutdown is Postgres's own.** Each session is sent Terminate, then the listener pipe is closed:
 * that EOF is what `pqcomm_hostpipes` turns into a fast-shutdown request, the same flag a SIGINT
 * raises. The guest then walks its ordinary ceremony — stop backends, wait for them, shutdown
 * checkpoint, `exit(0)` — and this worker waits for that exit instead of terminating a worker out
 * from under a running server. Only then does the coordinator get its doorbell stop, and only then
 * can the store's OPFS directory be removed.
 *
 * Like every other Engine worker: no wasm module cache, no reuse of anything across Runs, and every
 * worker it creates is terminated in `close`.
 */

import { removeOpfsDirectory } from "../../opfs";
import type * as BrokerFs from "../../vendor/pgrust/broker-fs.js";
import type { RepackedChannel, RepackedDoorbell } from "../../vendor/pgrust/broker-fs.js";
import type { VfsManifest } from "../../vendor/pgrust/pgrust-wasi.js";
import type * as SabPipes from "../../vendor/pgrust/sab-pipe.js";
import type { SabPipe } from "../../vendor/pgrust/sab-pipe.js";
import type * as ThreadsHost from "../../vendor/pgrust/threads-host.js";
import type { WireMessage } from "../../vendor/pgrust/wire.js";
import { encodeQuery, encodeStartup, TERMINATE, WireReader } from "../../vendor/pgrust/wire.js";
import { defaultWireArgv } from "../../vendor/pgrust/wiresession.js";
import { SHARED_MEMORY_REQUIREMENT_MESSAGE } from "../availability";
import type { EngineOpenOptions, PgrustThreadsPort, StoreDurability } from "../contract";
import { pgrustPostmasterOptions, requestedSessions } from "../contract";
import type { QueryResult } from "../pgrust/pgwire";
import { assertNoQueryError, decodeQueryResult } from "../pgrust/pgwire";
import { toErrorPayload } from "../protocol";
import type { EngineOkResponse, EngineReadyMessage, EngineRequest, EngineResponse, EngineStats } from "../protocol";
import type { ScenarioExecutor } from "../scenario-runner";
import { runScenario } from "../scenario-runner";

type ThreadsHostModule = typeof ThreadsHost;
type SabPipeModule = typeof SabPipes;
type BrokerFsModule = typeof BrokerFs;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Static files under `public/pgrust/`, addressed through the app's base, as the other workers do. */
const ASSET_BASE = `${import.meta.env.BASE_URL.replace(/\/+$/, "")}/pgrust`;

/** The vendored host JS, absolute so `new URL("./x", base)` inside the host resolves. */
const HOST_BASE = new URL(`${ASSET_BASE}/host/`, ctx.location.href).href;

const SYNC_HINT = "Run `bun run sync:pgrust` after building the pgrust wasm assets.";

/**
 * The prewarmed `wasi` `thread-spawn` pool: twelve slots for the server, plus one per session.
 *
 * A postmaster claims far more threads than a wire session does — the startup process, the
 * checkpointer, the background writer, the WAL writer, the memory watchdog, the timeout timer, the
 * background-job dispatcher, the lease sweeper, and `max_parallel_workers` parked warm standbys —
 * and `thread-spawn` cannot create a worker on demand (it is microseconds from a futex park and may
 * not await), so an undersized pool is a hard `-EAGAIN` rather than a wait. Twelve is pgrust's own
 * postmaster-lane default; the sessions are what this Engine adds to it.
 */
const POOL_BASE_SIZE = 12;

/** The warm standby pool the postmaster keeps, and pgrust's own browser harness's number. */
const MAX_PARALLEL_WORKERS = 2;

/**
 * How many sessions one Run may open.
 *
 * Every pipe is created before the guest starts, so this is a real ceiling rather than a policy:
 * the number of rings, and the pool that must have a slot for each of their backends, are fixed at
 * boot. Four is what the Concurrency Suite asks for.
 */
const MAX_SESSIONS = 8;

/** stdin/stdout of the postmaster process itself: nothing rides them, but the host wants the pair. */
const STDIN_CAPACITY = 1 << 16;
const STDOUT_CAPACITY = 1 << 16;

/** The listener ring carries 16-byte records; one page holds every session this Engine allows. */
const LISTENER_CAPACITY = 1 << 12;
/** The wake ring: sized far past anything that can queue, because a full one would block a SetLatch. */
const WAKE_CAPACITY = 1 << 16;
/** One session's own wake ring, sized for the same reason as the postmaster's. */
const SESSION_WAKE_CAPACITY = 1 << 16;
/** Per session, client to backend: 1 MiB, the size the guest's own stdin ring uses. */
const SESSION_TO_GUEST_CAPACITY = 1 << 20;
/** Per session, backend to client: 4 MiB, because result sets are the large direction. */
const SESSION_FROM_GUEST_CAPACITY = 1 << 22;

/** `HPGP` in stream order: the connection record's magic. */
const CONNECTION_MAGIC = 0x50475048;
/** The connection record is four little-endian 32-bit words. */
const CONNECTION_RECORD_BYTES = 16;

const STORAGE_READY_TIMEOUT_MS = 180_000;
const POOL_READY_TIMEOUT_MS = 120_000;
/** How long to wait for the postmaster to log that it is accepting connections. */
const POSTMASTER_READY_TIMEOUT_MS = 180_000;
/** How long one session may take from its connection record to its ReadyForQuery. */
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** How long to wait for the guest's own exit after the listener has been closed. */
const EXIT_TIMEOUT_MS = 60_000;
const STORAGE_STOP_TIMEOUT_MS = 5_000;

const DIRECTORY_REMOVAL_ATTEMPTS = 5;
const DIRECTORY_REMOVAL_RETRY_MS = 250;

/** Keep only the tail of the server log: enough to explain a failure, bounded for a long Run. */
const MAX_SERVER_LOG_CHARS = 8_000;

/** What the postmaster logs once it will accept a connection record. */
const READY_LOG_PATTERN = /database system is ready to accept connections/i;
/** What a clean stop logs, and the difference between a shutdown and a process that merely stopped. */
const SHUTDOWN_CHECKPOINT_PATTERN = /checkpoint starting: shutdown/i;

/** One decoder for the whole Run: a multi-byte character can straddle two stderr chunks. */
const stderrDecoder = new TextDecoder("utf-8", { fatal: false });
let serverLog = "";

function post(message: EngineResponse): void {
  ctx.postMessage(message);
}

function ok(id: number, measurement: EngineOkResponse["measurement"]): void {
  post({ kind: "ok", id, measurement });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A dead server is only explicable from its log, so carry the tail into the thrown Error. */
function withServerLog(message: string): Error {
  const log = serverLog.trim();
  return new Error(log === "" ? message : `${message}\nserver log:\n${log}`);
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

/** One turn of the event loop, so a full ring can be drained by whoever is draining it. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** What one simple-query cycle collects: the messages up to and including ReadyForQuery. */
interface Collector {
  readonly messages: WireMessage[];
  readonly settle: Gate;
}

/**
 * One pgwire session over one pair of host-pipe rings, and therefore one real backend.
 *
 * Each session owns its own reader, its own collector and its own pump, which is what lets N of them
 * be in flight at once: a backend parked on another backend's lock parks nothing here. The window a
 * Measurement covers is the same one the two other pgrust Engines measure — the `Q` frame through
 * ReadyForQuery, plus the decode into JS rows — so a postmaster backend and a wire session can be
 * read off one table.
 */
class PipeSession {
  readonly index: number;
  readonly inFd: number;
  readonly outFd: number;
  /** This session's wake fd, which travels in its connection record; 0 would mean "none". */
  readonly wakeFd: number;
  readonly #toGuest: SabPipe;
  readonly #fromGuest: SabPipe;
  readonly #reader = new WireReader();
  #collector: Collector | null = null;
  #closed = false;
  /** Resolves the first time the backend writes anything: the accept-to-first-byte latency. */
  #onFirstByte: (() => void) | null = null;
  readonly pump: Promise<void>;

  constructor(index: number, inFd: number, outFd: number, wakeFd: number, toGuest: SabPipe, fromGuest: SabPipe) {
    this.index = index;
    this.inFd = inFd;
    this.outFd = outFd;
    this.wakeFd = wakeFd;
    this.#toGuest = toGuest;
    this.#fromGuest = fromGuest;
    this.pump = this.#drain();
    this.pump.catch(() => {});
  }

  /** Drain this session's backend-to-client ring for as long as the backend holds it open. */
  async #drain(): Promise<void> {
    const scratch = new Uint8Array(65_536);
    for (;;) {
      const read = await this.#fromGuest.readAsync(scratch, scratch.length);
      if (read === 0) {
        break;
      }
      // slice(), not subarray(): the ring's bytes are reused by the next read.
      this.#feed(scratch.slice(0, read));
    }
    this.#closed = true;
    this.fail(new Error(`pgrust postmaster: session ${this.index} was closed by the backend`));
  }

  get closed(): boolean {
    return this.#closed;
  }

  #feed(bytes: Uint8Array): void {
    const first = this.#onFirstByte;
    if (first !== null) {
      this.#onFirstByte = null;
      first();
    }
    this.#reader.feed(bytes);
    for (;;) {
      const message = this.#reader.next();
      if (message === null) {
        return;
      }
      // Unsolicited (a NoticeResponse between cycles) belongs to no cycle; the wire lane of pgrust's
      // own harness drops it the same way.
      const collector = this.#collector;
      if (collector === null) {
        continue;
      }
      collector.messages.push(message);
      if (message.t === "Z") {
        this.#collector = null;
        collector.settle.open();
      }
    }
  }

  /** Settle a cycle that can no longer complete, so a dead backend does not hang its client. */
  fail(error: Error): void {
    const collector = this.#collector;
    this.#collector = null;
    collector?.settle.fail(error);
  }

  onFirstByte(callback: () => void): void {
    this.#onFirstByte = callback;
  }

  #collect(): Promise<readonly WireMessage[]> {
    if (this.#collector !== null) {
      return Promise.reject(new Error(`pgrust postmaster: overlapping simple-query cycles on session ${this.index}`));
    }
    const pending: Collector = { messages: [], settle: gate() };
    this.#collector = pending;
    return pending.settle.promise.then(() => pending.messages);
  }

  /**
   * Enqueue frontend bytes without ever parking this thread.
   *
   * A short write is normal rather than exceptional — a Speedtest script is twice the session ring —
   * and blocking through one would stop every pump in this worker, including the one the backend is
   * waiting on. Yielding is only reached when the ring is actually full.
   */
  async send(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      offset += this.#toGuest.write(bytes.subarray(offset), { block: false });
      if (offset < bytes.length) {
        await yieldToEventLoop();
      }
    }
  }

  /** The startup packet and everything through the first ReadyForQuery. */
  async startup(applicationName: string): Promise<QueryResult> {
    const pending = this.#collect();
    await this.send(encodeStartup({ user: "postgres", database: "postgres", application_name: applicationName }));
    return decodeQueryResult(await pending);
  }

  /**
   * One simple-query cycle, timed.
   *
   * The clock starts immediately before the `Q` frame is enqueued and stops once the cycle's
   * messages are decoded into rows. Installing the collector is bookkeeping and stays outside it.
   */
  async query(sql: string): Promise<{ result: QueryResult; elapsedMs: number }> {
    const frame = encodeQuery(sql);
    const pending = this.#collect();
    const startTime = performance.now();
    await this.send(frame);
    const result = decodeQueryResult(await pending);
    return { result, elapsedMs: performance.now() - startTime };
  }

  async terminate(): Promise<void> {
    await this.send(TERMINATE);
  }

  /** Whether the backend closed its end (its `secure_close`, seen here as EOF on the out ring). */
  async waitClosed(timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (!this.#closed && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.#closed;
  }
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

function asHostEvent(message: unknown): HostEvent {
  return typeof message === "object" && message !== null ? (message as HostEvent) : {};
}

/** Messages the storage coordinator sends back; a different protocol from the process worker's. */
interface StorageEvent {
  readonly type?: string;
  readonly message?: string;
  readonly errorName?: string;
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

function asStorageEvent(message: unknown): StorageEvent {
  return typeof message === "object" && message !== null ? (message as StorageEvent) : {};
}

/** Everything one Run of this Engine owns, so `close` can take all of it away again. */
interface PostmasterRun {
  readonly processWorker: Worker;
  readonly storageWorker: Worker;
  readonly doorbell: RepackedDoorbell;
  readonly listener: SabPipe;
  readonly wake: SabPipe;
  readonly sessions: readonly PipeSession[];
  /** Resolves when the guest reports its exit code. */
  readonly exited: Gate;
  /** Resolves when the coordinator reports it has stopped. */
  readonly storageStopped: Gate;
}

let run: PostmasterRun | null = null;

/**
 * The OPFS directory this Run's store owns, or null on the memory port.
 *
 * Set before the coordinator is started rather than after: a coordinator that fails half way through
 * booting has already created the directory, and `close` — which is called on that path too — is
 * what takes it away again.
 */
let storeDirectory: string | null = null;

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
  return WebAssembly.compile(await buffered.arrayBuffer());
}

/**
 * Load one vendored host module from `public/pgrust/host/`.
 *
 * `@vite-ignore` because the specifier is a run-time URL: these files are served verbatim, not
 * bundled, and a bundled copy would resolve `./thread-worker.js` against a hashed chunk name.
 */
async function loadHostModule<T>(name: string): Promise<T> {
  const url = `${HOST_BASE}${name}`;
  try {
    return (await import(/* @vite-ignore */ url)) as T;
  } catch (error: unknown) {
    throw new Error(`pgrust threads host module ${url} could not be loaded (${describe(error)}). ${SYNC_HINT}`);
  }
}

/**
 * The postmaster's argv: the wire lanes' GUCs, `PostmasterMain`'s shape.
 *
 * `defaultWireArgv()` is the shared source of the engine GUCs, so the postmaster column and the
 * session columns cannot drift apart on one. What changes is the dispatch (`--host-pipes`, which
 * picks a transport and then falls through to the ordinary postmaster), the trailing database name
 * (a postmaster's getopt rejects it), the two GUCs that make the host fd the only way in, and the
 * warm standby pool, which has to be bounded because a fixed host thread pool is what backs it.
 */
function postmasterArgv(): string[] {
  const argv = defaultWireArgv();
  argv[1] = "--host-pipes";
  argv.pop();
  argv.push(
    "-c",
    "listen_addresses=",
    "-c",
    "unix_socket_directories=",
    // So a shutdown that did or did not run its checkpoint says which in the log this worker keeps.
    "-c",
    "log_checkpoints=on",
    "-c",
    `max_parallel_workers=${MAX_PARALLEL_WORKERS}`,
  );
  return argv;
}

/** The guest environment: the wire lanes' plus the two fds that are this transport's whole contract. */
function guestEnv(host: ThreadsHostModule): Readonly<Record<string, string>> {
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
  };
}

/** Where this Run's one store lives and how durably. */
interface StoragePortSettings {
  readonly port: PgrustThreadsPort;
  readonly durability: StoreDurability;
  /** The OPFS directory the coordinator owns in full; empty string on the memory port. */
  readonly directory: string;
}

interface StorageBootOptions {
  readonly port: PgrustThreadsPort;
  readonly durability: StoreDurability;
  readonly opfsDir?: string;
  readonly reset?: boolean;
}

function storageBootOptions(settings: StoragePortSettings): StorageBootOptions {
  return settings.port === "opfs"
    ? { port: "opfs", opfsDir: settings.directory, durability: settings.durability, reset: true }
    : { port: "memory", durability: settings.durability };
}

/** One line of what the store cost this Run, none of which is inside any Measurement window. */
function describeStorageReady(event: StorageEvent): string {
  const where = event.opfsDir === undefined || event.opfsDir === null ? "" : ` dir=${event.opfsDir}`;
  const seeded = `seeded ${event.files ?? 0} files (${event.bytes ?? 0} bytes) in ${event.seedMs ?? 0} ms`;
  return (
    `pgrust postmaster storage: port=${event.port ?? "?"}${where} durability=${event.durability ?? "?"}; ` +
    `store opened in ${event.openMs ?? 0} ms, ${seeded}; /pgdata holds ${event.datadirFiles ?? 0} files ` +
    `(${event.datadirBytes ?? 0} bytes) in a ${((event.arenaBytes ?? 0) / 1_048_576).toFixed(1)} MiB arena`
  );
}

interface StorageCoordinator {
  readonly worker: Worker;
  readonly doorbell: RepackedDoorbell;
  /** One per pool slot, plus one for the process instance. */
  readonly channels: readonly RepackedChannel[];
  readonly bundleUrl: string;
}

/** Start the storage coordinator and wait for it to seed its store. Always, on this Engine. */
async function startStorageCoordinator(
  host: ThreadsHostModule,
  brokerFs: BrokerFsModule,
  image: ArrayBuffer,
  manifest: VfsManifest,
  storageStopped: Gate,
  settings: StoragePortSettings,
  poolSize: number,
): Promise<StorageCoordinator> {
  const bundleUrl = brokerFs.repackedBundleUrl(HOST_BASE);
  let bundle;
  try {
    bundle = await brokerFs.loadRepackedBundle(bundleUrl);
  } catch (error: unknown) {
    throw new Error(
      `the pre-release @pgxsinkit/pglite-opfs-repacked bundle at ${bundleUrl} could not be loaded ` +
        `(${describe(error)}). It is not the published package: run \`bun run sync:pgrust\` with ` +
        "PGXSINKIT_DIR pointing at a pgxsinkit checkout that has built it.",
    );
  }

  const doorbell = bundle.RepackedDoorbell.create();
  // One channel per pool slot PLUS one for the process instance: the protocol is one request in
  // flight per channel, so two agents may never share one.
  const channels = Array.from({ length: poolSize + 1 }, (_unused, index) =>
    bundle.RepackedChannel.create({ id: index + 1, doorbell }),
  );

  const worker = host.makeWorker(host.storageWorkerUrl(HOST_BASE), { name: "pgrust-postmaster-storage" });
  const ready = gate();
  host.onWorkerMessage(worker, (raw: unknown) => {
    const event = asStorageEvent(raw);
    switch (event.type) {
      case "storage-ready":
        // A `reset` was asked for, so a coordinator reporting it RESTORED a data directory found one
        // this Run did not put there. Those would be a warm store's numbers under a cold store's
        // label, which is worse than a failed column.
        if (event.restored === true) {
          ready.fail(
            new Error(
              `pgrust postmaster storage opened an existing data directory in "${settings.directory}" ` +
                "despite being asked to reset it; this Run would be measuring an earlier Run's store",
            ),
          );
          return;
        }
        console.info(describeStorageReady(event));
        ready.open();
        return;
      case "storage-stopped":
        storageStopped.open();
        return;
      case "storage-error": {
        const error = new Error(`pgrust postmaster storage ${event.errorName ?? "Error"}: ${event.message ?? ""}`);
        ready.fail(error);
        storageStopped.open();
        return;
      }
      default:
        return;
    }
  });
  host.onWorkerError(worker, (error: Error) => {
    ready.fail(new Error(`pgrust postmaster storage worker threw: ${error.message}`));
    storageStopped.open();
  });

  worker.postMessage(
    {
      kind: "boot",
      bundleUrl,
      image,
      manifest,
      channels: channels.map((channel) => channel.transfer()),
      doorbell: doorbell.buffer,
      options: storageBootOptions(settings),
    },
    [image],
  );

  try {
    await withTimeout(ready.promise, STORAGE_READY_TIMEOUT_MS, "the storage coordinator did not seed its store");
  } catch (error: unknown) {
    // A coordinator that never became ready may still hold four synchronous access handles on the
    // directory this Run is about to remove. Terminating it is what releases them.
    worker.terminate();
    storageStopped.open();
    throw error;
  }
  return { worker, doorbell, channels, bundleUrl };
}

/**
 * The connection record `pqcomm_hostpipes` accepts: magic, in fd, out fd, wake fd.
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

/**
 * Announce one session to the postmaster and complete its pgwire handshake.
 *
 * Every millisecond of this is outside every Measurement: the postmaster has to wake, accept the
 * record, claim a pool slot and spawn a backend before the startup packet is even read, and that is
 * a per-session cost of the transport rather than of a query.
 */
async function openSession(engine: PostmasterRun, session: PipeSession): Promise<number> {
  const announcedAt = performance.now();
  let firstByteMs = 0;
  session.onFirstByte(() => {
    firstByteMs = performance.now() - announcedAt;
  });
  const written = engine.listener.write(connectionRecord(session.inFd, session.outFd, session.wakeFd), {
    block: false,
  });
  if (written !== CONNECTION_RECORD_BYTES) {
    throw new Error(`pgrust postmaster: the listener ring would not take a whole record (${written}/16)`);
  }
  // The wake token is what turns the postmaster's next accept probe into an immediate one.
  engine.wake.write(new Uint8Array([0]), { block: false });

  const handshake = await withTimeout(
    session.startup(`pglite-v-pgrust-${session.index}`),
    HANDSHAKE_TIMEOUT_MS,
    `session ${session.index} never completed its handshake`,
  );
  assertNoQueryError(handshake);
  return firstByteMs;
}

async function openEngine(dataDir: string, options: EngineOpenOptions | undefined): Promise<void> {
  if (!ctx.crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
    throw new Error(SHARED_MEMORY_REQUIREMENT_MESSAGE);
  }
  if (options?.relaxedDurability === true) {
    throw new Error("pgrust postmaster Engine has no relaxed-durability setting");
  }
  const settings = pgrustPostmasterOptions(options);
  const port: PgrustThreadsPort = settings?.port ?? "memory";
  const durability: StoreDurability = settings?.durability ?? "relaxed";
  const sessionCount = requestedSessions(options);
  if (sessionCount > MAX_SESSIONS) {
    throw new Error(`pgrust postmaster Engine opens at most ${MAX_SESSIONS} sessions; ${sessionCount} were asked for`);
  }
  // `dataDir` and the port say the same thing from two sides, and a Configuration that disagreed
  // with itself would either open a store nothing removes or remove a directory nothing opened.
  if (port === "opfs" && dataDir === "") {
    throw new Error("pgrust postmaster Engine on the OPFS port needs a dataDir: its store owns one directory in full");
  }
  if (port === "memory" && dataDir !== "") {
    throw new Error(`pgrust postmaster Engine on the memory port is a Memory Configuration; got dataDir "${dataDir}"`);
  }

  const poolSize = POOL_BASE_SIZE + sessionCount;

  const [host, sab, brokerFs] = await Promise.all([
    loadHostModule<ThreadsHostModule>("threads-host.js"),
    loadHostModule<SabPipeModule>("sab-pipe.js"),
    loadHostModule<BrokerFsModule>("broker-fs.js"),
  ]);

  const [wasmModule, image, manifest] = await Promise.all([
    compileEngineModule(`${ASSET_BASE}/postgres-threads.wasm`),
    fetchAsset(`${ASSET_BASE}/vfs.img`).then(async (response) => await response.arrayBuffer()),
    fetchAsset(`${ASSET_BASE}/vfs.json`).then(async (response) => (await response.json()) as VfsManifest),
  ]);

  const memory = host.createSharedMemory();
  sharedMemory = memory;
  const exited = gate();
  const storageStopped = gate();
  const poolReady = gate();
  const postmasterReady = gate();

  // The coordinator goes first and its store must be seeded before the startup process can read a
  // file: once its blocking serve loop is entered it never reaches its event loop again. It also
  // takes ownership of the packed image.
  //
  // Before it runs, not after: it creates the directory as part of opening the store, and a boot
  // that fails half way through has already created it.
  storeDirectory = port === "opfs" ? dataDir : null;
  let storage: StorageCoordinator;
  try {
    storage = await startStorageCoordinator(
      host,
      brokerFs,
      image,
      manifest,
      storageStopped,
      { port, durability, directory: dataDir },
      poolSize,
    );
  } catch (error: unknown) {
    // Nothing else is up yet, so this is the whole teardown: it takes the directory away.
    await closeEngine();
    throw error instanceof Error ? error : new Error(String(error));
  }

  // The image now lives in the coordinator's store and its ArrayBuffer has been transferred there;
  // every instance gets an empty base VFS the broker adapter sits on top of.
  const guestImage = new ArrayBuffer(0);
  const guestManifest: VfsManifest = { dirs: ["/"], files: [] };

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

  const sessions: PipeSession[] = [];
  for (let index = 0; index < sessionCount; index += 1) {
    const { inFd, outFd } = host.sessionFds(index);
    // ONE GATE PER SESSION: the rings a backend can be waiting on share a futex word, so the host
    // parks its `poll` over the session's in fd AND its wake fd on one `Atomics.wait` instead of
    // slicing between them. Per session, never global — an idle backend wakes on its own traffic.
    const gate = sab.SabPipe.createGate();
    const toGuest = sab.SabPipe.create(SESSION_TO_GUEST_CAPACITY, { gate });
    const fromGuest = sab.SabPipe.create(SESSION_FROM_GUEST_CAPACITY, { gate });
    registry.register(inFd, { in: toGuest });
    registry.register(outFd, { out: fromGuest });
    // Both ends of one ring on one fd, exactly as the postmaster's: any guest thread whose
    // `SetLatch` finds this backend fd-parked writes a token here, and the backend drains it.
    const wakeFd = host.sessionWakeFd(index);
    const wake = sab.SabPipe.create(SESSION_WAKE_CAPACITY, { gate });
    registry.register(wakeFd, { in: wake, out: wake });
    sessions.push(new PipeSession(index, inFd, outFd, wakeFd, toGuest, fromGuest));
  }

  function failEverySession(error: Error): void {
    for (const session of sessions) {
      session.fail(error);
    }
  }

  function collectServerLog(bytes: Uint8Array): void {
    serverLog += stderrDecoder.decode(bytes, { stream: true });
    if (READY_LOG_PATTERN.test(serverLog)) {
      postmasterReady.open();
    }
    if (serverLog.length > MAX_SERVER_LOG_CHARS) {
      serverLog = serverLog.slice(-MAX_SERVER_LOG_CHARS);
    }
  }

  function handleEvent(raw: unknown): void {
    const event = asHostEvent(raw);
    switch (event.type) {
      case "pool-ready":
        poolReady.open();
        return;
      case "stderr":
        if (event.bytes !== undefined) {
          collectServerLog(event.bytes);
        }
        return;
      case "spawn-refused": {
        // A pool too small is a hard -EAGAIN inside the guest, and the Run cannot recover from it.
        const error = withServerLog(
          `pgrust postmaster: wasi thread-spawn refused, the prewarmed pool of ${event.poolSize ?? poolSize} ` +
            "is exhausted",
        );
        poolReady.fail(error);
        postmasterReady.fail(error);
        failEverySession(error);
        return;
      }
      case "exit": {
        exited.open();
        // A server that exits mid-cycle would otherwise leave every session waiting for a
        // ReadyForQuery that can no longer come.
        const error = withServerLog(`pgrust postmaster: the server exited with code ${event.code ?? -1}`);
        postmasterReady.fail(error);
        failEverySession(error);
        return;
      }
      case "error": {
        const error = withServerLog(`pgrust postmaster ${event.from ?? "worker"}: ${event.message ?? "unknown error"}`);
        poolReady.fail(error);
        postmasterReady.fail(error);
        failEverySession(error);
        exited.open();
        return;
      }
      default:
        return;
    }
  }

  const processWorker = host.makeWorker(host.threadWorkerUrl(HOST_BASE), { name: "pgrust-postmaster-process" });
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

  const channels = storage.channels;
  processWorker.postMessage(
    {
      role: "process",
      module: wasmModule,
      memory,
      image: guestImage,
      manifest: guestManifest,
      fs: "broker",
      bundleUrl: storage.bundleUrl,
      channel: channels[0]?.transfer() ?? null,
      poolChannels: channels.slice(1).map((channel) => channel.transfer()),
      stdin: stdin.descriptor(),
      stdout: stdout.descriptor(),
      // The whole of this transport: the listener, the wake channel and every session's pair.
      pipes: registry.descriptors(),
      argv: postmasterArgv(),
      env: guestEnv(host),
      poolSize,
      trace: 0,
      relayPorts: relayChannels.map((channel) => channel.port2),
    },
    [guestImage, ...relayChannels.map((channel) => channel.port2)],
  );

  const engine: PostmasterRun = {
    processWorker,
    storageWorker: storage.worker,
    doorbell: storage.doorbell,
    listener,
    wake,
    sessions,
    exited,
    storageStopped,
  };
  run = engine;

  try {
    await withTimeout(poolReady.promise, POOL_READY_TIMEOUT_MS, "the thread pool did not prewarm");
    await withTimeout(
      postmasterReady.promise,
      POSTMASTER_READY_TIMEOUT_MS,
      'the postmaster never reached "ready to accept connections"',
    );
    const acceptLatencies: number[] = [];
    for (const session of sessions) {
      acceptLatencies.push(await openSession(engine, session));
    }
    console.info(
      `pgrust postmaster: ${sessions.length} session(s) accepted, first backend byte after ` +
        `${acceptLatencies.map((ms) => ms.toFixed(0)).join("/")} ms; pool ${poolSize}`,
    );
  } catch (error: unknown) {
    // A server that never accepted leaves live workers behind; close them before rethrowing so a
    // failed column cannot leave a shared memory and a tree of workers alive for the rest of the page.
    await closeEngine();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function requireRun(): PostmasterRun {
  if (run === null) {
    throw new Error("pgrust postmaster Engine is not open");
  }
  return run;
}

/** The session a request names, or a clear failure: a Suite may not address one that was not opened. */
function requireSession(index: number): PipeSession {
  const engine = requireRun();
  const session = engine.sessions[index];
  if (session === undefined) {
    throw new Error(
      `pgrust postmaster Engine has ${engine.sessions.length} session(s); session ${index} was asked for`,
    );
  }
  return session;
}

/**
 * The one shared `WebAssembly.Memory` every instance of this Engine imports.
 *
 * Module-level so the memory probe can ask for its size while the Engine is open. `buffer.byteLength`
 * is what the guest has actually taken: the host asks for 256 MiB up front and a maximum of 4 GiB, so
 * this number says how far past the initial claim the guest has grown — not how much of it is
 * resident, which only the renderer's RSS can say.
 */
let sharedMemory: WebAssembly.Memory | null = null;

function engineStats(): EngineStats {
  return {
    wasmMemories:
      sharedMemory === null ? [] : [{ name: "pgrust shared memory", bytes: sharedMemory.buffer.byteLength }],
  };
}

/**
 * Take down everything this Run created, in the one order that works.
 *
 * The sessions are asked to end first (Terminate, which the backend answers by closing its fds),
 * then the listener is closed — and that EOF is the fast-shutdown request, so what follows is
 * Postgres's own shutdown, not a worker being killed under a running server. Only when the guest has
 * exited on its own does the process worker go, taking its pool workers with it; the coordinator goes
 * last and only through its doorbell, because it is parked in `Atomics.wait` and no `postMessage`
 * will reach it.
 *
 * Then, on the OPFS port, the store's directory: the coordinator's stop is what closed the store and
 * released its handles, so this is the first moment the directory can be removed — and removing it is
 * what keeps this column a cold-store Measurement rather than a slowly growing data directory.
 */
async function closeEngine(): Promise<void> {
  const engine = run;
  run = null;
  sharedMemory = null;
  const directory = storeDirectory;
  storeDirectory = null;
  try {
    if (engine === null) {
      return;
    }
    try {
      for (const session of engine.sessions) {
        if (!session.closed) {
          await session.terminate();
        }
      }
      await Promise.all(engine.sessions.map(async (session) => await session.waitClosed(2_000)));
      engine.listener.close();
      engine.wake.write(new Uint8Array([0]), { block: false });
      await withTimeout(
        engine.exited.promise,
        EXIT_TIMEOUT_MS,
        "the server did not exit after the listener was closed",
      ).catch(() => {});
      if (!SHUTDOWN_CHECKPOINT_PATTERN.test(serverLog)) {
        // Not a failure — the Run's numbers stand — but a shutdown without its checkpoint is worth
        // seeing, because it is the difference between a stopped Postgres and a killed one.
        console.warn("pgrust postmaster: the server log shows no shutdown checkpoint");
      }
    } catch {
      // A server that cannot be asked to stop is terminated below; the Run's result stands.
    }
    engine.processWorker.terminate();
    engine.doorbell.requestStop();
    await Promise.race([
      engine.storageStopped.promise,
      new Promise((resolve) => setTimeout(resolve, STORAGE_STOP_TIMEOUT_MS)),
    ]);
    engine.storageWorker.terminate();
  } finally {
    serverLog = "";
    // Last, and unconditionally: the coordinator closes the store — releasing its four synchronous
    // access handles — before it reports it has stopped, so the directory can only go afterwards.
    if (directory !== null) {
      await removeStoreDirectory(directory);
    }
  }
}

/**
 * Take this Run's OPFS directory away, with a little patience.
 *
 * On the normal path nothing holds it. A Run that gave up waiting terminated a worker which may still
 * hold the four handles for a moment — a browser does not reap a worker parked inside a guest thread
 * instantly — and OPFS answers a removal then with `NoModificationAllowedError`.
 */
async function removeStoreDirectory(path: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await removeOpfsDirectory(path);
      return;
    } catch (error: unknown) {
      if (attempt >= DIRECTORY_REMOVAL_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, DIRECTORY_REMOVAL_RETRY_MS));
    }
  }
}

/**
 * The postmaster's Clients: one Session each, and therefore one real backend each.
 *
 * `resolveSession` is the identity, which is the whole difference between this Engine and every
 * other one: Client `i` speaks to backend `i` over its own rings, and two Clients contending for a
 * row contend in the lock manager rather than in a queue.
 *
 * A `transaction` Step is `BEGIN`, the statements, `COMMIT` — three simple-query cycles on the one
 * Session, timed as one unit by the shared runner. A backend error inside one leaves the Session in
 * a failed transaction, so the rollback is issued here before the Client's next Step: it is part of
 * failing the transaction, not part of the next thing the Client does.
 */
function postmasterExecutor(): ScenarioExecutor {
  const query = async (session: number, sql: string): Promise<QueryResult> => {
    const { result } = await requireSession(session).query(sql);
    return result;
  };
  return {
    resolveSession: (requested) => requested,
    setup: async (session, sql) => {
      assertNoQueryError(await query(session, sql));
    },
    statement: async (session, sql) => {
      const result = await query(session, sql);
      return result.error === null ? undefined : result.error.code;
    },
    transaction: async (session, statements) => {
      assertNoQueryError(await query(session, "BEGIN"));
      for (const sql of statements) {
        const result = await query(session, sql);
        if (result.error !== null) {
          assertNoQueryError(await query(session, "ROLLBACK"));
          return result.error.code;
        }
      }
      const commit = await query(session, "COMMIT");
      return commit.error === null ? undefined : commit.error.code;
    },
  };
}

async function handle(request: EngineRequest): Promise<void> {
  switch (request.kind) {
    case "open": {
      await openEngine(request.dataDir, request.options);
      ok(request.id, null);
      return;
    }
    case "exec": {
      const { result } = await requireSession(request.session ?? 0).query(request.sql);
      assertNoQueryError(result);
      ok(request.id, null);
      return;
    }
    case "measure": {
      const { result, elapsedMs } = await requireSession(request.session ?? 0).query(request.sql);
      assertNoQueryError(result);
      ok(request.id, { elapsedMs });
      return;
    }
    case "concurrent": {
      requireRun();
      const report = await runScenario(request.scenario, postmasterExecutor());
      post({ kind: "ok", id: request.id, measurement: null, report });
      return;
    }
    case "stats": {
      post({ kind: "ok", id: request.id, measurement: null, stats: engineStats() });
      return;
    }
    case "close": {
      await closeEngine();
      ok(request.id, null);
      return;
    }
  }
}

ctx.addEventListener("message", (event: MessageEvent<EngineRequest>) => {
  const request = event.data;
  handle(request).catch((error: unknown) => {
    post(toErrorPayload(request.id, error));
  });
});

post({ kind: "ready" } satisfies EngineReadyMessage);
