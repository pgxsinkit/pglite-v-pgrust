/**
 * The typed main<->worker protocol shared by every Engine worker.
 *
 * Deliberately hand-rolled rather than comlink: the protocol is four message kinds, and keeping it
 * explicit makes it obvious that the Measurement is taken inside the worker and that nothing but
 * the Engine call is inside the timed window.
 */

import type { EngineOpenOptions, Measurement } from "./contract";
import type { ConcurrentScenario, ScenarioReport } from "./scenario";

/** Sent once by the worker as soon as its module has evaluated. */
export interface EngineReadyMessage {
  readonly kind: "ready";
}

export interface EngineOpenRequest {
  readonly kind: "open";
  readonly id: number;
  readonly dataDir: string;
  readonly options?: EngineOpenOptions;
}

/**
 * Which of an Engine's sessions a request runs on; absent means the first, which is the only one
 * every Engine has.
 *
 * Only the postmaster opens more than one (see `EngineOpenOptions.sessions`), and the two
 * single-session Suites never name one — so their requests are byte-identical to what they always
 * were, and an Engine that has one place to run SQL can ignore the field entirely.
 */
export type EngineSessionIndex = number;

/** Untimed execution, used for the preamble / initial setup. */
export interface EngineExecRequest {
  readonly kind: "exec";
  readonly id: number;
  readonly sql: string;
  readonly session?: EngineSessionIndex;
}

/** Timed execution: the worker brackets the Engine call with `performance.now()`. */
export interface EngineMeasureRequest {
  readonly kind: "measure";
  readonly id: number;
  readonly sql: string;
  readonly session?: EngineSessionIndex;
}

/**
 * Run a whole scripted Scenario — every Client at once — and report what each of them did.
 *
 * The unit of this request is the Scenario rather than the statement because the concurrency is the
 * thing being measured: a main thread that sent one statement at a time would be the serialiser. So
 * the Clients, their Steps, their Signals and every one of their per-statement clocks live inside
 * the worker, and only the report crosses back.
 */
export interface EngineConcurrentRequest {
  readonly kind: "concurrent";
  readonly id: number;
  readonly scenario: ConcurrentScenario;
}

/**
 * Ask an open Engine what memory it is holding.
 *
 * Answered outside any Measurement and never during a Run: this exists for `scripts/probe-memory.ts`,
 * which wants the one number a page cannot see for itself. A `WebAssembly.Memory` lives in the
 * worker that created it, and its `buffer.byteLength` is the only honest statement of how much
 * address space an Engine has actually taken — the page's own
 * `performance.measureUserAgentSpecificMemory()` reports the agent cluster, and a renderer's RSS
 * reports the process.
 */
/**
 * Run one statement and bring back its FIRST value as well as its wall time.
 *
 * `measure` deliberately answers with a time and nothing else — a Benchmark's number is its
 * duration, and shipping result sets back across the worker boundary would be measuring the wrong
 * thing. A probe checking that a restored datadir really holds what it should needs the value, so
 * this is a separate kind rather than a widened `measure`: the Suites' request shape does not move.
 *
 * Answered by the two Engines a probe drives (`pglite`, `pgrust-postmaster`); anything else answers
 * with an error naming the kind, which is what an unknown request should do.
 */
export interface EngineScalarRequest {
  readonly kind: "scalar";
  readonly id: number;
  readonly sql: string;
  /** Which session, for an Engine that has several. Session 0 when absent. */
  readonly session?: number;
}

export interface EngineStatsRequest {
  readonly kind: "stats";
  readonly id: number;
}

/** One wasm memory an Engine holds, named for the table it will appear in. */
export interface WasmMemoryStat {
  readonly name: string;
  readonly bytes: number;
}

/**
 * What one prepared-store seed cost: the tarball in, the four OPFS files out.
 *
 * Reported through `stats` rather than through the open response because it is the same KIND of
 * fact — what this Run's Engine cost before it ran anything — and because only the Engine that did
 * it can see the phases (`src/engines/pgrust-postmaster/store-seed.worker.ts` runs inside the
 * postmaster worker, not on the page).
 */
export interface StoreSeedStat {
  readonly gunzipMs: number;
  readonly untarMs: number;
  readonly verifyMs: number;
  readonly writeMs: number;
  readonly totalMs: number;
  readonly tarBytes: number;
  readonly bytesWritten: number;
}

/** What an Engine can say about the memory it holds; empty for an Engine that holds none it can see. */
export interface EngineStats {
  readonly wasmMemories: readonly WasmMemoryStat[];
  /** Present only on a Run that was seeded from a prepared-store tarball. */
  readonly storeSeed?: StoreSeedStat;
}

export interface EngineCloseRequest {
  readonly kind: "close";
  readonly id: number;
}

export type EngineRequest =
  | EngineOpenRequest
  | EngineExecRequest
  | EngineMeasureRequest
  | EngineScalarRequest
  | EngineConcurrentRequest
  | EngineStatsRequest
  | EngineCloseRequest;

export interface EngineOkResponse {
  readonly kind: "ok";
  readonly id: number;
  readonly measurement: Measurement | null;
  /** Present only in answer to a `concurrent` request. */
  readonly report?: ScenarioReport;
  /** Present only in answer to a `stats` request. */
  readonly stats?: EngineStats;
  /**
   * Present only in answer to a `scalar` request: the first column of the first row, as text, or
   * null for a statement that returned no rows at all.
   */
  readonly value?: string | null;
}

export interface EngineErrorResponse {
  readonly kind: "error";
  readonly id: number;
  readonly message: string;
  readonly stack: string | null;
}

export type EngineResponse = EngineReadyMessage | EngineOkResponse | EngineErrorResponse;

/** Render an unknown thrown value as the error payload the worker sends back. */
export function toErrorPayload(id: number, error: unknown): EngineErrorResponse {
  if (error instanceof Error) {
    return { kind: "error", id, message: error.message, stack: error.stack ?? null };
  }
  return { kind: "error", id, message: String(error), stack: null };
}
