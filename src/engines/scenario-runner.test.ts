import { describe, expect, test } from "bun:test";

import type { ConcurrentScenario } from "./scenario";
import type { ScenarioExecutor } from "./scenario-runner";
import { runScenario } from "./scenario-runner";

/** What every fake Engine below records: who ran what, on which Session, in what order. */
interface Recorded {
  readonly session: number;
  readonly sql: string;
}

interface FakeEngine extends ScenarioExecutor {
  readonly statements: Recorded[];
  readonly transactions: { readonly session: number; readonly statements: readonly string[] }[];
  readonly setups: Recorded[];
}

/**
 * A fake Engine with `sessions` Sessions.
 *
 * `sessions: 1` is every Engine that has one place to run SQL; anything more is the postmaster,
 * where Client `i` really does get backend `i`. `fail` decides which statements come back with a
 * SQLSTATE instead of running.
 */
function fakeEngine(sessions: number, fail: (sql: string) => string | undefined = () => undefined): FakeEngine {
  const statements: Recorded[] = [];
  const transactions: { session: number; statements: readonly string[] }[] = [];
  const setups: Recorded[] = [];
  return {
    statements,
    transactions,
    setups,
    resolveSession: (requested) => (sessions === 1 ? 0 : requested),
    setup: async (session, sql) => {
      setups.push({ session, sql });
    },
    statement: async (session, sql) => {
      statements.push({ session, sql });
      return fail(sql);
    },
    transaction: async (session, sqls) => {
      transactions.push({ session, statements: sqls });
      return sqls.map(fail).find((sqlstate) => sqlstate !== undefined);
    },
  };
}

describe("runScenario, the Step kinds", () => {
  test("runs a plain statement once and a repeat Step as many times as it says", async () => {
    const engine = fakeEngine(1);
    const report = await runScenario(
      { id: "steps", clients: [{ steps: [{ sql: "SELECT 1" }, { repeat: 3, sql: "SELECT 2" }] }] },
      engine,
    );
    expect(engine.statements.map((recorded) => recorded.sql)).toEqual(["SELECT 1", "SELECT 2", "SELECT 2", "SELECT 2"]);
    expect(report.clients[0]?.samples).toHaveLength(4);
  });

  // One sample for the whole transaction, because that is the only unit both a postmaster Session
  // and PGlite's `transaction` can be asked for honestly.
  test("records a transaction as one sample covering all of it", async () => {
    const engine = fakeEngine(1);
    const report = await runScenario(
      { id: "tx", clients: [{ steps: [{ transaction: ["UPDATE t SET a = 1", "UPDATE t SET a = 2"] }] }] },
      engine,
    );
    expect(engine.transactions).toEqual([{ session: 0, statements: ["UPDATE t SET a = 1", "UPDATE t SET a = 2"] }]);
    expect(report.clients[0]?.samples).toEqual([
      { kind: "transaction", elapsedMs: report.clients[0]?.samples[0]?.elapsedMs ?? 0 },
    ]);
  });

  test("loops an untilSignal Step until another Client raises it", async () => {
    const engine = fakeEngine(2);
    const scenario: ConcurrentScenario = {
      id: "signal",
      clients: [
        { steps: [{ repeat: 5, sql: "SLOW" }, { signal: "done" }] },
        { steps: [{ untilSignal: "done", sql: "FAST" }] },
      ],
    };
    const report = await runScenario(scenario, engine);
    const reader = report.clients[1];
    expect(reader?.samples.length).toBeGreaterThanOrEqual(1);
    expect(engine.statements.filter((recorded) => recorded.sql === "FAST").length).toBe(reader?.samples.length ?? 0);
  });

  // A reader whose writer finished first still ran once: a percentile of an empty sample set is a
  // number nothing measured, and an empty cell hides the very thing the Benchmark is about.
  test("runs an untilSignal Step at least once, even when the Signal is already up", async () => {
    const engine = fakeEngine(2);
    const report = await runScenario(
      {
        id: "already",
        clients: [{ steps: [{ signal: "done" }] }, { steps: [{ untilSignal: "done", sql: "READ" }] }],
      },
      engine,
    );
    expect(report.clients[1]?.samples).toHaveLength(1);
  });
});

