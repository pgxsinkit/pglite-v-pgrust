/**
 * Boot a pgrust postmaster under bun and hand out sessions.
 *
 * The same server the `pgrust Postmaster` Engine column runs in the browser
 * (`src/engines/pgrust-postmaster/pgrust-postmaster.worker.ts`), reduced to what a command-line
 * scenario needs and driven through the vendored host's Node half: `IS_NODE` sends
 * `threadWorkerUrl`/`storageWorkerUrl` at the `.mjs` entries beside the `.js` they re-export, and
 * `makeWorker` builds `node:worker_threads` workers instead of browser ones. Nothing else differs —
 * the fd contract, the pool arithmetic, the broker store and the shutdown are the Engine's, and the
 * reference for all of them is pgrust's own `wasm/run-node-wire-threads.mjs --dispatch postmaster`.
 *
 * What this file deliberately does NOT do is speak pgwire. `openSession` announces a connection
 * record, and what comes back is the session's two rings: the startup packet and everything after
 * it belong to {@link PgrustPGlite}, which is the whole point of the exercise.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { RepackedChannel, RepackedChannelTransfer, RepackedDoorbell } from "../vendor/pgrust/broker-fs.js";
import { loadRepackedBundle, repackedBundleUrl } from "../vendor/pgrust/broker-fs.js";
import type { VfsManifest } from "../vendor/pgrust/pgrust-wasi.js";
import { SabPipe } from "../vendor/pgrust/sab-pipe.js";
import {
  createSharedMemory,
  HOSTPIPES_LISTEN_FD,
  HOSTPIPES_WAKE_FD,
  makeWorker,
  newMessageChannel,
  onPortMessage,
  onWorkerError,
  onWorkerMessage,
  PipeRegistry,
  sessionFds,
  sessionWakeFd,
  storageWorkerUrl,
  threadWorkerUrl,
} from "../vendor/pgrust/threads-host.js";
import { defaultWireArgv } from "../vendor/pgrust/wiresession.js";
import type { PgrustSessionPipes } from "./pgrust-pglite";

/** The vendored host, committed and always present; its `.mjs` worker entries live here too. */
const HOST_BASE = new URL("../vendor/pgrust/", import.meta.url);
/** The gitignored build outputs `bun run sync:pgrust` writes. */
const ASSET_DIR = fileURLToPath(new URL("../../public/pgrust/", import.meta.url));
/** The pre-release store bundle, which sits under the served host layout rather than beside the source. */
const BUNDLE_BASE = pathToFileURL(`${ASSET_DIR}host/`).href;

const SYNC_HINT = "Run `bun run sync:pgrust` to lay the pgrust assets down.";

/** The postmaster's own thread claim, before this scenario's sessions. pgrust's postmaster-lane default. */
const POOL_BASE_SIZE = 12;
/** `max_parallel_workers`, and therefore the size of the postmaster's warm standby pool. */
const MAX_PARALLEL_WORKERS = 2;

const STDIN_CAPACITY = 1 << 16;
const STDOUT_CAPACITY = 1 << 16;
const LISTENER_CAPACITY = 1 << 12;
const WAKE_CAPACITY = 1 << 16;
const SESSION_TO_GUEST_CAPACITY = 1 << 20;
const SESSION_FROM_GUEST_CAPACITY = 1 << 22;
/** One session's wake ring: sized far past anything that can queue, because a full one would block a SetLatch. */
const SESSION_WAKE_CAPACITY = 1 << 16;

/** `HPGP` in stream order: the connection record's magic. */
const CONNECTION_MAGIC = 0x50475048;
const CONNECTION_RECORD_BYTES = 16;

const STORAGE_READY_TIMEOUT_MS = 180_000;
const POOL_READY_TIMEOUT_MS = 120_000;
const POSTMASTER_READY_TIMEOUT_MS = 180_000;
const EXIT_TIMEOUT_MS = 60_000;
const STORAGE_STOP_TIMEOUT_MS = 10_000;

const READY_LOG_PATTERN = /database system is ready to accept connections/i;
const SHUTDOWN_CHECKPOINT_PATTERN = /checkpoint starting: shutdown/i;

const MAX_SERVER_LOG_CHARS = 8_000;

