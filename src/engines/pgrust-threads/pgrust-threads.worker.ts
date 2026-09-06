/**
 * The pgrust Threads Engine worker — the same pgrust commit as the `pgrust` Engine, built for
 * `wasm32-wasip1-threads` instead of `wasm32-wasip1`.
 *
 * **What is different from the single-session worker.** There is no `WireSession` and no JSPI here.
 * The threads module imports one shared `WebAssembly.Memory`, answers `wasi` `thread-spawn` out of
 * a prewarmed pool of workers, and reads its stdin with a plain blocking `read(0)` — which a Worker
 * is allowed to satisfy by parking in `Atomics.wait` on a `SharedArrayBuffer` ring. So this worker
 * is not a client of a session object: it **is** the driver. It creates the shared memory, the two
 * ring pipes and the process worker, speaks pgwire down the pipes itself, and tears the whole tree
 * down again.
 *
 * **This thread never blocks.** Every wait on shared memory here goes through `SabPipe.readAsync`
 * (`Atomics.waitAsync`); the blocking half of that API belongs to the guest's own workers. A driver
 * that blocked would stop draining stdout, and the guest — blocked writing into a full stdout ring
 * — would never read the next query.
 *
 * **Where the host JS comes from.** `threads-host.js` and the four files around it are vendored
 * byte-verbatim like the single-session host, but they cannot be bundled: they build their workers
 * from URLs computed at run time (`threadWorkerUrl`, `storageWorkerUrl`), which is not the literal
 * form Vite rewrites, and rewriting them here would fork the thing being benchmarked. So
 * `bun run sync:pgrust` lays them out under `public/pgrust/host/` and this module loads them with
 * one `import()` of a run-time URL. Their own relative imports then resolve inside that directory,
 * exactly as they do in pgrust's own `wasm/` tree.
 *
 * The Measurement is taken around the Q frame through ReadyForQuery **plus** the decode into JS
 * rows, which is where the `pgrust` Engine's window ends too (and where PGlite's `exec` ends):
 * CONTEXT.md ends a Measurement when decoded rows or a command tag are available in JS. The two
 * pgrust columns have to be measured the same way or the pair means nothing.
 *
 * Deliberately no wasm module cache and no reuse of anything across Runs, for the same reason the
 * single-session worker has none: a benchmark must not carry hidden state, and every worker this
 * one creates is terminated in `close`.
 */

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
import { pgrustThreadsOptions } from "../contract";
import type { EngineOpenOptions, PgrustThreadsFs } from "../contract";
import type { QueryResult } from "../pgrust/pgwire";
import { assertNoQueryError, decodeQueryResult } from "../pgrust/pgwire";
import { toErrorPayload } from "../protocol";
import type { EngineOkResponse, EngineReadyMessage, EngineRequest, EngineResponse } from "../protocol";

/**
 * The three vendored host modules, loaded from `public/pgrust/host/` rather than bundled.
 *
 * The imports above are type-only — nothing here is bundled from `src/vendor/pgrust/` — so these
 * aliases give `loadHostModule` the exact shape of what it fetches at run time.
 */
type ThreadsHostModule = typeof ThreadsHost;
type SabPipeModule = typeof SabPipes;
type BrokerFsModule = typeof BrokerFs;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Static files under `public/pgrust/`, addressed through the app's base, as the pgrust worker does. */
const ASSET_BASE = `${import.meta.env.BASE_URL.replace(/\/+$/, "")}/pgrust`;

/** The vendored host JS, absolute so `new URL("./x", base)` inside the host resolves. */
const HOST_BASE = new URL(`${ASSET_BASE}/host/`, ctx.location.href).href;

const SYNC_HINT = "Run `bun run sync:pgrust` after building the pgrust wasm assets.";

/**
 * The prewarmed `wasi` `thread-spawn` pool.
 *
 * Four, because `--stdio-wire-threaded` asks for two threads (the session thread, and the
 * pg-timeout-timer thread the first armed timeout creates) and `thread-spawn` cannot create a
 * worker on demand — it is microseconds from a futex park and may not await — so an undersized pool
 * is a hard `-EAGAIN` rather than a wait. Two spare slots are the headroom pgrust's own browser
 * harness runs with.
 */
const POOL_SIZE = 4;

