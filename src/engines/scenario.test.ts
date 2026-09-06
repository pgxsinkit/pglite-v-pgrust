import { describe, expect, test } from "bun:test";

import type { ConcurrentScenario } from "./scenario";
import {
  clientSession,
  isRepeatStep,
  isSignalStep,
  isTransactionStep,
  isUntilSignalStep,
  mapScenarioSql,
  scenarioSessions,
} from "./scenario";

const SCENARIO: ConcurrentScenario = {
  id: "example",
  setup: ["SET lock_timeout = '2s'"],
  tolerate: ["55P03"],
  clients: [
    { steps: [{ transaction: ["CREATE TABLE t (a int)", "INSERT INTO t VALUES (1)"] }, { signal: "written" }] },
    { steps: [{ untilSignal: "written", sql: "SELECT 1" }, { repeat: 3, sql: "SELECT 2" }, { sql: "SELECT 3" }] },
  ],
};

describe("the Step kinds", () => {
  test("are told apart by the field that makes each of them what it is", () => {
    expect(isTransactionStep({ transaction: ["SELECT 1"] })).toBe(true);
    expect(isSignalStep({ signal: "done" })).toBe(true);
    expect(isUntilSignalStep({ untilSignal: "done", sql: "SELECT 1" })).toBe(true);
    expect(isRepeatStep({ repeat: 2, sql: "SELECT 1" })).toBe(true);
    // A plain statement is none of them, which is what makes it the fall-through.
    const plain = { sql: "SELECT 1" };
    expect([isTransactionStep(plain), isSignalStep(plain), isUntilSignalStep(plain), isRepeatStep(plain)]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("mapScenarioSql", () => {
  // A Configuration's rewrite has to reach a Scenario exactly as it reaches a Benchmark's SQL: an
  // unlogged column whose Scenario still said CREATE TABLE would be the logged column twice over.
  test("rewrites every statement of every Client, and the setup with them", () => {
    const rewritten = mapScenarioSql(SCENARIO, (sql) => sql.replace("CREATE TABLE", "CREATE UNLOGGED TABLE"));
    const transaction = rewritten.clients[0]?.steps[0];
    expect(transaction).toEqual({ transaction: ["CREATE UNLOGGED TABLE t (a int)", "INSERT INTO t VALUES (1)"] });
    expect(rewritten.setup).toEqual(["SET lock_timeout = '2s'"]);
  });

  test("leaves a Signal Step alone: there is no SQL in it to rewrite", () => {
    const rewritten = mapScenarioSql(SCENARIO, () => "REWRITTEN");
    expect(rewritten.clients[0]?.steps[1]).toEqual({ signal: "written" });
  });

  test("keeps the loop count and the Signal name of the Steps that carry one", () => {
    const rewritten = mapScenarioSql(SCENARIO, (sql) => `${sql} /* seen */`);
    expect(rewritten.clients[1]?.steps[0]).toEqual({ untilSignal: "written", sql: "SELECT 1 /* seen */" });
    expect(rewritten.clients[1]?.steps[1]).toEqual({ repeat: 3, sql: "SELECT 2 /* seen */" });
  });

  test("carries the id and the tolerated SQLSTATEs through untouched", () => {
    const rewritten = mapScenarioSql(SCENARIO, (sql) => sql);
    expect(rewritten.id).toBe("example");
    expect(rewritten.tolerate).toEqual(["55P03"]);
  });
});

describe("sessions", () => {
  test("give each Client its own Session by index unless it named one", () => {
    expect(clientSession({ steps: [] }, 2)).toBe(2);
    expect(clientSession({ session: 0, steps: [] }, 2)).toBe(0);
  });

  test("count what a Scenario needs, so an Engine is never opened with too few", () => {
    expect(scenarioSessions(SCENARIO)).toBe(2);
    expect(scenarioSessions({ id: "one", clients: [{ steps: [] }] })).toBe(1);
    // Every Client on Session 0 is one Session, however many Clients there are.
    expect(
      scenarioSessions({
        id: "shared",
        clients: [
          { session: 0, steps: [] },
          { session: 0, steps: [] },
        ],
      }),
    ).toBe(1);
  });
});
