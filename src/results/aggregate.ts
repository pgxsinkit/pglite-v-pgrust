/**
 * Collapsing the per-iteration Measurements of one Benchmark to the number in its cell.
 *
 * `trimmed-mean` reproduces PGlite's `rtt.js`: sort, drop the bottom and top 10%, mean the rest.
 */

import type { Measurement } from "../engines/contract";
import type { AggregationStrategy } from "../suites/types";

/** Fraction dropped from each end by `trimmed-mean`, matching PGlite's `rtt.js`. */
export const TRIM_FRACTION = 0.1;

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot take the mean of zero Measurements");
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/**
 * Sort, drop `trimFraction` of the values from each end, then take the mean. Falls back to the plain
 * mean when trimming would leave nothing behind.
 */
export function trimmedMean(values: readonly number[], trimFraction: number = TRIM_FRACTION): number {
  if (values.length === 0) {
    throw new Error("Cannot take the mean of zero Measurements");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const kept = sorted.slice(Math.floor(sorted.length * trimFraction), Math.floor(sorted.length * (1 - trimFraction)));
  return kept.length === 0 ? mean(sorted) : mean(kept);
}

export function aggregateMeasurements(measurements: readonly Measurement[], strategy: AggregationStrategy): number {
  const values = measurements.map((measurement) => measurement.elapsedMs);
  return strategy === "trimmed-mean" ? trimmedMean(values) : mean(values);
}