/** stdin: the driver writes queries. 1 MiB, pgrust's own size. */
const STDIN_CAPACITY = 1 << 20;
/** stdout: the guest writes result sets, which are much larger. 4 MiB, pgrust's own size. */
const STDOUT_CAPACITY = 1 << 22;

/** How long to wait for the coordinator to seed its store before giving up on the broker column. */
const STORAGE_READY_TIMEOUT_MS = 180_000;
/** How long to wait for the pool to instantiate `POOL_SIZE` instances over the shared memory. */
const POOL_READY_TIMEOUT_MS = 120_000;
/** How long to wait for the guest to exit after Terminate before terminating its worker anyway. */
const EXIT_TIMEOUT_MS = 30_000;
/** How long to wait for the coordinator's own stop after its doorbell is rung. */
const STORAGE_STOP_TIMEOUT_MS = 5_000;

/** Keep only the tail of the guest's stderr: enough to explain a failure, bounded for a long Run. */
const MAX_STDERR_CHARS = 4_000;

/** One decoder for the whole session: a multi-byte character can straddle two stderr chunks. */
const stderrDecoder = new TextDecoder("utf-8", { fatal: false });
let stderrText = "";

function post(message: EngineResponse): void {
  ctx.postMessage(message);
}

function ok(id: number, measurement: EngineOkResponse["measurement"]): void {
  post({ kind: "ok", id, measurement });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectStderr(bytes: Uint8Array): void {
  stderrText += stderrDecoder.decode(bytes, { stream: true });
  if (stderrText.length > MAX_STDERR_CHARS) {
    stderrText = stderrText.slice(-MAX_STDERR_CHARS);
  }
}

function takeStderr(): string {
  const text = stderrText.trim();
  stderrText = "";
  return text;
}

/** A dead guest is only explicable from its stderr, so carry the tail into the thrown Error. */
function withStderr(message: string): Error {
  const stderr = takeStderr();
  return new Error(stderr === "" ? message : `${message}\nguest stderr:\n${stderr}`);
}

/** Messages the process worker and every pool slot send back; only these fields are read. */
interface HostEvent {
  readonly type?: string;
  readonly from?: string;
  readonly code?: number;
  readonly size?: number;
  readonly message?: string;
  readonly text?: string;
  readonly bytes?: Uint8Array;
  readonly poolSize?: number;
  readonly startArg?: number;
  readonly restored?: boolean;
  readonly errorName?: string;
}

function asHostEvent(message: unknown): HostEvent {
  return typeof message === "object" && message !== null ? (message as HostEvent) : {};
}

/** A promise plus the two settlers, for the several "wait until the guest says so" points. */
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
  // An unobserved rejection is a console error in every browser; every gate is awaited, but a gate
  // that fails after its await has already returned would otherwise be one.
  promise.catch(() => {});
  return { promise, open, fail };
}

