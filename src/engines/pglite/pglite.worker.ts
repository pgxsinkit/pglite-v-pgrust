/**
 * The PGlite Engine worker.
 *
 * One worker hosts exactly one PGlite instance for the lifetime of one Run. The Measurement is taken
 * here, around `pg.exec(sql)` alone: the postMessage round trip is outside the window on purpose.
 */

import { PGlite } from "@pgxsinkit/pglite";

import { toErrorPayload } from "../protocol";
import type { EngineOkResponse, EngineReadyMessage, EngineRequest, EngineResponse } from "../protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let pg: PGlite | null = null;

function post(message: EngineResponse): void {
  ctx.postMessage(message);
}

function ok(id: number, measurement: EngineOkResponse["measurement"]): void {
  post({ kind: "ok", id, measurement });
}

function requireEngine(): PGlite {
  if (pg === null) {
    throw new Error("PGlite Engine is not open");
  }
  return pg;
}

async function handle(request: EngineRequest): Promise<void> {
  switch (request.kind) {
    case "open": {
      const instance = new PGlite(request.dataDir, request.options);
      await instance.waitReady;
      pg = instance;
      ok(request.id, null);
      return;
    }
    case "exec": {
      await requireEngine().exec(request.sql);
      ok(request.id, null);
      return;
    }
    case "measure": {
      const engine = requireEngine();
      const startTime = performance.now();
      await engine.exec(request.sql);
      const elapsedMs = performance.now() - startTime;
      ok(request.id, { elapsedMs });
      return;
    }
    case "close": {
      const engine = pg;
      pg = null;
      await engine?.close();
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
