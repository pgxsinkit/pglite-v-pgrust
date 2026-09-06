/**
 * Decoding one pgrust simple-query cycle into JS values.
 *
 * `WireSession.query()` hands back the raw backend message list; this turns it into rows, columns
 * and a command tag. It is pure and synchronous on purpose: it runs *inside* the Measurement window
 * (CONTEXT.md defines a Measurement as ending when decoded rows or a command tag are available in
 * JS), so it must be unit-testable without a wasm Engine anywhere in sight.
 *
 * A backend error arrives as an `E` message rather than a rejection, so decoding never throws;
 * `assertNoQueryError` is what turns it into a thrown Error at the Engine boundary. A Benchmark
 * that errors has to fail its Run loudly instead of recording a time for a query that did nothing.
 */

import type { WireMessage } from "../../vendor/pgrust/wire.js";
import { parseMessage } from "../../vendor/pgrust/wire.js";

export interface QueryError {
  readonly severity: string;
  readonly message: string;
  /**
   * The SQLSTATE (field `C`), or an empty string where the backend sent none.
   *
   * Kept beside the message because a Concurrency Scenario counts errors by SQLSTATE — a lock
   * timeout is `55P03` and is a result rather than a failure — and the message text is not something
   * to match on.
   */
  readonly code: string;
}

export interface QueryResult {
  /** Rows of the last result set, values decoded as text; a SQL NULL is `null`. */
  readonly rows: readonly (readonly (string | null)[])[];
  /** Column names of the last result set. */
  readonly columns: readonly string[];
  /** The last CommandComplete tag, e.g. `INSERT 0 1`. */
  readonly tag: string | null;
  /** The first backend error of the cycle, if any. */
  readonly error: QueryError | null;
  /** How many result sets (RowDescriptions) the cycle produced; multi-statement SQL yields many. */
  readonly resultSets: number;
}

/**
 * Decode every message of one simple-query cycle.
 *
 * Multi-statement SQL produces several result sets; every DataRow of every one of them is decoded
 * (that is the work being measured), but only the last set's rows and columns are kept, matching
 * what a client showing "the result" of a script would report.
 */
export function decodeQueryResult(messages: readonly WireMessage[]): QueryResult {
  let rows: (string | null)[][] = [];
  let columns: readonly string[] = [];
  let tag: string | null = null;
  let error: QueryError | null = null;
  let resultSets = 0;

  for (const message of messages) {
    switch (message.t) {
      case "T": {
        const description = parseMessage("T", message.body);
        columns = description.columns.map((column) => column.name);
        rows = [];
        resultSets += 1;
        break;
      }
      case "D": {
        rows.push([...parseMessage("D", message.body).values]);
        break;
      }
      case "C": {
        tag = parseMessage("C", message.body).tag;
        break;
      }
      case "E": {
        if (error === null) {
          const parsed = parseMessage("E", message.body);
          error = { severity: parsed.severity, message: parsed.message, code: parsed.fields["C"] ?? "" };
        }
        break;
      }
      default:
        break;
    }
  }

  return { rows, columns, tag, error, resultSets };
}

/** The Error the Engine boundary throws for a backend error, carrying the Postgres message text. */
export function toQueryError(error: QueryError): Error {
  const code = error.code === "" ? "" : ` (SQLSTATE ${error.code})`;
  return new Error(`pgrust ${error.severity}: ${error.message}${code}`);
}

/** Fail the Run rather than record a Measurement for a query the backend rejected. */
export function assertNoQueryError(result: QueryResult): void {
  if (result.error !== null) {
    throw toQueryError(result.error);
  }
}