export interface PgrustEngineOptions {
  /** How many sessions may be opened. Every ring is created before the guest starts, so this is a ceiling. */
  readonly sessions?: number;
  /** Where the server's stderr goes. Silent by default; the log tail rides on any thrown error regardless. */
  readonly onServerLog?: (text: string) => void;
}

export interface PgrustEngineShutdown {
  readonly exitCode: number;
  readonly shutdownMs: number;
  /** Whether the server log shows the shutdown checkpoint — a stopped Postgres rather than a killed one. */
  readonly checkpointed: boolean;
}

export interface PgrustEngine {
  /** Announce one session to the postmaster and hand back its rings, unhandshaken. */
  openSession(): PgrustSessionPipes;
  /** Close the listener — the fast-shutdown request — and wait for the guest's own `exit(0)`. */
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
  // Every gate is awaited, but one that fails after its await has returned would be unobserved.
  promise.catch(() => {});
  return { promise, open, fail };
}

/** Messages the process worker and every pool slot send back; only these fields are read here. */
interface HostEvent {
  readonly type?: string;
  readonly from?: string;
  readonly code?: number;
  readonly message?: string;
  readonly bytes?: Uint8Array;
  readonly poolSize?: number;
}

interface StorageEvent {
  readonly type?: string;
  readonly message?: string;
  readonly errorName?: string;
}

function asRecord<T>(message: unknown): T {
  return (typeof message === "object" && message !== null ? message : {}) as T;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The connection record `pqcomm_hostpipes` accepts: magic, in fd, out fd, wake fd; little-endian.
 *
 * The fourth word was `reserved` until pgrust `d2da198f48`; it now carries this session's wake fd,
 * and 0 still means "none" — a backend whose record says 0 falls back to ending its block at the end
 * of the guest's 100 ms interrupt poll, which is what every host wrote before the field existed.
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
 * The postmaster's argv: the wire lanes' GUCs with `PostmasterMain`'s shape.
 *
 * `--host-pipes` picks the transport and falls through to the ordinary postmaster, so there is no
 * trailing database name, the two GUCs that make the host fd the only way in are set, and the warm
 * standby pool is bounded because a fixed host thread pool is what backs it.
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
    "-c",
    "log_checkpoints=on",
    "-c",
    `max_parallel_workers=${MAX_PARALLEL_WORKERS}`,
  );
  return argv;
}

function readAsset(name: string): Buffer {
  try {
    return readFileSync(`${ASSET_DIR}${name}`);
  } catch (error: unknown) {
    throw new Error(`pgrust asset ${ASSET_DIR}${name} could not be read (${describe(error)}). ${SYNC_HINT}`);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string, log: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const tail = log().trim();
      reject(new Error(`pgrust postmaster: ${what} after ${ms} ms${tail === "" ? "" : `\nserver log:\n${tail}`}`));
    }, ms);
  });
  deadline.catch(() => {});
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start the whole thing: the storage coordinator, then the process worker with its prewarmed pool,
 * then wait for the postmaster to say it will accept connections.
 */
