/** Suite, Benchmark and aggregation vocabulary (see CONTEXT.md). */

import type { SqlDialect } from "../engines/contract";

/** How the per-iteration Measurements of one Benchmark collapse to the number in the cell. */
export type AggregationStrategy = "mean" | "trimmed-mean";

/** One timed unit within a Suite: a Speedtest script, or one RTT statement. One row of the table. */
export interface Benchmark {
  readonly id: string;
  readonly label: string;
  readonly sql: string;
}

export type SuiteId = "speedtest" | "rtt";

/** A named, fixed list of Benchmarks run in order against one Engine. */
export interface Suite {
  readonly id: SuiteId;
  readonly title: string;
  readonly description: string;
  readonly benchmarks: readonly Benchmark[];
  /**
   * SQL run untimed on a freshly opened Engine, before the first Benchmark.
   *
   * The Benchmarks themselves are dialect-neutral and are run byte-identically against every
   * Engine; only this setup has to be spelled differently for a SQLite Engine, so it is the one
   * place a dialect is asked for.
   */
  initialSetupFor(dialect: SqlDialect): string;
  /** Whether the UI offers the setup SQL as an editable preamble. */
  readonly editableSetup: boolean;
  /** How many times each Benchmark is executed per Run. */
  readonly iterations: number;
  readonly aggregation: AggregationStrategy;
}
