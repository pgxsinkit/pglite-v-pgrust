import { describe, expect, test } from "bun:test";

import type { ScenarioClientReport, ScenarioReport } from "../../engines/scenario";
import {
  clientAt,
  clientsExcept,
  describeSpread,
  latenciesOf,
  maximum,
  percentile,
  sqlstateCount,
  statementsPerSecond,
  totalSamples,
} from "./statistics";

function client(
  index: number,
  latencies: readonly number[],
  sqlstates: Record<string, number> = {},
): ScenarioClientReport {
  return {
    client: index,
    session: index,
    samples: latencies.map((elapsedMs) => ({ kind: "statement", elapsedMs })),
    totalMs: latencies.reduce((total, value) => total + value, 0),
    sqlstates,
  };
}

const REPORT: ScenarioReport = {
  totalMs: 1000,
  clients: [client(0, [10, 20]), client(1, [1, 2, 3, 4], { "55P03": 2 }), client(2, [5], { "55P03": 1 })],
};

describe("percentile", () => {
  test("takes the nearest rank rather than interpolating between two real latencies", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
  });

  test("reports a single sample as every percentile of itself", () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
  });

  // An empty sample set has no percentile, and NaN is what the table renders as its empty cell —
  // which is the honest answer, unlike a zero.
  test("has no percentile for an empty sample set", () => {
    expect(Number.isNaN(percentile([], 0.95))).toBe(true);
    expect(Number.isNaN(maximum([]))).toBe(true);
  });
});

describe("reading a report", () => {
  test("pools the latencies of the Clients it is given", () => {
    expect(latenciesOf(REPORT.clients)).toEqual([10, 20, 1, 2, 3, 4, 5]);
    expect(totalSamples(REPORT.clients)).toBe(7);
  });

  test("separates the writer from the readers beside it", () => {
    expect(clientsExcept(REPORT, [0]).map((entry) => entry.client)).toEqual([1, 2]);
    expect(clientAt(REPORT, 0)?.samples).toHaveLength(2);
    expect(clientAt(REPORT, 9)).toBeUndefined();
  });

  test("adds up one SQLSTATE across every Client", () => {
    expect(sqlstateCount(REPORT.clients, "55P03")).toBe(3);
    expect(sqlstateCount(REPORT.clients, "40001")).toBe(0);
  });

  test("turns a count and a wall time into a rate, and refuses to divide by no time at all", () => {
    expect(statementsPerSecond(800, 400)).toBe(2000);
    expect(Number.isNaN(statementsPerSecond(800, 0))).toBe(true);
  });

  test("renders a per-Client spread as p50 / p95 / max", () => {
    expect(describeSpread([1, 2, 3, 4, 5])).toBe("3.00 / 5.00 / 5.00");
    expect(describeSpread([])).toBe("– / – / –");
  });
});