async function withTimeout(promise: Promise<void>, ms: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`pgrust threads: ${what} after ${ms} ms`));
    }, ms);
  });
  try {
    await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Everything one Run of the threads Engine owns, so `close` can take all of it away again. */
interface ThreadsSession {
  readonly processWorker: Worker;
  readonly storageWorker: Worker | null;
  readonly doorbell: RepackedDoorbell | null;
  readonly stdin: SabPipe;
  /** Resolves when the guest reports its exit code. */
  readonly exited: Gate;
  /** Resolves when the coordinator reports it has stopped. */
  readonly storageStopped: Gate;
  /** Resolves when the stdout pump reaches EOF. */
  readonly pump: Promise<void>;
  /** Install a collector and return the messages of one cycle, up to and including ReadyForQuery. */
  readonly collect: () => Promise<readonly WireMessage[]>;
  /** Enqueue frontend bytes without ever blocking this thread. */
  readonly send: (bytes: Uint8Array) => Promise<void>;
}

let session: ThreadsSession | null = null;

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
 * The guest's argv: the single-session column's argv with the dispatch swapped.
 *
 * Taken from the vendored `defaultWireArgv()` rather than written out, so the two pgrust columns
 * cannot drift apart on a GUC. Only `argv[1]` differs, which is the whole point of the pair.
 */
function threadsWireArgv(): string[] {
  const argv = defaultWireArgv();
  argv[1] = "--stdio-wire-threaded";
  return argv;
}

/** The guest environment, matching pgrust's own browser harness. */
const GUEST_ENV: Readonly<Record<string, string>> = {
  USER: "postgres",
  PGRUST_TZDIR: "/share/timezone",
  PGRUST_PGSHAREDIR: "/share",
  // The guest's own async runtime is off: this build runs the session on a real wasi thread.
  PGRUST_RUNTIME: "0",
  RUST_BACKTRACE: "1",
};

/** The coordinator worker plus everything the process worker needs to reach it. */
interface StorageCoordinator {
  readonly worker: Worker;
  readonly doorbell: RepackedDoorbell;
  /** One per pool slot, plus one for the process instance. */
  readonly channels: readonly RepackedChannel[];
  readonly bundleUrl: string;
}

/** Start the storage coordinator and wait for it to seed its store. Broker Configuration only. */
async function startStorageCoordinator(
  host: ThreadsHostModule,
  brokerFs: BrokerFsModule,
  image: ArrayBuffer,
  manifest: VfsManifest,
  storageStopped: Gate,
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
  const channels = Array.from({ length: POOL_SIZE + 1 }, (_unused, index) =>
    bundle.RepackedChannel.create({ id: index + 1, doorbell }),
  );

  const worker = host.makeWorker(host.storageWorkerUrl(HOST_BASE), { name: "pgrust-threads-storage" });
  const ready = gate();
  host.onWorkerMessage(worker, (raw: unknown) => {
    const event = asHostEvent(raw);
    switch (event.type) {
      case "storage-ready":
        ready.open();
        return;
      case "storage-stopped":
        storageStopped.open();
        return;
      case "storage-error": {
        // The store's failures name their own class, and the name is the difference between an
        // actionable line and "the storage worker failed".
        const error = new Error(`pgrust threads storage ${event.errorName ?? "Error"}: ${event.message ?? ""}`);
        ready.fail(error);
        storageStopped.open();
        return;
      }
      default:
        return;
    }
  });
  host.onWorkerError(worker, (error: Error) => {
    ready.fail(new Error(`pgrust threads storage worker threw: ${error.message}`));
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
      // The memory port: the one store lives in the coordinator's heap and dies with it, so this
      // stays a Memory Configuration and no Run can read back an earlier Run's data directory.
      options: { port: "memory", durability: "relaxed" },
    },
    [image],
  );

  await withTimeout(ready.promise, STORAGE_READY_TIMEOUT_MS, "the storage coordinator did not seed its store");
  return { worker, doorbell, channels, bundleUrl };
}

async function openEngine(dataDir: string, options: EngineOpenOptions | undefined): Promise<void> {
  if (!ctx.crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
    throw new Error(SHARED_MEMORY_REQUIREMENT_MESSAGE);
  }
  if (dataDir !== "") {
    throw new Error(`pgrust threads Engine supports only the Memory Configuration; got dataDir "${dataDir}"`);
  }
  if (options?.relaxedDurability === true) {
    throw new Error("pgrust threads Engine has no relaxed-durability setting");
  }
  const fs: PgrustThreadsFs = pgrustThreadsOptions(options)?.fs ?? "copy";

  const [host, sab] = await Promise.all([
    loadHostModule<ThreadsHostModule>("threads-host.js"),
    loadHostModule<SabPipeModule>("sab-pipe.js"),
  ]);

  const [wasmModule, image, manifest] = await Promise.all([
    compileEngineModule(`${ASSET_BASE}/postgres-threads.wasm`),
    fetchAsset(`${ASSET_BASE}/vfs.img`).then(async (response) => await response.arrayBuffer()),
    fetchAsset(`${ASSET_BASE}/vfs.json`).then(async (response) => (await response.json()) as VfsManifest),
  ]);

  const memory = host.createSharedMemory();
  const exited = gate();
  const storageStopped = gate();

  // The coordinator goes first and its store must be seeded before the first backend can ask for a
  // file: once its blocking serve loop is entered it never reaches its event loop again, so there
  // is no attaching anything afterwards. It also takes ownership of the packed image.
  let storage: StorageCoordinator | null = null;
  if (fs === "broker") {
    const brokerFs = await loadHostModule<BrokerFsModule>("broker-fs.js");
    storage = await startStorageCoordinator(host, brokerFs, image, manifest, storageStopped);
  } else {
    storageStopped.open();
  }

  // With the broker the image now lives in the coordinator's store and its ArrayBuffer has been
  // transferred there; every instance gets an empty base VFS the adapter sits on top of.
  const guestImage = fs === "broker" ? new ArrayBuffer(0) : image;
  const guestManifest: VfsManifest = fs === "broker" ? { dirs: ["/"], files: [] } : manifest;

  const stdin = sab.SabPipe.create(STDIN_CAPACITY);
  const stdout = sab.SabPipe.create(STDOUT_CAPACITY);

  const poolReady = gate();
  let collector: { readonly messages: WireMessage[]; readonly settle: Gate } | null = null;
  const reader = new WireReader();

  function failCollector(error: Error): void {
    const pending = collector;
    collector = null;
    pending?.settle.fail(error);
  }

  function feed(bytes: Uint8Array): void {
    reader.feed(bytes);
    for (;;) {
      const message = reader.next();
      if (message === null) {
        return;
      }
      // Unsolicited (a NoticeResponse between cycles) has no cycle to belong to; the wire lane of
      // pgrust's own harness drops it the same way.
      if (collector === null) {
        continue;
      }
      collector.messages.push(message);
      if (message.t === "Z") {
        const finished = collector;
        collector = null;
        finished.settle.open();
      }
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
          collectStderr(event.bytes);
        }
        return;
      case "spawn-refused": {
        // A pool too small is a hard -EAGAIN inside the guest, and the Run cannot recover from it.
        const error = withStderr(
          `pgrust threads: wasi thread-spawn refused, the prewarmed pool of ${event.poolSize ?? POOL_SIZE} is exhausted`,
        );
        poolReady.fail(error);
        failCollector(error);
        return;
      }
      case "exit":
        exited.open();
        // A guest that exits mid-cycle would otherwise leave the cycle waiting for a ReadyForQuery
        // that can no longer come.
        failCollector(withStderr(`pgrust threads: guest exited with code ${event.code ?? -1}`));
        return;
      case "error": {
        const error = withStderr(`pgrust threads ${event.from ?? "worker"}: ${event.message ?? "unknown error"}`);
        poolReady.fail(error);
        failCollector(error);
        exited.open();
        return;
      }
      default:
        return;
    }
  }

  const processWorker = host.makeWorker(host.threadWorkerUrl(HOST_BASE), { name: "pgrust-threads-process" });
  host.onWorkerMessage(processWorker, handleEvent);
  host.onWorkerError(processWorker, (error: Error) => {
    handleEvent({ type: "error", from: "process", message: error.message });
  });

  // A spawned thread reports here directly: from the moment the guest joins, the process worker is
  // parked in a futex and relays nothing.
  const relayChannels = Array.from({ length: POOL_SIZE }, () => host.newMessageChannel());
  for (const channel of relayChannels) {
    host.onPortMessage(channel.port1, handleEvent);
  }

  const channels = storage?.channels ?? [];
  processWorker.postMessage(
    {
      role: "process",
      module: wasmModule,
      memory,
      image: guestImage,
      manifest: guestManifest,
      fs,
      bundleUrl: storage?.bundleUrl ?? null,
      channel: channels.length > 0 ? channels[0]?.transfer() : null,
      poolChannels: channels.slice(1).map((channel) => channel.transfer()),
      stdin: stdin.descriptor(),
      stdout: stdout.descriptor(),
      // The host-owned fd registry is the postmaster lane's; a wire session has only fd 0/1/2.
      pipes: {},
      argv: threadsWireArgv(),
      env: GUEST_ENV,
      poolSize: POOL_SIZE,
      trace: 0,
      relayPorts: relayChannels.map((channel) => channel.port2),
    },
    [guestImage, ...relayChannels.map((channel) => channel.port2)],
  );

  const pump = (async (): Promise<void> => {
    const scratch = new Uint8Array(65_536);
    for (;;) {
      const read = await stdout.readAsync(scratch, scratch.length);
      if (read === 0) {
        break;
      }
      // slice(), not subarray(): the ring's bytes are reused by the next read.
      feed(scratch.slice(0, read));
    }
    failCollector(withStderr("pgrust threads: the guest closed stdout"));
  })();
  pump.catch(() => {});

  /**
   * Enqueue frontend bytes without ever parking this thread.
   *
   * A Speedtest script is up to 2 MB, twice the stdin ring, so a short write is normal rather than
   * exceptional — and blocking through it would stop the stdout pump and deadlock against a guest
   * blocked on a full stdout ring. Yielding is only reached when the ring is actually full.
   */
  async function send(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      offset += stdin.write(bytes.subarray(offset), { block: false });
      if (offset < bytes.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  function collect(): Promise<readonly WireMessage[]> {
    if (collector !== null) {
      return Promise.reject(new Error("pgrust threads: overlapping simple-query cycles"));
    }
    const pending = { messages: [] as WireMessage[], settle: gate() };
    collector = pending;
    return pending.settle.promise.then(() => pending.messages);
  }

  session = {
    processWorker,
    storageWorker: storage?.worker ?? null,
    doorbell: storage?.doorbell ?? null,
    stdin,
    exited,
    storageStopped,
    pump,
    collect,
    send,
  };

  try {
    await withTimeout(poolReady.promise, POOL_READY_TIMEOUT_MS, "the thread pool did not prewarm");
    const handshake = collect();
    await send(encodeStartup({ user: "postgres", database: "postgres", application_name: "pglite-v-pgrust" }));
    assertNoQueryError(decodeQueryResult(await handshake));
  } catch (error: unknown) {
    // A guest that never handshook leaves live workers behind; close them before rethrowing so a
    // failed column cannot leave a shared memory and five workers alive for the rest of the page.
    await closeEngine();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function requireSession(): ThreadsSession {
  if (session === null) {
    throw new Error("pgrust threads Engine is not open");
  }
  return session;
}

/**
 * One simple-query cycle, timed.
 *
 * The clock starts immediately before the `Q` frame is enqueued and stops once the cycle's messages
 * are decoded into rows — the same window the `pgrust` Engine measures, and the one CONTEXT.md
 * defines. Installing the collector is bookkeeping and stays outside it; so does the backend-error
 * check, because an errored Benchmark fails the Run rather than recording a time.
 */
async function measureQuery(sql: string): Promise<{ result: QueryResult; elapsedMs: number }> {
  const engine = requireSession();
  stderrText = "";
  const frame = encodeQuery(sql);
  const pending = engine.collect();
  const startTime = performance.now();
  await engine.send(frame);
  const result = decodeQueryResult(await pending);
  const elapsedMs = performance.now() - startTime;
  return { result, elapsedMs };
}

/**
 * Take down everything this Run created, in the one order that works.
 *
 * The guest is asked to exit first (Terminate, then stdin EOF), because its threads are parked in
 * futexes inside the process worker and inside every pool slot. The process worker goes next, which
 * takes its pool workers with it — they are dedicated workers it owns. The coordinator goes last,
 * and only through its doorbell: it is parked in `Atomics.wait` and no `postMessage` will reach it.
 */
async function closeEngine(): Promise<void> {
  const engine = session;
  session = null;
  if (engine === null) {
    return;
  }
  try {
    await engine.send(TERMINATE);
    engine.stdin.close();
    await withTimeout(engine.exited.promise, EXIT_TIMEOUT_MS, "the guest did not exit after Terminate").catch(() => {});
    await Promise.race([engine.pump, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  } catch {
    // A guest that cannot be asked to exit is terminated below; the Run's result stands.
  }
  engine.processWorker.terminate();
  const storageWorker = engine.storageWorker;
  if (storageWorker !== null) {
    engine.doorbell?.requestStop();
    await Promise.race([
      engine.storageStopped.promise,
      new Promise((resolve) => setTimeout(resolve, STORAGE_STOP_TIMEOUT_MS)),
    ]);
    storageWorker.terminate();
  }
}

async function handle(request: EngineRequest): Promise<void> {
  switch (request.kind) {
    case "open": {
      await openEngine(request.dataDir, request.options);
      ok(request.id, null);
      return;
    }
    case "exec": {
      const { result } = await measureQuery(request.sql);
      assertNoQueryError(result);
      ok(request.id, null);
      return;
    }
    case "measure": {
      const { result, elapsedMs } = await measureQuery(request.sql);
      assertNoQueryError(result);
      ok(request.id, { elapsedMs });
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
