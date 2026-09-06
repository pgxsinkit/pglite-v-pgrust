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

export interface EngineCloseRequest {
  readonly kind: "close";
  readonly id: number;
}

export type EngineRequest =
  | EngineOpenRequest
  | EngineExecRequest
  | EngineMeasureRequest
  | EngineConcurrentRequest
  | EngineCloseRequest;

export interface EngineOkResponse {
  readonly kind: "ok";
  readonly id: number;
  readonly measurement: Measurement | null;
  /** Present only in answer to a `concurrent` request. */
  readonly report?: ScenarioReport;
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
