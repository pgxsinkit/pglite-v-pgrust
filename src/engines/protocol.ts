/**
 * The typed main<->worker protocol shared by every Engine worker.
 *
 * Deliberately hand-rolled rather than comlink: the protocol is four message kinds, and keeping it
 * explicit makes it obvious that the Measurement is taken inside the worker and that nothing but
 * the Engine call is inside the timed window.
 */

import type { EngineOpenOptions, Measurement } from "./contract";

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

/** Untimed execution, used for the preamble / initial setup. */
export interface EngineExecRequest {
  readonly kind: "exec";
  readonly id: number;
  readonly sql: string;
}

/** Timed execution: the worker brackets the Engine call with `performance.now()`. */
export interface EngineMeasureRequest {
  readonly kind: "measure";
  readonly id: number;
  readonly sql: string;
}

export interface EngineCloseRequest {
  readonly kind: "close";
  readonly id: number;
}

export type EngineRequest = EngineOpenRequest | EngineExecRequest | EngineMeasureRequest | EngineCloseRequest;

export interface EngineOkResponse {
  readonly kind: "ok";
  readonly id: number;
  readonly measurement: Measurement | null;
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
