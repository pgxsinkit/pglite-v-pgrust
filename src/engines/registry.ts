/**
 * Engine registry: maps an EngineId to the dedicated module worker that hosts it.
 *
 * Wiring pgrust is a one-line change here plus the worker module itself — nothing else in the app
 * needs to know a second Engine exists.
 */

import type { EngineId, EngineRunner } from "./contract";
import type { WorkerFactory } from "./worker-runner";
import { WorkerEngineRunner } from "./worker-runner";

const engineWorkerFactories: Readonly<Record<EngineId, WorkerFactory | null>> = {
  pglite: () => new Worker(new URL("./pglite/pglite.worker.ts", import.meta.url), { type: "module" }),
  // Phase 2: point this at ./pgrust/pgrust.worker.ts once `bun run sync:pgrust` populates the assets.
  pgrust: null,
};

export function isEngineWired(engine: EngineId): boolean {
  return engineWorkerFactories[engine] !== null;
}

export function createEngineRunner(engine: EngineId): EngineRunner {
  const factory = engineWorkerFactories[engine];
  if (factory === null) {
    throw new Error(`Engine "${engine}" is not wired up yet`);
  }
  return new WorkerEngineRunner(factory);
}
