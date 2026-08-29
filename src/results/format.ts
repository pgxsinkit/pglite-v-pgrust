/** Cell and ratio rendering. Times are milliseconds throughout. */

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
export function formatRatio(value: number | undefined, baseline: number | undefined): string {
  if (value === undefined || baseline === undefined) {
    return EMPTY_CELL;
  }
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) {
    return EMPTY_CELL;
  }
  return `${(value / baseline).toFixed(2)}${RATIO_SUFFIX}`;
}
