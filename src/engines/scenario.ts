/**
 * The scripted concurrent Scenario: what a Suite hands an Engine when one statement at a time is not
 * the question.
 *
 * A Scenario is a list of **Clients**, each a small program of Steps, all of them run at once. It is
 * deliberately data rather than code: it crosses the worker boundary by structured clone, it is
 * rewritten by a Configuration's `modSql` on the main thread exactly as a Benchmark's SQL is, and
 * every Engine that can run it runs the same bytes.
 *
 * What "at once" means is the Engine's answer, not this file's, and the whole point of measuring it:
 *
 * - **pgrust Postmaster** gives Client `i` its own Session, and therefore its own real backend on its
 *   own guest thread. Two Clients are two backends in one buffer pool and one lock manager.
 * - **PGlite** has one instance and one queue. Plain Steps go through `pg.query`, so Clients
 *   interleave per statement; a `transaction` Step goes through `pg.transaction`, which holds the
 *   queue until its callback resolves, so nothing interleaves inside one. That is the honest way an
 *   application gets concurrency out of PGlite, and it is what the numbers report.
 * - **Every other Engine** — both pgrust wire builds and wa-sqlite — has one place to run SQL too,
 *   and answers exactly as PGlite does: a Client takes it for one statement, or for a whole
 *   transaction, and gives it back (`../engines/single-session.ts`). Not a serialised Run wearing
 *   the word "concurrent": per-statement interleaving is the concurrency such an Engine has, and the
 *   Suite states the mode in the column header so the number underneath can be read.
 */

/** One statement, run once. */
export interface ScenarioStatementStep {
  readonly sql: string;
}

/** One transaction: every statement in order, all of it committed or none of it. */
export interface ScenarioTransactionStep {
  readonly transaction: readonly string[];
}

/** One statement, run `repeat` times in a row. */
export interface ScenarioRepeatStep {
  readonly repeat: number;
  readonly sql: string;
}

/**
 * One statement, run over and over until another Client raises `untilSignal`.
 *
 * Always at least once: the loop checks the Signal after a statement rather than before, so a Client
 * whose Signal arrives while it is still starting still contributes a Measurement instead of an
 * empty sample set.
 */
export interface ScenarioUntilSignalStep {
  readonly untilSignal: string;
  readonly sql: string;
}

/** Raise a Signal. Every Client waiting on it stops after its statement in flight. */
export interface ScenarioSignalStep {
  readonly signal: string;
}

export type ScenarioStep =
  | ScenarioStatementStep
  | ScenarioTransactionStep
  | ScenarioRepeatStep
  | ScenarioUntilSignalStep
  | ScenarioSignalStep;

export function isTransactionStep(step: ScenarioStep): step is ScenarioTransactionStep {
  return "transaction" in step;
}

export function isSignalStep(step: ScenarioStep): step is ScenarioSignalStep {
  return "signal" in step;
}

export function isUntilSignalStep(step: ScenarioStep): step is ScenarioUntilSignalStep {
  return "untilSignal" in step;
}

export function isRepeatStep(step: ScenarioStep): step is ScenarioRepeatStep {
  return "repeat" in step;
}

/** One scripted program, run against one Session. */
export interface ScenarioClient {
  /** Which Session this Client runs on; defaults to its own index, which is what N Clients want. */
  readonly session?: number;
  readonly steps: readonly ScenarioStep[];
}

export interface ConcurrentScenario {
  readonly id: string;
  /**
   * Statements run untimed on **every** Session before any Client starts.
   *
   * Where the Engine has one Session — PGlite — they are run once, which is exactly what a
   * per-session GUC like `lock_timeout` means there.
   */
  readonly setup?: readonly string[];
  /**
   * SQLSTATEs this Scenario expects and counts rather than fails on, e.g. `55P03` where the point of
   * the Benchmark is that a lock timeout fires. Anything else is a Run failure: a Scenario that
   * quietly errored would otherwise report a very fast column.
   */
  readonly tolerate?: readonly string[];
  readonly clients: readonly ScenarioClient[];
}

/** One recorded unit of work: a statement, or a whole transaction. */
export interface ScenarioSample {
  readonly kind: "statement" | "transaction";
  readonly elapsedMs: number;
  /** The SQLSTATE this unit failed with, when it failed and the Scenario tolerates it. */
  readonly sqlstate?: string;
}

export interface ScenarioClientReport {
  /** The Client's index in the Scenario. */
  readonly client: number;
  /** The Session it ran on; the same number on every Engine that has only one. */
  readonly session: number;
  /** Every unit this Client ran, in order. */
  readonly samples: readonly ScenarioSample[];
  /** This Client's own wall time, from its first Step to its last. */
  readonly totalMs: number;
  /** How many units failed, by SQLSTATE. */
  readonly sqlstates: Readonly<Record<string, number>>;
}

export interface ScenarioReport {
  /** The Scenario's wall time: from the first Client starting to the last one finishing. */
  readonly totalMs: number;
  readonly clients: readonly ScenarioClientReport[];
}

/** Apply a rewrite to every SQL string in a Scenario — a Configuration's `modSql`, and nothing else. */
export function mapScenarioSql(scenario: ConcurrentScenario, rewrite: (sql: string) => string): ConcurrentScenario {
  const setup = scenario.setup === undefined ? undefined : scenario.setup.map(rewrite);
  const clients = scenario.clients.map((client) => ({
    ...client,
    steps: client.steps.map((step): ScenarioStep => {
      if (isSignalStep(step)) {
        return step;
      }
      if (isTransactionStep(step)) {
        return { transaction: step.transaction.map(rewrite) };
      }
      return { ...step, sql: rewrite(step.sql) };
    }),
  }));
  return setup === undefined ? { ...scenario, clients } : { ...scenario, setup, clients };
}

/** Which Session a Client runs on: its own, unless it named another. */
export function clientSession(client: ScenarioClient, index: number): number {
  return client.session ?? index;
}

/** How many Sessions a Scenario needs, which is what the Engine is opened with. */
export function scenarioSessions(scenario: ConcurrentScenario): number {
  let sessions = 1;
  scenario.clients.forEach((client, index) => {
    sessions = Math.max(sessions, clientSession(client, index) + 1);
  });
  return sessions;
}
