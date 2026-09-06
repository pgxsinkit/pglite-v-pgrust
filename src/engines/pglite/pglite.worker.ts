/**
 * The PGlite Engine worker.
 *
 * One worker hosts exactly one PGlite instance for the lifetime of one Run. The Measurement is taken
 * here, around `pg.exec(sql)` alone: the postMessage round trip is outside the window on purpose.
 *
 * A Configuration opens PGlite one of two ways. Without a store setting it is `new PGlite(dataDir)`,
 * where an empty `dataDir` is the Memory Configuration. With one it is the `opfs-repacked` store's
 * own factory, which owns PGlite's `dataDir`, `fs` and `relaxedDurability` and needs a dedicated,
 * otherwise-empty OPFS directory — so this worker empties that directory before every Run and
 * removes it again on close. No state carries over between Configurations, and none is left behind.
 */

import { PGlite } from "@electric-sql/pglite";
import { createOpfsRepackedPGlite } from "@pgxsinkit/pglite-opfs-repacked";

import { emptyOpfsDirectory, removeOpfsDirectory } from "../../opfs";
import type { EngineOpenOptions, PgliteStoreSettings } from "../contract";
import { pgliteOpenOptions, pgliteStore } from "../contract";
import { toErrorPayload } from "../protocol";
import type { EngineOkResponse, EngineReadyMessage, EngineRequest, EngineResponse } from "../protocol";
import { toStoreError } from "./store-error";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let pg: PGlite | null = null;

/** The OPFS directory this Run owns, or null when PGlite opened its own data directory. */
let storeDirectory: string | null = null;

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

/** PGlite on its own filesystem: in the worker's heap when `dataDir` is empty. */
async function openPglite(dataDir: string, options: EngineOpenOptions | undefined): Promise<PGlite> {
  // Only the PGlite-shaped settings are handed over: the open options also carry other Engines'
  // keys, and PGlite has no business seeing them.
  const instance = new PGlite(dataDir, pgliteOpenOptions(options));
  await instance.waitReady;
  return instance;
}

/**
 * PGlite on a store, in a directory this Run creates empty and owns in full.
 *
 * `storeDirectory` is set before the factory runs, not after: a create that fails still leaves a
 * directory behind, and `close` is what removes it.
 */
async function openStore(dataDir: string, settings: PgliteStoreSettings): Promise<PGlite> {
  const directory = await emptyOpfsDirectory(dataDir);
  storeDirectory = dataDir;
  try {
    return await createOpfsRepackedPGlite({ directory, durability: settings.durability });
  } catch (error: unknown) {
    throw toStoreError(`the ${settings.store} store failed to open "${dataDir}"`, error);
  }
}

async function handle(request: EngineRequest): Promise<void> {
  switch (request.kind) {
    case "open": {
      const settings = pgliteStore(request.options);
      pg =
        settings === undefined
          ? await openPglite(request.dataDir, request.options)
          : await openStore(request.dataDir, settings);
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
      const directory = storeDirectory;
      pg = null;
      storeDirectory = null;
      try {
        await engine?.close();
      } finally {
        // The instance holds the store's four handles until `close` resolves, so the directory can
        // only go afterwards — and it has to go, or the next page load inherits this Run's data.
        if (directory !== null) {
          await removeOpfsDirectory(directory);
        }
      }
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
