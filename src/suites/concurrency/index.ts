/**
 * The Concurrency Suite: what happens when more than one thing is asked at a time.
 *
 * The other two Suites time one statement against one Engine. This one runs N **Clients** at once
 * and reports what they did to each other, which is a different question and has a different answer
 * per Engine:
 *
 * - **pgrust Postmaster** gives every Client a Session and therefore a real backend of its own; the
 *   Clients contend in the buffer pool and the lock manager, as they would against any Postgres.
 * - **PGlite** has one instance and one queue, so Clients interleave per statement through
 *   `pg.query` and not at all inside a `pg.transaction`. That is the honest way an application gets
 *   concurrency out of PGlite, and the numbers report it rather than hide it.
 * - **Every other Engine** has one place to run SQL and no way to interleave. They are reported
 *   unavailable for this Suite with the reason in the cell, because the only number they could
 *   produce would be a serialised Run wearing the word "concurrent".
 *
 * The dataset is built in the untimed setup and is the same everywhere: 100 000 indexed rows with a
 * 100-byte payload, plus one row every writer fights over.
 */

import { SINGLE_SESSION_SUITE_REASON, SYNCHRONOUS_API_SUITE_REASON } from "../../engines/availability";
import type { EngineId } from "../../engines/contract";
import type { Suite } from "../types";
import { buildConcurrencyBenchmarks, CONCURRENCY_CLIENTS, CONCURRENCY_ROWS, CONCURRENCY_SETUP_SQL } from "./scenarios";

export {
  BULK_INSERT_ROWS,
  buildConcurrencyBenchmarks,
  CONCURRENCY_CLIENTS,
  CONCURRENCY_ROWS,
  CONCURRENCY_SETUP_SQL,
  LOCK_TIMEOUT,
  LOCK_TIMEOUT_SQLSTATE,
  READ_FANOUT_STATEMENTS,
  WRITE_TRANSACTIONS,
} from "./scenarios";

/**
 * The Engines that cannot run this Suite, and what their cells say instead.
 *
 * Both reasons are properties of the Engine rather than of the browser: no header, no flag and no
 * asset would change either of them.
 */
export const CONCURRENCY_UNSUPPORTED_ENGINES: Readonly<Partial<Record<EngineId, string>>> = {
  pgrust: SINGLE_SESSION_SUITE_REASON,
  "pgrust-threads": SINGLE_SESSION_SUITE_REASON,
  wasqlite: SYNCHRONOUS_API_SUITE_REASON,
};

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
      "writers on disjoint rows and writers on the same row. Each row reports one headline number " +
      "and its detail beneath the table.",
    benchmarks: buildConcurrencyBenchmarks(clients),
    // Postgres only, and deliberately: the one SQLite Engine here cannot run this Suite at all.
    initialSetupFor: () => CONCURRENCY_SETUP_SQL,
    editableSetup: false,
    iterations: 1,
    aggregation: "mean",
    unsupportedEngines: CONCURRENCY_UNSUPPORTED_ENGINES,
    headerLine: describeConcurrencyClients(clients, standard),
  };
}

export const CONCURRENCY_SUITE: Suite = buildConcurrencySuite(CONCURRENCY_CLIENTS);
