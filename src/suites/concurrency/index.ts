/**
 * The Concurrency Suite: what happens when more than one thing is asked at a time.
 *
 * The other two Suites time one statement against one Engine. This one runs N **Clients** at once
 * and reports what they did to each other, which is a different question and has a different answer
 * per Engine. Every Engine answers it — there is no cell here that says "unavailable" — and the
 * answer each column gives is stated in its own header, because the numbers only mean something
 * beside it:
 *
 * - **pgrust Postmaster** gives every Client a Session and therefore a real backend of its own; the
 *   Clients contend in the buffer pool and the lock manager, as they would against any Postgres.
 *   Its columns say `one backend per Client`.
 * - **PGlite, both pgrust wire builds and wa-sqlite** have one Session and one place to run SQL, so
 *   Clients interleave per statement and not at all inside a transaction, which holds that one place
 *   from `BEGIN` to `COMMIT`. Their columns say `interleaved on one session`. That is the honest way
 *   an application gets concurrency out of any of them, and the numbers report it rather than hide
 *   it — the same shape of result on all four, produced by the same shared queue
 *   (`src/engines/single-session.ts`) so the columns differ in their database and nothing else.
 *
 * Refusing the Suite on the single-session Engines, as this Suite used to, said that a serialised
 * Run wearing the word "concurrent" would be dishonest — which is true, and is not what interleaving
 * per statement is. PGlite ran the Suite that way all along; the others could, and now do.
 *
 * The dataset is built in the untimed setup and is the same everywhere: 100 000 indexed rows with a
 * 100-byte payload, plus one row every writer fights over. It has two spellings, Postgres and
 * SQLite, exactly as the RTT Suite's setup does; so do the per-Session lock wait and the third
 * Benchmark's long query, and nothing else in the Suite differs between them.
 */

import type { EngineId, SqlDialect } from "../../engines/contract";
import type { Suite } from "../types";
import { buildConcurrencyBenchmarks, CONCURRENCY_CLIENTS, CONCURRENCY_ROWS, concurrencySetupFor } from "./scenarios";

export {
  BULK_INSERT_ROWS,
  buildConcurrencyBenchmarks,
  BUSY_TIMEOUT_MS,
  CONCURRENCY_CLIENTS,
  CONCURRENCY_ROWS,
  CONCURRENCY_SETUP_SQL,
  CONCURRENCY_SETUP_SQL_SQLITE,
  concurrencySetupFor,
  LOCK_TIMEOUT,
  LOCK_TIMEOUT_SQLSTATE,
  READ_FANOUT_STATEMENTS,
  SQLITE_BUSY_CODE,
  SQLITE_LONG_QUERY_STEPS,
  WRITE_TRANSACTIONS,
} from "./scenarios";

/** What a postmaster column's header says its Clients had: a Session, and a backend, each. */
export const ONE_BACKEND_PER_CLIENT = "one backend per Client";

/**
 * What every other column's header says: one place to run SQL, taken a statement at a time.
 *
 * The mode belongs in the header rather than in a footnote because the cell beside it cannot be read
 * without it. A reader p95 of 0.4 ms and one of 670 ms are both correct answers to "what did the
 * other Clients feel", and which one an Engine gives is decided entirely by this.
 */
export const INTERLEAVED_ON_ONE_SESSION = "interleaved on one session";

/** How this Engine runs the Suite: the line its column header and the Markdown export carry. */
export function concurrencyMode(engine: EngineId): string {
  return engine === "pgrust-postmaster" ? ONE_BACKEND_PER_CLIENT : INTERLEAVED_ON_ONE_SESSION;
}

/** How the export and the page name a Run's Client count. */
export function describeConcurrencyClients(clients: number, standard: boolean): string {
  return `Concurrency clients: ${clients}${standard ? "" : " (non-standard)"}`;
}

/** The Suite as run with `clients` Clients; `CONCURRENCY_CLIENTS` unless a URL asked for another. */
export function buildConcurrencySuite(clients: number, standard = clients === CONCURRENCY_CLIENTS): Suite {
  return {
    id: "concurrency",
    title: "Concurrency Suite",
    description:
      `Five scripted scenarios run by ${clients} clients at once against one ${CONCURRENCY_ROWS.toLocaleString("en-US")}-row ` +
      "indexed table: a read fan-out, a reader under a bulk write, short queries beside a long one, " +
      "writers on disjoint rows and writers on the same row. Every Engine runs them, and each column " +
      `header says which kind of concurrency it had: "${ONE_BACKEND_PER_CLIENT}" for the postmaster, ` +
      `"${INTERLEAVED_ON_ONE_SESSION}" everywhere else. Each row reports one headline number and its ` +
      "detail beneath the table.",
    benchmarks: buildConcurrencyBenchmarks(clients),
    benchmarksFor: (dialect) => buildConcurrencyBenchmarks(clients, dialect),
    initialSetupFor: (dialect: SqlDialect) => concurrencySetupFor(dialect),
    editableSetup: false,
    iterations: 1,
    aggregation: "mean",
    columnNoteFor: concurrencyMode,
    headerLine: describeConcurrencyClients(clients, standard),
  };
}

export const CONCURRENCY_SUITE: Suite = buildConcurrencySuite(CONCURRENCY_CLIENTS);
