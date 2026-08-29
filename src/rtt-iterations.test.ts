import { describe, expect, test } from "bun:test";

import {
  applyRttIterations,
  describeRttIterations,
  MAX_RTT_ITERATIONS,
  MIN_RTT_ITERATIONS,
  parseRttIterations,
} from "./rtt-iterations";
import { RTT_SUITE } from "./suites/rtt";
import type { Suite } from "./suites/types";

/**
 * A stand-in for the Speedtest Suite: the real one imports its `.sql` files through the bundler's
 * `?raw`, which does not resolve under `bun test`.
 */
const SPEEDTEST_SHAPED_SUITE: Suite = {
  id: "speedtest",
  title: "Speedtest Suite",
  description: "",
  benchmarks: [{ id: "1", label: "Test 1", sql: "SELECT 1;" }],
  defaultSetupSql: "",
  editableSetup: true,
  iterations: 1,
  aggregation: "mean",
};

describe("parseRttIterations", () => {
  test("accepts an integer inside the supported range", () => {
    expect(parseRttIterations("?rttIterations=5")).toBe(5);
    expect(parseRttIterations(`?rttIterations=${MIN_RTT_ITERATIONS}`)).toBe(MIN_RTT_ITERATIONS);
    expect(parseRttIterations(`?rttIterations=${MAX_RTT_ITERATIONS}`)).toBe(MAX_RTT_ITERATIONS);
  });

  test("ignores an absent, empty or non-integer value", () => {
    expect(parseRttIterations("")).toBeNull();
    expect(parseRttIterations("?other=5")).toBeNull();
    expect(parseRttIterations("?rttIterations=")).toBeNull();
    expect(parseRttIterations("?rttIterations=abc")).toBeNull();
    expect(parseRttIterations("?rttIterations=2.5")).toBeNull();
    expect(parseRttIterations("?rttIterations=-3")).toBeNull();
    expect(parseRttIterations("?rttIterations=1e3")).toBeNull();
  });

  test("ignores a value outside the supported range", () => {
    expect(parseRttIterations(`?rttIterations=${MIN_RTT_ITERATIONS - 1}`)).toBeNull();
    expect(parseRttIterations(`?rttIterations=${MAX_RTT_ITERATIONS + 1}`)).toBeNull();
  });
});

describe("describeRttIterations", () => {
  test("marks the count as non-standard so a short Run cannot pass as a real one", () => {
    expect(describeRttIterations(5)).toBe("RTT iterations: 5 (non-standard)");
  });
});

describe("applyRttIterations", () => {
  test("leaves the RTT Suite at its defined 100 iterations without an override", () => {
    expect(applyRttIterations(RTT_SUITE, null).iterations).toBe(100);
    expect(applyRttIterations(RTT_SUITE, null)).toBe(RTT_SUITE);
  });

  test("replaces only the iteration count, leaving the Benchmarks and setup untouched", () => {
    const overridden = applyRttIterations(RTT_SUITE, 3);
    expect(overridden.iterations).toBe(3);
    expect(overridden.benchmarks).toBe(RTT_SUITE.benchmarks);
    expect(overridden.defaultSetupSql).toBe(RTT_SUITE.defaultSetupSql);
    expect(overridden.aggregation).toBe(RTT_SUITE.aggregation);
  });

  test("never touches the Speedtest Suite", () => {
    expect(applyRttIterations(SPEEDTEST_SHAPED_SUITE, 3)).toBe(SPEEDTEST_SHAPED_SUITE);
  });
});
