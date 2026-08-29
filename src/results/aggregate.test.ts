import { describe, expect, test } from "bun:test";

import type { Measurement } from "../engines/contract";
import { aggregateMeasurements, mean, trimmedMean } from "./aggregate";

function measurements(values: readonly number[]): readonly Measurement[] {
  return values.map((elapsedMs) => ({ elapsedMs }));
}

describe("mean", () => {
  test("averages the values", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  test("returns the single value for one iteration", () => {
    expect(mean([12.5])).toBe(12.5);
  });

  test("rejects an empty sample", () => {
    expect(() => mean([])).toThrow("Cannot take the mean of zero Measurements");
  });
});

describe("trimmedMean", () => {
  test("drops the bottom and top 10% before averaging, as PGlite's rtt.js does", () => {
    // 10 values: slice(1, 9) keeps 2..9, whose mean is 5.5.
    expect(trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(5.5);
  });

  test("discards outliers regardless of arrival order", () => {
    const ordered = trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const shuffled = trimmedMean([7, 1, 10, 3, 9, 2, 8, 4, 6, 5]);
    expect(shuffled).toBe(ordered);
  });

  test("falls back to the plain mean when trimming would keep nothing", () => {
    // slice(floor(0.1), floor(0.9)) is empty for a single value, so the plain mean stands in.
    expect(trimmedMean([3])).toBe(3);
  });

  test("keeps PGlite's asymmetric slice for tiny samples", () => {
    // slice(floor(0.2), floor(1.8)) === slice(0, 1) keeps only the lower of two values.
    expect(trimmedMean([4, 8])).toBe(4);
  });

  test("honours a custom trim fraction", () => {
    // 10 values, 20% trimmed from each end: slice(2, 8) keeps 3..8, whose mean is 5.5.
    expect(trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.2)).toBe(5.5);
  });
});

describe("aggregateMeasurements", () => {
  test("uses the plain mean for the mean strategy", () => {
    expect(aggregateMeasurements(measurements([2, 4, 6]), "mean")).toBe(4);
  });

  test("uses the trimmed mean for the trimmed-mean strategy", () => {
    expect(aggregateMeasurements(measurements([1, 2, 3, 4, 5, 6, 7, 8, 9, 1000]), "trimmed-mean")).toBe(5.5);
  });

  test("a single-iteration Benchmark reports its one Measurement unchanged", () => {
    expect(aggregateMeasurements(measurements([0.123]), "mean")).toBe(0.123);
  });
});
