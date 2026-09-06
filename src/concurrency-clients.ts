/**
 * The Concurrency Suite runs four Clients (`CONCURRENCY_CLIENTS`), and that is the number every
 * committed run reports. A different count exists for the same reason a shortened RTT Run does: so
 * an automated lane, or somebody looking at what a fifth backend costs, can ask for one — and it
 * arrives the same way, out of band as a `?concurrencyClients=N` query on the page URL, and is never
 * silent. The environment header and every Markdown export say so, so a Run with a different Client
 * count cannot be mistaken for a standard one.
 *
 * Changing the count rebuilds the Suite rather than editing it: the Clients, their key sequences and
 * their key ranges are all functions of N.
 */

import { buildConcurrencySuite, CONCURRENCY_CLIENTS } from "./suites/concurrency";
import type { Suite } from "./suites/types";

/** The query parameter that changes how many Clients the Concurrency Suite runs. */
export const CONCURRENCY_CLIENTS_PARAM = "concurrencyClients";

/**
 * The fewest Clients a Run may ask for.
 *
 * Two, not one: two of the five Benchmarks are one Client doing something while the others watch,
 * and with a single Client there would be nobody to watch — the row would report a percentile of an
 * empty sample set rather than a fast column.
 */
export const MIN_CONCURRENCY_CLIENTS = 2;

/**
 * The most Clients a Run may ask for.
 *
 * Eight is the postmaster Engine's own ceiling on Sessions (every ring is created before the guest
 * starts), so a larger number could only be honoured by the Engine that needs it least.
 */
export const MAX_CONCURRENCY_CLIENTS = 8;

/**
 * The override carried by a `location.search` string, or null when there is none.
 *
 * Anything that is not an integer in range is ignored rather than thrown: a mistyped URL must leave
 * the page running the standard Suite, not blank it.
 */
export function parseConcurrencyClients(search: string): number | null {
  const raw = new URLSearchParams(search).get(CONCURRENCY_CLIENTS_PARAM);
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number.parseInt(trimmed, 10);
  if (value < MIN_CONCURRENCY_CLIENTS || value > MAX_CONCURRENCY_CLIENTS) {
    return null;
  }
  return value;
}

/** The override on the current URL; null wherever there is no `location` (under `bun test`). */
export function readConcurrencyClientsOverride(): number | null {
  if (typeof location === "undefined") {
    return null;
  }
  return parseConcurrencyClients(location.search);
}

/** How a non-standard Client count is announced wherever the environment is reported. */
export function describeConcurrencyClientsOverride(clients: number): string {
  return `Concurrency clients: ${clients} (non-standard)`;
}

/**
 * The Suite a Run actually executes: the Concurrency Suite rebuilt for another Client count, or the
 * Suite exactly as defined. Only the Concurrency Suite is affected.
 */
export function applyConcurrencyClients(suite: Suite, override: number | null): Suite {
  if (override === null || suite.id !== "concurrency" || override === CONCURRENCY_CLIENTS) {
    return suite;
  }
  return buildConcurrencySuite(override, false);
}
