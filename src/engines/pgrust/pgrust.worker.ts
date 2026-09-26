/**
 * The pgrust Engine worker.
 *
 * One worker hosts exactly one long-lived `postgres --stdio-wire` wasm instance for the lifetime of
 * one Run, spoken to in pgwire frames over the guest's stdin/stdout pipes (the vendored
 * `wiresession.js`). The guest blocks on its stdin read between statements, so the session only
 * works where JS Promise Integration exists — hence the `jspiSupported()` gate in `open`.
 *
 * The Measurement is taken here around `query()` **plus** the decode into JS rows: CONTEXT.md ends
 * the window when decoded rows or a command tag are available in JS, which is also where PGlite's
 * `exec` ends. Timing only the protocol round trip would flatter pgrust against PGlite.
 *
 * Deliberately no wasm module cache (the pgrust demo keeps one in IndexedDB): a benchmark must not
 * carry hidden state between Runs, and a compile that sometimes happens and sometimes does not is
 * exactly that. Every Run pays the same, visible boot cost outside the measured window.
 *
 * With `?brokerStats=1` the session is handed the vendored host's store counters, and every
 * `measure` and `concurrent` answer carries the guest's file calls on its in-memory `Vfs`: the one
 * thread there is, which is also the Session's backend.
 */

import { IoStats } from "../../vendor/pgrust/io-stats.js";
import { Vfs } from "../../vendor/pgrust/pgrust-wasi.js";
import type { VfsManifest } from "../../vendor/pgrust/pgrust-wasi.js";
import { defaultWireArgv, jspiSupported, WireSession, WireSessionDead } from "../../vendor/pgrust/wiresession.js";
import { JSPI_REQUIREMENT_MESSAGE } from "../availability";
import { toErrorPayload } from "../protocol";
import type { EngineOkResponse, EngineReadyMessage, EngineRequest, EngineResponse } from "../protocol";
import { runScenario } from "../scenario-runner";
import { aroundStoreStats, StoreStatsProbe } from "../store-stats-probe";
import type { QueryResult } from "./pgwire";
import { assertNoQueryError, decodeQueryResult } from "./pgwire";
import { wireScenarioExecutor } from "./wire-executor";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/**
 * Static files under `public/pgrust/`, addressed through the app's base so the page can be hosted
 * under a sub-path. Populated by `bun run sync:pgrust`; absent until then.
 */
const ASSET_BASE = `${import.meta.env.BASE_URL.replace(/\/+$/, "")}/pgrust`;
const SYNC_HINT = "Run `bun run sync:pgrust` after building the pgrust wasm assets.";

/** Keep only the tail of the guest's stderr: enough to explain a failure, bounded for a long Run. */
const MAX_STDERR_CHARS = 4_000;

let session: WireSession | null = null;

/** The guest's file-call counters, on a Run with `?brokerStats=1`; null otherwise. */
let storeStats: StoreStatsProbe | null = null;

/** One decoder for the whole session: a multi-byte character can straddle two stderr chunks. */
const stderrDecoder = new TextDecoder("utf-8", { fatal: false });
let stderrText = "";

function post(message: EngineResponse): void {
  ctx.postMessage(message);
}

