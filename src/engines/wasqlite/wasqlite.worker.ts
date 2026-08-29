/**
 * The wa-sqlite Engine worker: the Reference Engine.
 *
 * wa-sqlite is not a subject of the comparison. It is here so this harness can be calibrated
 * against numbers published elsewhere (wa-sqlite's own benchmark page and PGlite's), which means it
 * has to be opened and driven the way those pages do it: the synchronous wasm build plus
 * `MemoryVFS`, exactly as PGlite's `rtt-worker.js` does.
 *
 * The one deliberate difference is what is timed. PGlite's page goes through wa-sqlite's `tag.js`
 * template helper; this worker calls `sqlite3.exec(db, sql, rowCallback)` and collects the decoded
 * rows, because that — SQL in, decoded rows out — is what the PGlite worker's `pg.exec(sql)` does,
 * and a Measurement has to bracket the same work on both sides to mean anything.
 */

import * as SQLite from "wa-sqlite";
import SQLiteModuleFactory from "wa-sqlite/dist/wa-sqlite.mjs";
import wasqliteWasmUrl from "wa-sqlite/dist/wa-sqlite.wasm?url";
import { MemoryVFS } from "wa-sqlite/src/examples/MemoryVFS.js";

import { toErrorPayload } from "../protocol";
import type { EngineOkResponse, EngineReadyMessage, EngineRequest, EngineResponse } from "../protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/**
 * Emscripten resolves `wa-sqlite.wasm` relative to its own module URL, which is wrong once the
 * loader has been bundled into a chunk. Vite gives us the emitted asset's URL, so hand it over
 * rather than relying on the bundler happening to keep the two files adjacent.
 */
const MODULE_CONFIG = { locateFile: (): string => wasqliteWasmUrl };

/** The database name for a Memory Configuration; `MemoryVFS` keys its heap by it. */
const MEMORY_DATABASE_NAME = "benchmark";

interface OpenEngine {
  readonly sqlite3: SQLiteAPI;
  readonly db: number;
}

let engine: OpenEngine | null = null;

function post(message: EngineResponse): void {
  ctx.postMessage(message);
}

function ok(id: number, measurement: EngineOkResponse["measurement"]): void {
  post({ kind: "ok", id, measurement });
}

function requireEngine(): OpenEngine {
  if (engine === null) {
    throw new Error("wa-sqlite Engine is not open");
  }
  return engine;
}

async function openEngine(dataDir: string): Promise<OpenEngine> {
  // `SQLiteModuleFactory` is typed as returning `Promise<any>` upstream; keep it opaque here and let
  // `Factory` be the only thing that ever looks inside the Emscripten module.
  const module: unknown = await SQLiteModuleFactory(MODULE_CONFIG);
  const sqlite3 = SQLite.Factory(module);
  const vfs = new MemoryVFS();
  // wa-sqlite's own declarations contradict each other: `VFS.Base.xRead` takes the buffer wrapped in
  // `{ size, value }`, while `SQLiteVFS.xRead` takes a bare `Uint8Array`. The implementation is the
  // `VFS.Base` one — it is upstream's own example VFS — so the assertion re-states a fact rather than
  // hiding one, and this is the only place it is needed.
  sqlite3.vfs_register(vfs as unknown as SQLiteVFS, true);
  const db = await sqlite3.open_v2(dataDir === "" ? MEMORY_DATABASE_NAME : dataDir);
  return { sqlite3, db };
}

/**
 * Run one SQL string to completion, decoding every row it produces.
 *
 * The rows are collected rather than discarded so the work inside the timed window matches
 * PGlite's `exec`, which always materialises its result sets in JS.
 */
async function execute(open: OpenEngine, sql: string): Promise<void> {
  const rows: (SQLiteCompatibleType | null)[][] = [];
  await open.sqlite3.exec(open.db, sql, (row) => {
    rows.push(row);
  });
}

async function handle(request: EngineRequest): Promise<void> {
  switch (request.kind) {
    case "open": {
      engine = await openEngine(request.dataDir);
      ok(request.id, null);
      return;
    }
    case "exec": {
      await execute(requireEngine(), request.sql);
      ok(request.id, null);
      return;
    }
    case "measure": {
      const open = requireEngine();
      const startTime = performance.now();
      await execute(open, request.sql);
      const elapsedMs = performance.now() - startTime;
      ok(request.id, { elapsedMs });
      return;
    }
    case "close": {
      const open = engine;
      engine = null;
      // Closing the connection is enough: a Memory Configuration's `MemoryVFS` heap is freed with
      // the worker, which the runner terminates immediately afterwards.
      if (open !== null) {
        await open.sqlite3.close(open.db);
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
