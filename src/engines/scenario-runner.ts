/**
 * Running a Scenario, once, inside an Engine's worker.
 *
 * Every Engine that can run the Concurrency Suite runs it through this: the Clients, the Steps, the
 * Signals, the clock and the SQLSTATE counting are the same code everywhere, and the only thing an
 * Engine supplies is what "run this statement on that Session" means (`ScenarioExecutor`). Two
 * columns that differed in their scenario driver as well as in their database would be measuring
 * two things at once.
 *
 * **What is timed.** One sample per Step iteration, taken around the Engine call and nothing else:
 * a plain statement is one sample, and a `transaction` Step is **one** sample covering the whole
 * transaction — its `BEGIN`, its statements and its `COMMIT`. That is deliberate. A postmaster
 * Session can time a `COMMIT` on its own and PGlite cannot (its `transaction` issues both ends
 * itself), so the only unit both Engines can be asked for honestly is the transaction, and "commit
 * latency" in the Concurrency Suite means the latency of one short transaction.
 *
 * **What fails a Run.** A backend error carrying a SQLSTATE the Scenario lists in `tolerate` is
 * counted and the Client carries on — that is the whole point of the same-row Benchmark, where a
 * `lock_timeout` firing is the result. Any other error is thrown: a Scenario that quietly errored
 * would report a very fast column, which is worse than a failed one.
 */

import type {
  ConcurrentScenario,
  ScenarioClient,
  ScenarioClientReport,
  ScenarioReport,
  ScenarioSample,
  ScenarioStep,
} from "./scenario";
import { clientSession, isRepeatStep, isSignalStep, isTransactionStep, isUntilSignalStep } from "./scenario";

/**
 * How many statements one `untilSignal` loop may run before the Scenario is declared broken.
 *
 * A loop whose Signal never arrives would otherwise spin for the lifetime of the page. The bound is
 * far above anything the Suite can reach in its own wall-time budget.
 */
export const MAX_UNTIL_SIGNAL_STATEMENTS = 200_000;

/** How long one `untilSignal` loop may run before the Scenario is declared broken. */
export const MAX_UNTIL_SIGNAL_MS = 180_000;

/** What an Engine has to supply for its Sessions to be scriptable. */
export interface ScenarioExecutor {
  /**
   * The Session this Engine will really run a Client's work on.
   *
   * The postmaster answers with the Session the Client asked for; an Engine with one place to run
   * SQL answers 0 for every Client, which is also how the per-Session setup ends up running once.
   */
  resolveSession(requested: number): number;
  /** Untimed, before any Client starts. */
  setup(session: number, sql: string): Promise<void>;
  /** One statement. Resolves with its SQLSTATE if the backend refused it, `undefined` if it ran. */
  statement(session: number, sql: string): Promise<string | undefined>;
  /** One transaction, committed or rolled back. Same return contract as `statement`. */
  transaction(session: number, statements: readonly string[]): Promise<string | undefined>;
}

/** The Signals a Scenario raises, shared by every Client in it. */
class SignalBoard {
  readonly #raised = new Set<string>();

  raise(name: string): void {
    this.#raised.add(name);
  }

  isRaised(name: string): boolean {
    return this.#raised.has(name);
  }
}

function countSqlstate(counts: Record<string, number>, sqlstate: string): void {
  counts[sqlstate] = (counts[sqlstate] ?? 0) + 1;
}

/** One recorded unit of work, timed around the Engine call and nothing else. */
async function runUnit(kind: ScenarioSample["kind"], call: () => Promise<string | undefined>): Promise<ScenarioSample> {
  const startTime = performance.now();
  const sqlstate = await call();
  const elapsedMs = performance.now() - startTime;
  return sqlstate === undefined ? { kind, elapsedMs } : { kind, elapsedMs, sqlstate };
}

async function runClient(
  scenario: ConcurrentScenario,
  client: ScenarioClient,
  index: number,
  executor: ScenarioExecutor,
  signals: SignalBoard,
): Promise<ScenarioClientReport> {
  const tolerated = new Set(scenario.tolerate ?? []);
  const session = executor.resolveSession(clientSession(client, index));
  const samples: ScenarioSample[] = [];
  const sqlstates: Record<string, number> = {};
  const startTime = performance.now();

  const record = (sample: ScenarioSample): void => {
    samples.push(sample);
    if (sample.sqlstate === undefined) {
      return;
    }
    if (!tolerated.has(sample.sqlstate)) {
      throw new Error(
        `Scenario "${scenario.id}", client ${index}: SQLSTATE ${sample.sqlstate} is not one this Scenario tolerates`,
      );
    }
    countSqlstate(sqlstates, sample.sqlstate);
  };

  const runStep = async (step: ScenarioStep): Promise<void> => {
    if (isSignalStep(step)) {
      signals.raise(step.signal);
      return;
    }
    if (isTransactionStep(step)) {
      record(await runUnit("transaction", async () => await executor.transaction(session, step.transaction)));
      return;
    }
    if (isRepeatStep(step)) {
      for (let iteration = 0; iteration < step.repeat; iteration += 1) {
        record(await runUnit("statement", async () => await executor.statement(session, step.sql)));
      }
      return;
    }
    if (isUntilSignalStep(step)) {
      const deadline = performance.now() + MAX_UNTIL_SIGNAL_MS;
      // Do-while, not while-do: a Client whose Signal is already up still contributes one sample,
      // and a Benchmark whose readers all finished before their writer started would otherwise have
      // nothing to take a percentile of.
      for (let iteration = 0; ; iteration += 1) {
        record(await runUnit("statement", async () => await executor.statement(session, step.sql)));
        if (signals.isRaised(step.untilSignal)) {
          return;
        }
        if (iteration >= MAX_UNTIL_SIGNAL_STATEMENTS || performance.now() > deadline) {
          throw new Error(
            `Scenario "${scenario.id}", client ${index}: signal "${step.untilSignal}" never arrived ` +
              `(${iteration + 1} statements)`,
          );
        }
      }
    }
    record(await runUnit("statement", async () => await executor.statement(session, step.sql)));
  };

  for (const step of client.steps) {
    await runStep(step);
  }
  return { client: index, session, samples, totalMs: performance.now() - startTime, sqlstates };
}

/** The distinct Sessions this Engine will really use, in order. */
function distinctSessions(scenario: ConcurrentScenario, executor: ScenarioExecutor): readonly number[] {
  const sessions: number[] = [];
  scenario.clients.forEach((client, index) => {
    const session = executor.resolveSession(clientSession(client, index));
    if (!sessions.includes(session)) {
      sessions.push(session);
    }
  });
  return sessions;
}

export async function runScenario(scenario: ConcurrentScenario, executor: ScenarioExecutor): Promise<ScenarioReport> {
  const signals = new SignalBoard();
  for (const sql of scenario.setup ?? []) {
    for (const session of distinctSessions(scenario, executor)) {
      await executor.setup(session, sql);
    }
  }
  const startTime = performance.now();
  const clients = await Promise.all(
    scenario.clients.map(async (client, index) => await runClient(scenario, client, index, executor, signals)),
  );
  return { totalMs: performance.now() - startTime, clients };
}
