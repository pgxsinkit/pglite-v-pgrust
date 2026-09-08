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
 * **Where the boot itself lives.** Not here. `src/client/pgrust-browser-engine.ts` is the ONE
 * browser boot of this postmaster — the fd contract, the broker store, the prewarmed pool, the
 * shutdown ceremony — and this worker is one of its two drivers; the other is the pgxsinkit store
 * factory (`src/client/pgrust-browser-factory.ts`), which opens the same server and puts a PGlite
 * client on top of the session instead of a Measurement. A second copy of that boot is exactly what
 * would let the Engine column and the store seam drift apart, so there is not one.
 *
 * **What this worker adds on top of it.** The pgwire half: {@link PipeSession} drives one session's
 * rings, times the `Q` frame through ReadyForQuery, and decodes the result into rows — the same
 * Measurement window the two other pgrust Engines report. Plus the Engine protocol, the prepared
 * store seed, the shared-memory stat, and the cold-store discipline: the store's OPFS directory is
 * removed in `close`, which is what keeps this column a cold-store Measurement rather than a slowly
 * growing data directory.
 *
 * **This thread never blocks.** Every wait on shared memory goes through `SabPipe.readAsync`
 * (`Atomics.waitAsync`); the blocking half of that API belongs to the guest's own workers. Each
 * session has its own pump, so a backend blocked on another backend's row lock parks that backend
 * and nothing else — which is the whole property the Concurrency Suite is here to measure.
 *
 * Like every other Engine worker: no wasm module cache, no reuse of anything across Runs, and every
 * worker it creates is terminated in `close`.
 */

import type { PgrustBrowserEngine, PgrustBrowserSession } from "../../client/pgrust-browser-engine";
import { startPgrustBrowserPostmaster } from "../../client/pgrust-browser-engine";
import { removeOpfsDirectory } from "../../opfs";
import type { SabPipe } from "../../vendor/pgrust/sab-pipe.js";
import type { WireMessage } from "../../vendor/pgrust/wire.js";
import { encodeQuery, encodeStartup, TERMINATE, WireReader } from "../../vendor/pgrust/wire.js";
import { SHARED_MEMORY_REQUIREMENT_MESSAGE } from "../availability";
import type { EngineOpenOptions, PgrustThreadsPort, StoreDurability } from "../contract";
import { pgrustPostmasterOptions, requestedSessions } from "../contract";
import type { QueryResult } from "../pgrust/pgwire";
import { assertNoQueryError, decodeQueryResult } from "../pgrust/pgwire";
import { toErrorPayload } from "../protocol";
import type {
  EngineOkResponse,
  EngineReadyMessage,
  EngineRequest,
  EngineResponse,
  EngineStats,
  StoreSeedStat,
} from "../protocol";
import type { ScenarioExecutor } from "../scenario-runner";
import { runScenario } from "../scenario-runner";
import type { StoreSeedRequest, StoreSeedResponse } from "./store-seed.worker";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Static files under `public/pgrust/`, addressed through the app's base, as the other workers do. */
const ASSET_BASE = new URL(`${import.meta.env.BASE_URL.replace(/\/+$/, "")}/pgrust/`, ctx.location.href).href;

/**
 * How many sessions one Run may open.
 *
 * Every pipe is created before the guest starts, so this is a real ceiling rather than a policy:
 * the number of rings, and the pool that must have a slot for each of their backends, are fixed at
 * boot. Four is what the Concurrency Suite asks for.
 */
const MAX_SESSIONS = 8;
/** How long one session may take from its connection record to its ReadyForQuery. */
const HANDSHAKE_TIMEOUT_MS = 60_000;
const DIRECTORY_REMOVAL_ATTEMPTS = 5;
const DIRECTORY_REMOVAL_RETRY_MS = 250;

/** Everything one Run of this Engine owns above the engine itself. */
interface PostmasterRun {
  readonly engine: PgrustBrowserEngine;
  readonly sessions: PipeSession[];
}

let run: PostmasterRun | null = null;

/**
 * The OPFS directory this Run's store owns, or null on the memory port.
 *
 * Set before the engine is started rather than after: a boot that fails half way through has already
 * created the directory, and `close` — which is called on that path too — is what takes it away again.
 */
let storeDirectory: string | null = null;

/** A dead server is only explicable from its log, so carry the tail into the thrown Error. */
function withServerLog(message: string): Error {
  const log = (run?.engine.serverLog() ?? "").trim();
  return new Error(log === "" ? message : `${message}\nserver log:\n${log}`);
}

function post(message: EngineResponse): void {
  ctx.postMessage(message);
}

