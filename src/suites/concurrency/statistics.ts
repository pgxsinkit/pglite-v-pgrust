/**
 * Reducing a Scenario's samples to the numbers a Concurrency row reports.
 *
 * Pure arithmetic over latencies the Engine's worker already measured: nothing here is a
 * Measurement, and nothing here runs inside one. It lives beside the Suite because the Suite is what
 * decides that this row's headline is a p95 and that one's is a rate.
 */

import type { ScenarioClientReport, ScenarioReport } from "../../engines/scenario";

/** Every latency of every Client in `clients`, in one array. */
export function latenciesOf(clients: readonly ScenarioClientReport[]): readonly number[] {
  return clients.flatMap((client) => client.samples.map((sample) => sample.elapsedMs));
}

/**
 * The `fraction` percentile by nearest rank, over a copy of `values`.
 *
 * Nearest rank rather than an interpolated percentile because a Client under a bulk write may
 * contribute a handful of samples, and interpolating between two of five real latencies invents a
 * number that nothing measured. An empty set has no percentile and says so with `NaN`, which the
 * table renders as its empty cell rather than as a zero.
 */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

export function maximum(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : Math.max(...values);
}

/** Every Client except the ones named: the readers beside a writer, the short queries beside a long one. */
export function clientsExcept(report: ScenarioReport, excluded: readonly number[]): readonly ScenarioClientReport[] {
  return report.clients.filter((client) => !excluded.includes(client.client));
}

export function clientAt(report: ScenarioReport, index: number): ScenarioClientReport | undefined {
  return report.clients.find((client) => client.client === index);
}

/** How many units every Client ran, added up. */
export function totalSamples(clients: readonly ScenarioClientReport[]): number {
  return clients.reduce((total, client) => total + client.samples.length, 0);
}

/** Units per second over the Scenario's own wall time; the rate a row that reports throughput uses. */
export function statementsPerSecond(count: number, wallMs: number): number {
  return wallMs <= 0 ? Number.NaN : (count * 1000) / wallMs;
}

/** How many units failed with `sqlstate`, across every Client. */
export function sqlstateCount(clients: readonly ScenarioClientReport[], sqlstate: string): number {
  return clients.reduce((total, client) => total + (client.sqlstates[sqlstate] ?? 0), 0);
}

/** `p50 / p95 / max`, the three numbers a per-Client Detail line carries. */
export function describeSpread(values: readonly number[]): string {
  const render = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : "–");
  return `${render(percentile(values, 0.5))} / ${render(percentile(values, 0.95))} / ${render(maximum(values))}`;
}
