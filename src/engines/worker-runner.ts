/**
 * The main-thread half of the Engine seam: an `EngineRunner` backed by one dedicated module worker.
 *
 * Every Run gets a fresh instance, and therefore a fresh worker and a fresh Engine. Terminating the
 * worker is what clears a Memory Configuration's state — its data directory lives in the worker heap.
 */

import type { Configuration, EngineRunner, Measurement } from "./contract";
import { toOpenSettings } from "./contract";
import type { EngineOkResponse, EngineRequest, EngineResponse, EngineStats } from "./protocol";
import type { ConcurrentScenario, ScenarioReport } from "./scenario";

/** A request as the caller writes it: the runner owns the correlation id. */
type EngineRequestBody = EngineRequest extends infer T ? (T extends { id: number } ? Omit<T, "id"> : never) : never;

/** How long to wait for a worker module to evaluate and report `ready`. */
const READY_TIMEOUT_MS = 30_000;

interface PendingCall {
  readonly resolve: (response: EngineOkResponse) => void;
  readonly reject: (error: Error) => void;
}

export type WorkerFactory = () => Worker;

export class WorkerEngineRunner implements EngineRunner {
  readonly #createWorker: WorkerFactory;
  readonly #pending = new Map<number, PendingCall>();
  #worker: Worker | null = null;
  #nextRequestId = 1;
  #fatal: Error | null = null;

  constructor(createWorker: WorkerFactory) {
    this.#createWorker = createWorker;
  }

  async open(config: Configuration, preamble: string, sessions = 1): Promise<void> {
    if (this.#worker !== null) {
      throw new Error("Engine runner is already open");
    }
    const worker = this.#createWorker();
    this.#worker = worker;
    worker.addEventListener("message", this.#onMessage);
    worker.addEventListener("error", this.#onWorkerError);
    worker.addEventListener("messageerror", this.#onWorkerError);

    await this.#waitForReady(worker, config.label);
    await this.#call({ kind: "open", ...toOpenSettings(config, sessions) });
    if (preamble.trim() !== "") {
      await this.exec(preamble);
    }
  }

  async exec(sql: string): Promise<void> {
    await this.#call({ kind: "exec", sql });
  }

  async measure(sql: string): Promise<Measurement> {
    const { measurement, storeStats } = await this.#call({ kind: "measure", sql });
    if (measurement === null) {
      throw new Error("Engine worker returned no Measurement for a measure request");
    }
    return storeStats === undefined ? measurement : { ...measurement, storeStats };
  }

  async scalar(sql: string): Promise<{ readonly elapsedMs: number; readonly value: string | null }> {
    const { measurement, value } = await this.#call({ kind: "scalar", sql });
    if (measurement === null) {
      throw new Error("Engine worker returned no Measurement for a scalar request");
    }
    return { elapsedMs: measurement.elapsedMs, value: value ?? null };
  }

  /**
   * Run one Scenario and bring back what every Client did.
   *
   * One request for the whole Scenario, and deliberately so: the Clients run concurrently inside the
   * worker, where their statements are timed. Driving them from here would put a postMessage round
   * trip between every statement and make the main thread the thing that serialises them.
   */
  async concurrent(scenario: ConcurrentScenario): Promise<ScenarioReport> {
    const { report, storeStats } = await this.#call({ kind: "concurrent", scenario });
    if (report === undefined) {
      throw new Error("Engine worker returned no report for a concurrent request");
    }
    return storeStats === undefined ? report : { ...report, storeStats };
  }

  async stats(): Promise<EngineStats> {
    const { stats } = await this.#call({ kind: "stats" });
    if (stats === undefined) {
      throw new Error("Engine worker returned no stats for a stats request");
    }
    return stats;
  }

  async close(): Promise<void> {
    const worker = this.#worker;
    if (worker === null) {
      return;
    }
    try {
      await this.#call({ kind: "close" });
    } catch {
      // A worker that cannot close cleanly is still torn down below; the Run's result stands.
    } finally {
      worker.removeEventListener("message", this.#onMessage);
      worker.removeEventListener("error", this.#onWorkerError);
      worker.removeEventListener("messageerror", this.#onWorkerError);
      worker.terminate();
      this.#worker = null;
      this.#rejectAll(new Error("Engine worker terminated"));
    }
  }

  #waitForReady(worker: Worker, label: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${label}: Engine worker initialization timeout`));
      }, READY_TIMEOUT_MS);
      const onReady = (event: MessageEvent<EngineResponse>): void => {
        if (event.data.kind !== "ready") {
          return;
        }
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error(`${label}: Engine worker failed to start`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        worker.removeEventListener("message", onReady);
        worker.removeEventListener("error", onError);
      };
      worker.addEventListener("message", onReady);
      worker.addEventListener("error", onError);
    });
  }

  #call(body: EngineRequestBody): Promise<EngineOkResponse> {
    const worker = this.#worker;
    if (worker === null) {
      return Promise.reject(new Error("Engine runner is not open"));
    }
    if (this.#fatal !== null) {
      return Promise.reject(this.#fatal);
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise<EngineOkResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      // Safe by construction: `body` is one arm of EngineRequest minus its id, and `id` restores it.
      worker.postMessage({ ...body, id } as EngineRequest);
    });
  }

  readonly #onMessage = (event: MessageEvent<EngineResponse>): void => {
    const message = event.data;
    if (message.kind === "ready") {
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(message.id);
    if (message.kind === "ok") {
      pending.resolve(message);
      return;
    }
    const error = new Error(message.message);
    if (message.stack !== null) {
      error.stack = message.stack;
    }
    pending.reject(error);
  };

  readonly #onWorkerError = (event: Event): void => {
    const message = event instanceof ErrorEvent && event.message !== "" ? event.message : "Engine worker error";
    this.#fatal = new Error(message);
    this.#rejectAll(this.#fatal);
  };

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
