/** Cell, ratio and Detail rendering. Times are milliseconds throughout. */

import type { MeasurementDetail } from "../engines/contract";

/** Placeholder shown wherever there is no number to show. */
export const EMPTY_CELL = "–";

/** Multiplication sign used by the ratio column, e.g. `0.62×`. */
const RATIO_SUFFIX = "×";

export function formatMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return EMPTY_CELL;
  }
  return value.toFixed(3);
}

/**
 * A Configuration's value relative to the baseline Configuration, e.g. `0.62x`. Below 1 means faster
 * than the baseline.
 */
/**
 * One Detail value.
 *
 * A count is a count (`812`, not `812.000`), a measured number keeps three decimals like every other
 * time in the table, and a string — a per-Client `p50 / p95 / max` line — is already formatted.
 */
export function formatDetailValue(value: number | string): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Number.isFinite(value)) {
    return EMPTY_CELL;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/** A whole Detail, on one line: `key = value; key = value`, in the order the Suite put them in. */
export function formatDetail(detail: MeasurementDetail): string {
  return Object.entries(detail)
    .map(([key, value]) => `${key} = ${formatDetailValue(value)}`)
    .join("; ");
}

export function formatRatio(value: number | undefined, baseline: number | undefined): string {
  if (value === undefined || baseline === undefined) {
    return EMPTY_CELL;
  }
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) {
    return EMPTY_CELL;
  }
  return `${(value / baseline).toFixed(2)}${RATIO_SUFFIX}`;
}
