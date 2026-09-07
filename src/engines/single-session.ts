/**
 * Running a Scenario's Clients on an Engine that has exactly one place to run SQL.
 *
 * PGlite, the two pgrust wire builds and wa-sqlite all have one Session and one thing that runs a
 * statement. That is not a reason to refuse the Concurrency Suite — it is the answer the Suite is
 * asking for. An application built on any of them gets its concurrency the same way: several
 * callers hand statements to one place, the place serves them one at a time, and whoever is inside
 * a transaction keeps it until they commit. This module is that behaviour, written once, so the
 * four Engines that share it cannot drift into measuring four different things.
 *
 * **The unit of interleaving is the statement.** A Client's plain Step takes the session for one
 * statement and gives it back; another Client's statement can be served between two of this
 * Client's. A `transaction` Step takes it at `BEGIN` and holds it through `COMMIT` (or `ROLLBACK`),
 * so nothing interleaves inside one and a reader waiting on a bulk write waits for all of it.
 * That is exactly what `pg.query` and `pg.transaction` do on PGlite, which is why the PGlite worker
 * expresses it with those two calls rather than through this queue.
 *
 * **The queue is FIFO and yields only microtasks.** Every waiter resumes from a promise, so the
 * Clients really do take turns rather than one draining its whole program first. A `setTimeout(0)`
 * between statements would be a bigger yield and a worse measurement: the Suite's first row reports
 * the Scenario's own wall time, and a timer clamp per statement would put the browser's minimum
 * timeout into a number that is supposed to be the Engine's.
 */

import type { ScenarioExecutor } from "./scenario-runner";

/**
 * A FIFO lock over the one Session an Engine has.
 *
 * `run` resolves in the order it was called, whatever the work does — including reject, which is
 * why the chain the next waiter follows is the settled one rather than the caller's own promise: a
 * Client whose statement failed must not take the queue down with it.
 */
export class SessionQueue {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    const mine = (async (): Promise<T> => {
      await previous;
      return await work();
    })();
    this.#tail = mine.then(
      () => undefined,
      () => undefined,
    );
    return await mine;
  }
}

/**
 * What a single-session Engine supplies: one call that runs one statement to completion.
 *
 * It resolves with a code the Scenario may tolerate — a Postgres SQLSTATE, a SQLite result code —
 * when the database refused the statement for a reason that is a *result*, and with `undefined`
 * when the statement ran. Anything else throws, because a Scenario that quietly errored would
 * report a very fast column.
 */
export type SingleSessionQuery = (sql: string) => Promise<string | undefined>;

/**
 * The `ScenarioExecutor` for an Engine with one Session, given the one call that runs a statement.
 *
 * `resolveSession` answers 0 for every Client, which is also how a per-Session setup — the
 * `lock_timeout` the same-row Benchmark sets — ends up running exactly once. That is what such a
 * `SET` means where there is one place to run SQL.
 */
export function singleSessionExecutor(query: SingleSessionQuery): ScenarioExecutor {
  const queue = new SessionQueue();
  return {
    resolveSession: () => 0,
    setup: async (_session, sql) => {
      const refused = await queue.run(async () => await query(sql));
      if (refused !== undefined) {
        throw new Error(`the Scenario's setup was refused with ${refused}: ${sql}`);
      }
    },
    statement: async (_session, sql) => await queue.run(async () => await query(sql)),
    transaction: async (_session, statements) =>
      await queue.run(async () => {
        const begun = await query("BEGIN");
        if (begun !== undefined) {
          return begun;
        }
        for (const sql of statements) {
          const refused = await query(sql);
          if (refused !== undefined) {
            // Part of failing this transaction, not of the Client's next Step: the session is left
            // clean before the queue is handed on.
            await query("ROLLBACK");
            return refused;
          }
        }
        return await query("COMMIT");
      }),
  };
}