describe("runScenario, Sessions", () => {
  test("sends Client i to Session i where the Engine has one Session each", async () => {
    const engine = fakeEngine(3);
    await runScenario(
      {
        id: "fan-out",
        clients: [{ steps: [{ sql: "A" }] }, { steps: [{ sql: "B" }] }, { steps: [{ sql: "C" }] }],
      },
      engine,
    );
    expect(engine.statements).toEqual([
      { session: 0, sql: "A" },
      { session: 1, sql: "B" },
      { session: 2, sql: "C" },
    ]);
  });

  test("sends every Client to Session 0 where the Engine has one, and reports that in the samples", async () => {
    const engine = fakeEngine(1);
    const report = await runScenario(
      { id: "one-session", clients: [{ steps: [{ sql: "A" }] }, { steps: [{ sql: "B" }] }] },
      engine,
    );
    expect(engine.statements.map((recorded) => recorded.session)).toEqual([0, 0]);
    expect(report.clients.map((client) => client.session)).toEqual([0, 0]);
  });

  // `SET lock_timeout` means "on this Session": once where there is one Session, and once per
  // Session where there are several.
  test("runs the setup once per distinct Session, before any Client starts", async () => {
    const shared = fakeEngine(1);
    await runScenario(
      { id: "setup", setup: ["SET lock_timeout = '2s'"], clients: [{ steps: [] }, { steps: [] }] },
      shared,
    );
    expect(shared.setups).toEqual([{ session: 0, sql: "SET lock_timeout = '2s'" }]);

    const perSession = fakeEngine(2);
    await runScenario(
      { id: "setup", setup: ["SET lock_timeout = '2s'"], clients: [{ steps: [] }, { steps: [] }] },
      perSession,
    );
    expect(perSession.setups.map((recorded) => recorded.session)).toEqual([0, 1]);
  });
});

describe("runScenario, failures", () => {
  test("counts a tolerated SQLSTATE and carries on", async () => {
    const engine = fakeEngine(1, (sql) => (sql === "CONTENDED" ? "55P03" : undefined));
    const report = await runScenario(
      {
        id: "tolerated",
        tolerate: ["55P03"],
        clients: [{ steps: [{ repeat: 2, sql: "CONTENDED" }, { sql: "FINE" }] }],
      },
      engine,
    );
    expect(report.clients[0]?.sqlstates).toEqual({ "55P03": 2 });
    expect(report.clients[0]?.samples).toHaveLength(3);
    expect(report.clients[0]?.samples[0]?.sqlstate).toBe("55P03");
  });

  // A Scenario that quietly errored would report a very fast column, which is worse than a failed one.
  test("fails the Run on a SQLSTATE the Scenario does not tolerate", async () => {
    const engine = fakeEngine(1, () => "42P01");
    let message = "";
    try {
      await runScenario(
        { id: "untolerated", tolerate: ["55P03"], clients: [{ steps: [{ sql: "SELECT 1" }] }] },
        engine,
      );
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("SQLSTATE 42P01");
    expect(message).toContain("client 0");
  });
});

describe("runScenario, the report", () => {
  test("times every Client and the Scenario, and names each Client by its index", async () => {
    const engine = fakeEngine(2);
    const report = await runScenario(
      { id: "timed", clients: [{ steps: [{ sql: "A" }] }, { steps: [{ sql: "B" }] }] },
      engine,
    );
    expect(report.clients.map((client) => client.client)).toEqual([0, 1]);
    expect(report.totalMs).toBeGreaterThanOrEqual(0);
    for (const client of report.clients) {
      expect(client.totalMs).toBeGreaterThanOrEqual(0);
      expect(client.samples.every((sample) => Number.isFinite(sample.elapsedMs))).toBe(true);
    }
  });
});
