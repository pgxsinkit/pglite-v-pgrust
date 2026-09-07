/**
 * The wa-sqlite Engine worker: the Reference Engine.
 *
 * wa-sqlite is not a subject of the comparison. It is here so this harness can be calibrated
 * against numbers published elsewhere (wa-sqlite's own benchmark page and PGlite's), which means it
 * has to be opened and driven the way those pages do it: the synchronous wasm build plus
 * `MemoryVFS`, exactly as PGlite's `rtt-worker.js` does.
 *
 * A Configuration may ask for a non-default journal mode (`options.wasqlite.journalMode`), which is
 * applied immediately after `open_v2` and before any setup, and is verified rather than assumed:
 * SQLite answers a rejected `PRAGMA journal_mode` with the mode still in force instead of an error,
 * so an unverified pragma would silently give the journal-off column the default column's numbers.
 *
 * The one deliberate difference is what is timed. PGlite's page goes through wa-sqlite's `tag.js`
 * template helper; this worker calls `sqlite3.exec(db, sql, rowCallback)` and collects the decoded
 * rows, because that — SQL in, decoded rows out — is what the PGlite worker's `pg.exec(sql)` does,
 * and a Measurement has to bracket the same work on both sides to mean anything.
 *
 * **It runs the Concurrency Suite too.** One connection is not a reason to refuse it: an application
 * on wa-sqlite gets its concurrency by handing statements to that one connection from several
 * places, which is what `wasqliteExecutor` does through the shared single-session queue. Statements
 * interleave, transactions do not, and the column header says `interleaved on one session` so the
 * numbers are read against the postmaster's rather than confused with them.
 */

import * as SQLite from "wa-sqlite";
import SQLiteModuleFactory from "wa-sqlite/dist/wa-sqlite.mjs";
import wasqliteWasmUrl from "wa-sqlite/dist/wa-sqlite.wasm?url";
import { MemoryVFS } from "wa-sqlite/src/examples/MemoryVFS.js";

import type { WasqliteOpenOptions } from "../contract";
import { toErrorPayload } from "../protocol";
import type { EngineOkResponse, EngineReadyMessage, EngineRequest, EngineResponse } from "../protocol";
import type { ScenarioExecutor } from "../scenario-runner";
import { runScenario } from "../scenario-runner";
import { singleSessionExecutor } from "../single-session";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/**
 * Emscripten resolves `wa-sqlite.wasm` relative to its own module URL, which is wrong once the
 * loader has been bundled into a chunk. Vite gives us the emitted asset's URL, so hand it over
 * rather than relying on the bundler happening to keep the two files adjacent.
 */
const MODULE_CONFIG = { locateFile: (): string => wasqliteWasmUrl };

/** The database name for a Memory Configuration; `MemoryVFS` keys its heap by it. */
const MEMORY_DATABASE_NAME = "benchmark";

/** The VFS registration name. Nothing else registers one, and it is registered as the default. */
const MEMORY_VFS_NAME = "memory";

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

/** Run one SQL string and return the first column of its first row as text, if it produced one. */
async function firstValue(open: OpenEngine, sql: string): Promise<string | null> {
  const values: string[] = [];
  await open.sqlite3.exec(open.db, sql, (row) => {
    const value = row[0];
    if (value !== null && value !== undefined) {
      values.push(String(value));
    }
  });
  return values[0] ?? null;
}

/**
 * Force the journal mode this Configuration asked for, and prove SQLite took it.
 *
 * `PRAGMA journal_mode = X` returns the mode that is actually in force afterwards, which is not
 * always the one requested; the follow-up read is what turns "asked" into "is".
 */
async function applyJournalMode(open: OpenEngine, journalMode: WasqliteOpenOptions["journalMode"]): Promise<void> {
  await firstValue(open, `PRAGMA journal_mode = ${journalMode.toUpperCase()};`);
  const active = await firstValue(open, "PRAGMA journal_mode;");
  if (active?.toLowerCase() !== journalMode) {
    throw new Error(
      `wa-sqlite did not accept PRAGMA journal_mode = ${journalMode.toUpperCase()}; it reports "${active ?? "(no row)"}"`,
    );
  }
}

async function openEngine(dataDir: string, wasqlite: WasqliteOpenOptions | undefined): Promise<OpenEngine> {
  // `SQLiteModuleFactory` is typed as returning `Promise<any>` upstream; keep it opaque here and let
  // `Factory` be the only thing that ever looks inside the Emscripten module.
  const module: object = await SQLiteModuleFactory(MODULE_CONFIG);
  const sqlite3 = SQLite.Factory(module);
  // 1.1.x builds a VFS through the static `create`, which names it and awaits its readiness; the
  // 1.0.0 `new MemoryVFS()` form no longer exists.
  const vfs = await MemoryVFS.create(MEMORY_VFS_NAME, module);
  sqlite3.vfs_register(vfs, true);
  const db = await sqlite3.open_v2(dataDir === "" ? MEMORY_DATABASE_NAME : dataDir);
  const open: OpenEngine = { sqlite3, db };
  // Before any setup and outside every Measurement: the pragma is part of opening the Engine.
  if (wasqlite !== undefined) {
    await applyJournalMode(open, wasqlite.journalMode);
  }
  return open;
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

/**
 * The two SQLite result codes that are a *result* rather than a broken statement.
 *
 * `SQLITE_BUSY` (5) is what a `busy_timeout` reports when it gives up, which is the SQLite spelling
 * of the Postgres `lock_timeout` the same-row Benchmark sets; `SQLITE_LOCKED` (6) is its
 * within-connection twin. Everything else — a syntax error, a constraint, a full disk — is thrown
 * with the message SQLite gave it, because a bare number in a Detail line would tell a reader
 * nothing.
 */
const SQLITE_LOCK_CODES: readonly number[] = [5, 6];

/** The result code of a `SQLiteError`, or `undefined` for anything that is not one. */
function resultCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

/**
 * wa-sqlite's Clients: one connection, and one statement running on it at a time.
 *
 * The wasm build is synchronous — `exec` runs a statement to completion on this thread — so the
 * unit a second Client can be served between is the statement, and that is exactly what the shared
 * queue interleaves. A `transaction` Step holds the connection from `BEGIN` to `COMMIT`, so a
 * reader beside a bulk write waits for all of it, precisely as it does on PGlite. Nothing here is
 * serialised and then called concurrent: the column reports the concurrency this Engine has, which
 * is per-statement interleaving on one connection, and its header says so.
 */
function wasqliteExecutor(open: OpenEngine): ScenarioExecutor {
  return singleSessionExecutor(async (sql) => {
    try {
      await execute(open, sql);
      return undefined;
    } catch (error: unknown) {
      const code = resultCodeOf(error);
      if (code === undefined || !SQLITE_LOCK_CODES.includes(code)) {
        throw error;
      }
      return String(code);
    }
  });
}

async function handle(request: EngineRequest): Promise<void> {
  switch (request.kind) {
    case "open": {
      engine = await openEngine(request.dataDir, request.options?.wasqlite);
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
    case "concurrent": {
      const report = await runScenario(request.scenario, wasqliteExecutor(requireEngine()));
      post({ kind: "ok", id: request.id, measurement: null, report });
      return;
    }
    case "stats": {
      // Neither Engine holds a `WebAssembly.Memory` this worker created, so there is nothing here it
      // could measure. The case exists so a `stats` request answers rather than hangs; the memory
      // probe does not run these columns.
      post({ kind: "ok", id: request.id, measurement: null, stats: { wasmMemories: [] } });
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