function ok(id: number, measurement: EngineOkResponse["measurement"]): void {
  post({ kind: "ok", id, measurement });
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A dead guest is only explicable from its stderr, so carry the tail into the thrown Error. */
function toEngineError(error: unknown): Error {
  if (!(error instanceof WireSessionDead)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const stderr = takeStderr();
  const detail = stderr === "" ? "" : `\nguest stderr:\n${stderr}`;
  return new Error(`pgrust ${error.message}${detail}`);
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
  return WebAssembly.compile(await buffered.arrayBuffer());
}

async function openEngine(dataDir: string, relaxedDurability: boolean, countStore: boolean): Promise<void> {
  if (!jspiSupported()) {
    throw new Error(JSPI_REQUIREMENT_MESSAGE);
  }
  if (dataDir !== "") {
    throw new Error(`pgrust Engine supports only the Memory Configuration; got dataDir "${dataDir}"`);
  }
  if (relaxedDurability) {
    throw new Error("pgrust Engine has no relaxed-durability setting");
  }

  const [wasmModule, image, manifest] = await Promise.all([
    compileEngineModule(`${ASSET_BASE}/postgres.wasm`),
    fetchAsset(`${ASSET_BASE}/vfs.img`).then(async (response) => new Uint8Array(await response.arrayBuffer())),
    fetchAsset(`${ASSET_BASE}/vfs.json`).then(async (response) => (await response.json()) as VfsManifest),
  ]);

  // The VFS takes ownership of the image, and the worker is discarded after one Run, so the freshly
  // fetched bytes can be handed over directly — there is no pristine template to preserve here.
  const vfs = new Vfs(image, manifest);
  // One agent, in this worker: a plain buffer where the page has no SharedArrayBuffer to give.
  const stats = countStore
    ? IoStats.create({ agents: 1, shared: typeof SharedArrayBuffer === "function" && ctx.crossOriginIsolated })
    : null;
  storeStats = stats === null ? null : new StoreStatsProbe(stats, { guest: true, broker: false, handles: false });
  const started = new WireSession({
    wasmModule,
    vfs,
    argv: defaultWireArgv(),
    onStderr: collectStderr,
    ...(stats === null ? {} : { ioStats: stats.buffer }),
  });
  try {
    await started.start();
  } catch (error: unknown) {
    throw toEngineError(error);
  }
  session = started;
}

function requireSession(): WireSession {
  if (session === null) {
    throw new Error("pgrust Engine is not open");
  }
  return session;
}

/**
 * One simple-query cycle, timed. The clock covers the protocol round trip and the decode into JS
 * rows; the backend-error check is deliberately outside it, because an errored Benchmark fails the
 * Run rather than recording a time.
 */
async function measureQuery(sql: string): Promise<{ result: QueryResult; elapsedMs: number }> {
  const engine = requireSession();
  stderrText = "";
  try {
    const startTime = performance.now();
    const result = decodeQueryResult(await engine.query(sql));
    const elapsedMs = performance.now() - startTime;
    return { result, elapsedMs };
  } catch (error: unknown) {
    throw toEngineError(error);
  }
}

/**
 * One cycle for a Scenario Client, with the same clock the Suite's other rows use left out.
 *
 * The Concurrency Suite times a Client's unit itself (`runScenario`), around this call and around a
 * whole transaction, so what this needs to supply is the decoded result and nothing else.
 */
async function scenarioQuery(sql: string): Promise<QueryResult> {
  return (await measureQuery(sql)).result;
}

async function handle(request: EngineRequest): Promise<void> {
  switch (request.kind) {
    case "open": {
      await openEngine(
        request.dataDir,
        request.options?.relaxedDurability === true,
        request.options?.storeStats === true,
      );
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
      const {
        value: { result, elapsedMs },
        storeStats: counted,
      } = await aroundStoreStats(storeStats, async () => await measureQuery(request.sql));
      assertNoQueryError(result);
      post({
        kind: "ok",
        id: request.id,
        measurement: { elapsedMs },
        ...(counted === undefined ? {} : { storeStats: counted }),
      });
      return;
    }
    case "concurrent": {
      requireSession();
      const { value: report, storeStats: counted } = await aroundStoreStats(storeStats, async () =>
        runScenario(request.scenario, wireScenarioExecutor(scenarioQuery)),
      );
      post({
        kind: "ok",
        id: request.id,
        measurement: null,
        report,
        ...(counted === undefined ? {} : { storeStats: counted }),
      });
      return;
    }
    case "stats": {
      // Neither Engine holds a `WebAssembly.Memory` this worker created, so there is nothing here it
      // could measure. The case exists so a `stats` request answers rather than hangs; the memory
      // probe does not run these columns.
      post({ kind: "ok", id: request.id, measurement: null, stats: { wasmMemories: [] } });
      return;
    }
    case "close": {
      const engine = session;
      session = null;
      storeStats = null;
      await engine?.terminate();
      ok(request.id, null);
      return;
    }
    default: {
      // An unknown request kind must be an ANSWER, not a hang: the runner is waiting on this id and
      // nothing else will ever settle it. `scalar` is the only kind this Engine does not implement.
      const unknown = request as { readonly kind: string; readonly id: number };
      post(toErrorPayload(unknown.id, new Error(`this Engine does not answer a ${unknown.kind} request`)));
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
