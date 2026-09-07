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
import type { EngineOkResponse, EngineReadyMessage, EngineRequest, EngineResponse, EngineStats } from "../protocol";
import type { ScenarioExecutor } from "../scenario-runner";
import { runScenario } from "../scenario-runner";
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

/** The first column of the first row, as text — the one value a `scalar` request is asking for. */
function firstValue(rows: readonly Record<string, unknown>[]): string | null {
  const first = rows[0];
  if (first === undefined) {
    return null;
  }
  const value: unknown = Object.values(first)[0];
  if (value === undefined || value === null) {
    return null;
  }
  // PGlite hands back typed JS values, so a scalar is a scalar and anything else (a json column, a
  // composite) is rendered rather than stringified into `[object Object]`.
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(value) ?? String(typeof value);
}

/** The SQLSTATE of a backend error, or `undefined` for anything that is not one. */
function sqlstateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/** Rethrow anything that is not a backend error: only a SQLSTATE is a result rather than a failure. */
function toSqlstate(error: unknown): string {
  const sqlstate = sqlstateOf(error);
  if (sqlstate === undefined) {
    throw error;
  }
  return sqlstate;
}

/**
 * PGlite's Clients: one instance, one queue, and the two calls an application really has.
 *
 * There is exactly one Session here and `resolveSession` says so — every Client's work goes to the
 * same PGlite, and the per-Session setup therefore runs once. What decides whether two Clients
 * interleave is which call they make:
 *
 * - a plain Step is `pg.query(sql)`, one statement through the queue, so another Client's statement
 *   can be served between two of this Client's;
 * - a `transaction` Step is `pg.transaction(...)`, which holds the queue for the whole callback, so
 *   nothing interleaves inside one — and a reader waiting on a bulk write waits for all of it.
 *
 * That is not a limitation this harness imposes; it is what PGlite is, and it is exactly what the
 * Concurrency Suite is there to show against a server with real backends. The transaction body uses
 * `tx.exec` rather than `tx.query` because a Step's SQL may be a script (the bulk-write Benchmark's
 * is) and because `exec` is the simple-protocol call every other Suite in this harness measures;
 * inside `transaction` nothing can interleave either way.
 */
function pgliteExecutor(engine: PGlite): ScenarioExecutor {
  return {
    resolveSession: () => 0,
    setup: async (_session, sql) => {
      await engine.exec(sql);
    },
    statement: async (_session, sql) => {
      try {
        await engine.query(sql);
        return undefined;
      } catch (error: unknown) {
        return toSqlstate(error);
      }
    },
    transaction: async (_session, statements) => {
      try {
        await engine.transaction(async (tx) => {
          for (const sql of statements) {
            await tx.exec(sql);
          }
        });
        return undefined;
      } catch (error: unknown) {
        return toSqlstate(error);
      }
    },
  };
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
    return await createOpfsRepackedPGlite({
      directory,
      durability: settings.durability,
      // PGlite's own create option, handed through the factory's `pglite` bag — the factory owns
      // `dataDir`, `fs` and `relaxedDurability` and refuses those three by name, and `loadDataDir`
      // is none of them. It untars a whole datadir into the store before initdb would have run.
      ...(settings.loadDataDir === undefined
        ? {}
        : { pglite: { loadDataDir: new Blob([settings.loadDataDir], { type: "application/x-gzip" }) } }),
    });
  } catch (error: unknown) {
    throw toStoreError(`the ${settings.store} store failed to open "${dataDir}"`, error);
  }
}

/**
 * PGlite's own wasm memory, as this worker can see it.
 *
 * `mod` is `protected` on `PGlite`, and this reads it anyway: the emscripten heap is the number the
 * memory probe exists to compare against pgrust's shared memory, and PGlite exposes it nowhere else.
 * `wasmMemory` first because it is the memory object itself; `HEAPU8.buffer` is the same bytes seen
 * through the view emscripten keeps, and is the fallback for a build that does not export the other.
 */
function pgliteStats(): EngineStats {
  const mod = (pg as unknown as { mod?: { wasmMemory?: WebAssembly.Memory; HEAPU8?: Uint8Array } } | null)?.mod;
  const bytes = mod?.wasmMemory?.buffer.byteLength ?? mod?.HEAPU8?.buffer.byteLength ?? 0;
  return { wasmMemories: bytes > 0 ? [{ name: "PGlite emscripten heap", bytes }] : [] };
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
    case "scalar": {
      const engine = requireEngine();
      const startTime = performance.now();
      const result = await engine.query<Record<string, unknown>>(request.sql);
      const elapsedMs = performance.now() - startTime;
      post({ kind: "ok", id: request.id, measurement: { elapsedMs }, value: firstValue(result.rows) });
      return;
    }
    case "concurrent": {
      const report = await runScenario(request.scenario, pgliteExecutor(requireEngine()));
      post({ kind: "ok", id: request.id, measurement: null, report });
      return;
    }
    case "stats": {
      post({ kind: "ok", id: request.id, measurement: null, stats: pgliteStats() });
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