export async function startPgrustPostmaster(options: PgrustEngineOptions = {}): Promise<PgrustEngine> {
  const sessionCount = options.sessions ?? 1;
  const poolSize = POOL_BASE_SIZE + sessionCount;

  const wasmModule = await WebAssembly.compile(readAsset("postgres-threads.wasm"));
  const imageBytes = readAsset("vfs.img");
  const image = imageBytes.buffer.slice(
    imageBytes.byteOffset,
    imageBytes.byteOffset + imageBytes.byteLength,
  ) as ArrayBuffer;
  const manifest = JSON.parse(readAsset("vfs.json").toString("utf8")) as VfsManifest;

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let serverLog = "";
  const logTail = (): string => serverLog;

  const exited = gate();
  const poolReady = gate();
  const postmasterReady = gate();
  const storageStopped = gate();
  let exitCode: number | null = null;

  // ---- the storage coordinator, first and always -------------------------------------------
  // Its store must be seeded before the startup process can read a file, and once its blocking
  // serve loop is entered it never reaches its event loop again.
  const bundleUrl = repackedBundleUrl(BUNDLE_BASE);
  let bundle;
  try {
    bundle = await loadRepackedBundle(bundleUrl);
  } catch (error: unknown) {
    throw new Error(
      `the pre-release @pgxsinkit/pglite-opfs-repacked bundle at ${bundleUrl} could not be loaded ` +
        `(${describe(error)}). ${SYNC_HINT}`,
    );
  }
  const doorbell: RepackedDoorbell = bundle.RepackedDoorbell.create();
  // One channel per pool slot PLUS one for the process instance: one request in flight per channel,
  // so two agents may never share one.
  const channels: RepackedChannel[] = Array.from({ length: poolSize + 1 }, (_unused, index) =>
    bundle.RepackedChannel.create({ id: index + 1, doorbell }),
  );

  const storageWorker = makeWorker(storageWorkerUrl(HOST_BASE), { name: "pgrust-storage" });
  const storageReady = gate();
  onWorkerMessage(storageWorker, (raw: unknown) => {
    const event = asRecord<StorageEvent>(raw);
    switch (event.type) {
      case "storage-ready":
        storageReady.open();
        return;
      case "storage-stopped":
        storageStopped.open();
        return;
      case "storage-error": {
        const error = new Error(`pgrust storage ${event.errorName ?? "Error"}: ${event.message ?? ""}`);
        storageReady.fail(error);
        storageStopped.open();
        return;
      }
      default:
        return;
    }
  });
  onWorkerError(storageWorker, (error: Error) => {
    storageReady.fail(new Error(`pgrust storage worker threw: ${error.message}`));
    storageStopped.open();
  });

  const transfers: RepackedChannelTransfer[] = channels.map((channel) => channel.transfer());
  storageWorker.postMessage(
    { kind: "boot", bundleUrl, image, manifest, channels: transfers, doorbell: doorbell.buffer, options: {} },
    [image],
  );
  try {
    await withTimeout(
      storageReady.promise,
      STORAGE_READY_TIMEOUT_MS,
      "the storage coordinator did not seed its store",
      logTail,
    );
  } catch (error: unknown) {
    storageWorker.terminate();
    throw error;
  }

  // The packed image now lives in the coordinator's store (and its ArrayBuffer was transferred
  // there); every instance gets an empty base VFS the broker adapter sits on top of.
  const guestImage = new ArrayBuffer(0);
  const guestManifest: VfsManifest = { dirs: ["/"], files: [] };

  // ---- every host-owned pipe, created before the guest starts -------------------------------
  const stdin = SabPipe.create(STDIN_CAPACITY);
  const stdout = SabPipe.create(STDOUT_CAPACITY);
  const registry = new PipeRegistry();
  const listener = SabPipe.create(LISTENER_CAPACITY);
  registry.register(HOSTPIPES_LISTEN_FD, { in: listener });
  // Both ends of one ring on one fd: this host writes a token after every announcement and after
  // the listener close, and any guest thread whose SetLatch finds the postmaster parked writes one.
  const wake = SabPipe.create(WAKE_CAPACITY);
  registry.register(HOSTPIPES_WAKE_FD, { in: wake, out: wake });

  const slots = Array.from({ length: sessionCount }, (_unused, index) => {
    const { inFd, outFd } = sessionFds(index);
    // One gate per session: the three rings a backend can be waiting on share a futex word, so its
    // `poll` over its in fd and its wake fd is one `Atomics.wait` rather than a slice between them.
    // Per session, never global — an idle backend wakes on its own traffic and on nothing else.
    const gate = SabPipe.createGate();
    const toGuest = SabPipe.create(SESSION_TO_GUEST_CAPACITY, { gate });
    const fromGuest = SabPipe.create(SESSION_FROM_GUEST_CAPACITY, { gate });
    registry.register(inFd, { in: toGuest });
    registry.register(outFd, { out: fromGuest });
    // Both ends of one ring on one fd, exactly as the postmaster's: written by any guest thread
    // whose `SetLatch` finds this backend fd-parked, drained by the backend on every wake.
    const wakeFd = sessionWakeFd(index);
    const wake = SabPipe.create(SESSION_WAKE_CAPACITY, { gate });
    registry.register(wakeFd, { in: wake, out: wake });
    return { inFd, outFd, wakeFd, toGuest, fromGuest };
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
        const text = decoder.decode(event.bytes, { stream: true });
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
        const error = new Error(
          `pgrust postmaster: wasi thread-spawn refused, the prewarmed pool of ${event.poolSize ?? poolSize} ` +
            "is exhausted",
        );
        poolReady.fail(error);
        postmasterReady.fail(error);
        return;
      }
      case "exit":
        exitCode = event.code ?? -1;
        postmasterReady.fail(new Error(`pgrust postmaster: the server exited with code ${exitCode}`));
        exited.open();
        return;
      case "error": {
        const error = new Error(`pgrust postmaster ${event.from ?? "worker"}: ${event.message ?? "unknown error"}`);
        poolReady.fail(error);
        postmasterReady.fail(error);
        exited.open();
        return;
      }
      default:
        return;
    }
  }

  const processWorker = makeWorker(threadWorkerUrl(HOST_BASE), { name: "pgrust-process" });
  onWorkerMessage(processWorker, handleEvent);
  onWorkerError(processWorker, (error: Error) => {
    handleEvent({ type: "error", from: "process", message: error.message });
  });

  // A spawned thread reports here directly: from the moment the postmaster's own thread joins, the
  // process worker is parked in a futex and relays nothing.
  const relayChannels = Array.from({ length: poolSize }, () => newMessageChannel());
  for (const channel of relayChannels) {
    onPortMessage(channel.port1, handleEvent);
  }

  processWorker.postMessage(
    {
      role: "process",
      module: wasmModule,
      memory: createSharedMemory(),
      image: guestImage,
      manifest: guestManifest,
      fs: "broker",
      bundleUrl,
      channel: transfers[0] ?? null,
      poolChannels: transfers.slice(1),
      stdin: stdin.descriptor(),
      stdout: stdout.descriptor(),
      pipes: registry.descriptors(),
      argv: postmasterArgv(),
      env: {
        USER: "postgres",
        PGRUST_TZDIR: "/share/timezone",
        PGRUST_PGSHAREDIR: "/share",
        // The guest's own async runtime is off: this build runs every backend on a real wasi thread.
        PGRUST_RUNTIME: "0",
        RUST_BACKTRACE: "1",
        // Required: `pqcomm_hostpipes` reads the listener fd here and `PostmasterMain` FATALs
        // without it. The wake fd is optional, and worth tens of milliseconds per session open.
        PGRUST_HOSTPIPES_LISTEN_FD: String(HOSTPIPES_LISTEN_FD),
        PGRUST_HOSTPIPES_WAKE_FD: String(HOSTPIPES_WAKE_FD),
      },
      poolSize,
      trace: 0,
      relayPorts: relayChannels.map((channel) => channel.port2),
    },
    [guestImage, ...relayChannels.map((channel) => channel.port2)],
  );

  let nextSession = 0;
  let stopped = false;

  const engine: PgrustEngine = {
    openSession(): PgrustSessionPipes {
      const slot = slots[nextSession];
      nextSession += 1;
      if (slot === undefined) {
        throw new Error(`pgrust postmaster: only ${slots.length} session ring(s) were created`);
      }
      const written = listener.write(connectionRecord(slot.inFd, slot.outFd, slot.wakeFd), { block: false });
      if (written !== CONNECTION_RECORD_BYTES) {
        throw new Error(`pgrust postmaster: the listener ring would not take a whole record (${written}/16)`);
      }
      // The wake token turns the postmaster's next accept probe into an immediate one.
      wake.write(new Uint8Array([0]), { block: false });
      return { toGuest: slot.toGuest, fromGuest: slot.fromGuest };
    },

    async shutdown(): Promise<PgrustEngineShutdown> {
      if (stopped) {
        return { exitCode: exitCode ?? -1, shutdownMs: 0, checkpointed: false };
      }
      stopped = true;
      const startedAt = performance.now();
      // The listener reaching EOF IS the fast-shutdown request: `pqcomm_hostpipes` turns it into
      // the very handler a SIGINT runs, and what follows is Postgres's own ceremony.
      listener.close();
      wake.write(new Uint8Array([0]), { block: false });
      await Promise.race([exited.promise, new Promise((resolve) => setTimeout(resolve, EXIT_TIMEOUT_MS))]);
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
      storageWorker.terminate();
      return { exitCode: exitCode ?? -1, shutdownMs, checkpointed };
    },
  };

  try {
    await withTimeout(poolReady.promise, POOL_READY_TIMEOUT_MS, "the thread pool did not prewarm", logTail);
    await withTimeout(
      postmasterReady.promise,
      POSTMASTER_READY_TIMEOUT_MS,
      'the postmaster never reached "ready to accept connections"',
      logTail,
    );
  } catch (error: unknown) {
    await engine.shutdown();
    throw error;
  }

  return engine;
}
