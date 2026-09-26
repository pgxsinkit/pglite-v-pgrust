/**
 * The Engine workers' half of `?brokerStats=1`: one snapshot of the store counters before a
 * Measurement and one after, differenced into the Measurement's `storeStats`.
 *
 * Both snapshots are taken OUTSIDE the Measurement window — before the worker starts its clock and
 * after it has stopped it — so the counting shows up in a Measurement only as what the counters
 * themselves cost inside the store calls, never as a copy of the counters.
 */

import type { StoreStats, StoreStatsParts } from "../results/store-stats";
import { storeStatsFromDescription } from "../results/store-stats";
import type { IoStats } from "../vendor/pgrust/io-stats.js";
import { describeIoStats } from "../vendor/pgrust/io-stats.js";

export class StoreStatsProbe {
  readonly #stats: IoStats;
  readonly #parts: StoreStatsParts;

  constructor(stats: IoStats, parts: StoreStatsParts) {
    this.#stats = stats;
    this.#parts = parts;
  }

  /** Run `work`, and say what the store did while it ran. */
  async around<T>(work: () => Promise<T>): Promise<{ readonly value: T; readonly storeStats: StoreStats }> {
    const before = this.#stats.snapshot();
    const value = await work();
    const after = this.#stats.snapshot();
    return { value, storeStats: storeStatsFromDescription(describeIoStats(before, after), this.#parts) };
  }
}

/** Run `work` under `probe` when there is one; without one, exactly `work`. */
export async function aroundStoreStats<T>(
  probe: StoreStatsProbe | null,
  work: () => Promise<T>,
): Promise<{ readonly value: T; readonly storeStats?: StoreStats }> {
  return probe === null ? { value: await work() } : await probe.around(work);
}