function ok(id: number, measurement: EngineOkResponse["measurement"]): void {
  post({ kind: "ok", id, measurement });
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
  readonly #toGuest: SabPipe;
  readonly #fromGuest: SabPipe;
  /** Tell the postmaster this session exists — the engine's own announcement, held until asked for. */
  readonly announce: () => void;
  readonly #reader = new WireReader();
  #collector: Collector | null = null;
  #closed = false;
  /** Resolves the first time the backend writes anything: the accept-to-first-byte latency. */
  #onFirstByte: (() => void) | null = null;
  readonly pump: Promise<void>;

  /**
   * The pump starts here, on rings the engine has reserved but NOT yet announced: a reader installed
   * after the announcement could miss the accept-to-first-byte moment it exists to measure.
   */
  constructor(session: PgrustBrowserSession) {
    this.index = session.index;
    this.#toGuest = session.toGuest;
    this.#fromGuest = session.fromGuest;
    this.announce = session.announce;
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
/** How long the whole seed may take: gunzip + untar + verify + four OPFS writes on a big store. */
const STORE_SEED_TIMEOUT_MS = 300_000;

/**
 * What the prepared-store seed cost this Run, kept module-level so `stats` can report it.
 *
 * Null on every Run that was not seeded, which is every Run of every Configuration on the page: the
 * seed is a probe's tool, not a column's.
 */
let storeSeed: StoreSeedStat | null = null;

/**
 * Write a prepared store into this Run's OPFS directory, before anything opens it.
 *
 * In its own dedicated worker, and terminated the moment it answers. Two reasons, and both are about
 * where the work is allowed to happen: `createSyncAccessHandle()` is granted in a dedicated worker
 * and refused on the window's main thread, and the storage coordinator — the other worker that could
 * do it — is pgrust's, vendored byte-verbatim, so teaching it to read a tar would mean editing a file
 * that must stay identical to its source. The tarball is TRANSFERRED rather than copied: it is the
 * whole store.
 */
async function seedPreparedStore(directory: string, tarball: ArrayBuffer): Promise<StoreSeedStat> {
  const worker = new Worker(new URL("./store-seed.worker.ts", import.meta.url), { type: "module" });
  try {
    const answered = new Promise<StoreSeedResponse>((resolve, reject) => {
      worker.addEventListener("message", (event: MessageEvent<StoreSeedResponse>) => {
        resolve(event.data);
      });
      worker.addEventListener("error", (event: ErrorEvent) => {
        reject(new Error(`the prepared-store seed worker threw: ${event.message}`));
      });
    });
    const request: StoreSeedRequest = { kind: "seed", opfsDir: directory, tar: tarball };
    worker.postMessage(request, [tarball]);
    const answer = await withTimeout(answered, STORE_SEED_TIMEOUT_MS, "the prepared store was never written");
    if (answer.type === "seed-error") {
      throw new Error(`the prepared store could not be written: ${answer.message}`);
    }
    console.info(
      `pgrust postmaster storage: prepared store seeded — ${answer.tarBytes} tarball bytes -> ` +
        `${answer.bytesWritten} bytes in 4 files (gunzip ${answer.timings.gunzipMs.toFixed(0)} ms, untar ` +
        `${answer.timings.untarMs.toFixed(0)} ms, verify ${answer.timings.verifyMs.toFixed(0)} ms, write ` +
        `${answer.timings.writeMs.toFixed(0)} ms)`,
    );
    return { ...answer.timings, tarBytes: answer.tarBytes, bytesWritten: answer.bytesWritten };
  } finally {
    // One job, then gone: it holds no handle after its last `close()`, and a live worker here would
    // be one more agent in the cluster for no reason.
    worker.terminate();
  }
}

/**
 * Announce one session to the postmaster and complete its pgwire handshake.
 *
 * Every millisecond of this is outside every Measurement: the postmaster has to wake, accept the
 * record, claim a pool slot and spawn a backend before the startup packet is even read, and that is
 * a per-session cost of the transport rather than of a query. The announcement is the engine's
 * (`PgrustBrowserSession.announce`), and it comes AFTER the first-byte hook is installed — which is
 * the whole reason the engine hands out a session that is reserved but not yet announced.
 */
async function openSession(session: PipeSession): Promise<number> {
  const announcedAt = performance.now();
  let firstByteMs = 0;
  session.onFirstByte(() => {
    firstByteMs = performance.now() - announcedAt;
  });
  session.announce();

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

  // The prepared store goes in BEFORE the coordinator opens anything, and it is what `reset` would
  // otherwise have thrown away. After it the coordinator finds a datadir already in place, reports
  // `restored: true`, and skips the packed-image seed entirely — which is the whole point. A Run
  // that was NOT seeded is the opposite case: it asked for a reset, so a restored datadir would be
  // an earlier Run's leftovers and `refuseExisting` fails the boot on it.
  const seedFromTar = settings?.seedFromTar;
  storeSeed = null;
  if (seedFromTar !== undefined && port !== "opfs") {
    throw new Error("pgrust postmaster Engine can only seed a prepared store onto the OPFS port");
  }

  // Before the engine runs, not after: the coordinator creates the directory as part of opening the
  // store, and a boot that fails half way through has already created it.
  storeDirectory = port === "opfs" ? dataDir : null;

  let engine: PgrustBrowserEngine;
  try {
    engine = await startPgrustBrowserPostmaster({
      assetBase: ASSET_BASE,
      sessions: sessionCount,
      ...(settings?.poolBase === undefined ? {} : { poolBase: settings.poolBase }),
      // The initial claim is the whole of what a freshly booted postmaster costs before it has taken
      // a single page of heap, so it is a knob rather than a constant — but only downward as far as
      // the module's own declared minimum, which the engine reports as what it is.
      ...(settings?.initialMemoryBytes === undefined ? {} : { initialMemoryBytes: settings.initialMemoryBytes }),
      storage:
        port === "opfs"
          ? {
              port: "opfs",
              opfsDir: dataDir,
              durability,
              reset: seedFromTar === undefined,
              refuseExisting: seedFromTar === undefined,
            }
          : { port: "memory", durability },
      ...(settings?.settings === undefined ? {} : { settings: settings.settings }),
      ...(settings?.env === undefined ? {} : { env: settings.env }),
      onStorageReady: (line: string) => {
        console.info(line);
      },
      // A server that dies mid-cycle would otherwise leave every session waiting for a ReadyForQuery
      // that can no longer come.
      onFatal: failEverySession,
      ...(seedFromTar === undefined
        ? {}
        : {
            beforeStorage: async () => {
              storeSeed = await seedPreparedStore(dataDir, seedFromTar);
            },
          }),
    });
  } catch (error: unknown) {
    // The engine shut itself down; this is what takes the directory away.
    await closeEngine();
    throw error instanceof Error ? error : new Error(String(error));
  }

  const sessions: PipeSession[] = [];
  run = { engine, sessions };

  try {
    for (let index = 0; index < sessionCount; index += 1) {
      sessions.push(new PipeSession(engine.reserveSession()));
    }
    const acceptLatencies: number[] = [];
    for (const session of sessions) {
      acceptLatencies.push(await openSession(session));
    }
    console.info(
      `pgrust postmaster: ${sessions.length} session(s) accepted, first backend byte after ` +
        `${acceptLatencies.map((ms) => ms.toFixed(0)).join("/")} ms`,
    );
  } catch (error: unknown) {
    // A server that never accepted leaves live workers behind; close them before rethrowing so a
    // failed column cannot leave a shared memory and a tree of workers alive for the rest of the page.
    await closeEngine();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Settle every session of the current Run, so a dead server does not hang a Suite. */
function failEverySession(error: Error): void {
  for (const session of run?.sessions ?? []) {
    session.fail(error);
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
 * The one shared `WebAssembly.Memory` every instance of this Engine imports, as a stat.
 *
 * The memory probe asks for its size while the Engine is open. `buffer.byteLength` is what the guest
 * has actually taken: the host asks for 256 MiB up front and a maximum of 4 GiB, so this number says
 * how far past the initial claim the guest has grown — not how much of it is resident, which only the
 * renderer's RSS can say.
 */
function engineStats(): EngineStats {
  const memory = run?.engine.sharedMemory;
  return {
    wasmMemories: memory === undefined ? [] : [{ name: "pgrust shared memory", bytes: memory.buffer.byteLength }],
    ...(storeSeed === null ? {} : { storeSeed }),
  };
}

/**
 * Take down everything this Run created, in the one order that works.
 *
 * The sessions are asked to end first (Terminate, which the backend answers by closing its fds), and
 * then the engine's own shutdown runs Postgres's: the listener EOF that is the fast-shutdown request,
 * the guest's own `exit(0)`, and only then the workers and the coordinator's doorbell.
 *
 * Then, on the OPFS port, the store's directory: the coordinator's stop is what closed the store and
 * released its handles, so this is the first moment the directory can be removed — and removing it is
 * what keeps this column a cold-store Measurement rather than a slowly growing data directory.
 */
async function closeEngine(): Promise<void> {
  const current = run;
  const directory = storeDirectory;
  storeDirectory = null;
  try {
    if (current === null) {
      return;
    }
    try {
      for (const session of current.sessions) {
        if (!session.closed) {
          await session.terminate();
        }
      }
      await Promise.all(current.sessions.map(async (session) => await session.waitClosed(2_000)));
    } catch {
      // A session that will not answer its Terminate must not stop the server being taken down.
    }
    const shutdown = await current.engine.shutdown().catch(() => undefined);
    if (shutdown !== undefined && !shutdown.checkpointed) {
      // Not a failure — the Run's numbers stand — but a shutdown without its checkpoint is worth
      // seeing, because it is the difference between a stopped Postgres and a killed one.
      console.warn("pgrust postmaster: the server log shows no shutdown checkpoint");
    }
  } finally {
    run = null;
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
    case "scalar": {
      const { result, elapsedMs } = await requireSession(request.session ?? 0).query(request.sql);
      assertNoQueryError(result);
      post({
        kind: "ok",
        id: request.id,
        measurement: { elapsedMs },
        value: result.rows[0]?.[0] ?? null,
      });
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
