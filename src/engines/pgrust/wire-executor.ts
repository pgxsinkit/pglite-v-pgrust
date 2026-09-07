/**
 * The Concurrency Suite's Clients on a pgrust wire session, shared by both builds of it.
 *
 * `pgrust` (JSPI, `--stdio-wire`) and `pgrust Threads` (`Atomics.wait`, `--stdio-wire-threaded`) are
 * different wasm modules with different host JS and different blocking primitives, but above the
 * pipe they are the same thing: one backend, one simple-query cycle at a time. So the only thing
 * either worker hands over here is its own "run one cycle and decode it" call, and the Clients, the
 * queue and the transaction boundary are the same code — and the same code PGlite's queue runs.
 *
 * A backend error becomes a SQLSTATE the Scenario can tolerate; an error with no SQLSTATE is thrown
 * with the backend's own message, because a bare empty code would tell a reader nothing about a Run
 * that failed.
 */

import type { ScenarioExecutor } from "../scenario-runner";
import { singleSessionExecutor } from "../single-session";
import type { QueryResult } from "./pgwire";
import { toQueryError } from "./pgwire";

/** One simple-query cycle, already decoded: what both pgrust workers can supply. */
export type WireQuery = (sql: string) => Promise<QueryResult>;

export function wireScenarioExecutor(query: WireQuery): ScenarioExecutor {
  return singleSessionExecutor(async (sql) => {
    const result = await query(sql);
    if (result.error === null) {
      return undefined;
    }
    if (result.error.code === "") {
      throw toQueryError(result.error);
    }
    return result.error.code;
  });
}
