/**
 * Engine registry: maps an EngineId to the dedicated module worker that hosts it.
 *
 * Adding an Engine is a one-line change here plus the worker module itself — nothing else in the
 * app needs to know how many Engines exist. Whether an Engine can actually run in this browser is a
 * separate question, answered at runtime by `./availability`.
 */

import type { EngineId, EngineRunner } from "./contract";
import type { WorkerFactory } from "./worker-runner";
import { WorkerEngineRunner } from "./worker-runner";

const engineWorkerFactories: Readonly<Record<EngineId, WorkerFactory>> = {
  pglite: () => new Worker(new URL("./pglite/pglite.worker.ts", import.meta.url), { type: "module" }),
  pgrust: () => new Worker(new URL("./pgrust/pgrust.worker.ts", import.meta.url), { type: "module" }),
};

export function createEngineRunner(engine: EngineId): EngineRunner {
  return new WorkerEngineRunner(engineWorkerFactories[engine]);
}
