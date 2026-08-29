/**
 * The RTT Suite is 100 iterations by definition (CONTEXT.md), and 100 is the only value the UI ever
 * offers. A reduced count exists solely so an automated lane can finish quickly, so it arrives out
 * of band — a `?rttIterations=N` query on the page URL — and it is never silent: the environment
 * header and every Markdown export announce it, so a shortened Run cannot be mistaken for a real one.
 */

import type { Suite } from "./suites/types";

/** The query parameter that reduces the RTT Suite's iterations. */
export const RTT_ITERATIONS_PARAM = "rttIterations";

export const MIN_RTT_ITERATIONS = 1;
export const MAX_RTT_ITERATIONS = 1000;

/**
 * The override carried by a `location.search` string, or null when there is none.
 *
 * Anything that is not an integer in [1, 1000] is ignored rather than thrown: a mistyped URL must
 * leave the page running the standard Suite, not blank it.
 */
export function parseRttIterations(search: string): number | null {
  const raw = new URLSearchParams(search).get(RTT_ITERATIONS_PARAM);
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number.parseInt(trimmed, 10);
  if (value < MIN_RTT_ITERATIONS || value > MAX_RTT_ITERATIONS) {
    return null;
  }
  return value;
}

/** The override on the current URL; null wherever there is no `location` (under `bun test`). */
export function readRttIterationsOverride(): number | null {
  if (typeof location === "undefined") {
    return null;
  }
  return parseRttIterations(location.search);
}

/** How a non-standard iteration count is announced wherever the environment is reported. */
export function describeRttIterations(iterations: number): string {
  return `RTT iterations: ${iterations} (non-standard)`;
}

/**
 * The Suite a Run actually executes: the RTT Suite with its iteration count replaced, or the Suite
 * exactly as defined. Only the RTT Suite is affected — the Speedtest Suite times each script once.
 */
export function applyRttIterations(suite: Suite, override: number | null): Suite {
  if (override === null || suite.id !== "rtt" || override === suite.iterations) {
    return suite;
  }
  return { ...suite, iterations: override };
}
