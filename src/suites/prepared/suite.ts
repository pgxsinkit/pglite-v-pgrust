// Based on wa-sqlite's benchmarks.
// Copyright 2021 Roy T. Hashimoto. All Rights Reserved.
// Modified by the PGLite authors.
// Ported by pglite-v-pgrust.

/**
 * The Prepared Suite, built from its timed texts: separate from `index.ts` so a test can build it
 * from the `.sql` files on disk, which `bun test` can read and a `?raw` import it cannot.
 */

import type { EngineId } from "../../engines/contract";
import { engineDialect } from "../../engines/contract";
import type { StatementBenchmark, Suite } from "../types";
import type { PreparedBenchmarkId } from "./benchmarks";
import {
  PREPARED_BENCHMARK_IDS,
  PREPARED_BENCHMARK_LABELS,
  PREPARED_SQLITE_NOTE,
  PREPARED_SQLITE_REASON,
  preparedSetupTexts,
  preparedTeardownTexts,
} from "./benchmarks";

export function buildPreparedBenchmarks(
  sql: Readonly<Record<PreparedBenchmarkId, string>>,
): readonly StatementBenchmark[] {
  return PREPARED_BENCHMARK_IDS.map((id) => ({
    id,
    label: PREPARED_BENCHMARK_LABELS[id],
    sql: sql[id],
    setup: preparedSetupTexts(id),
    teardown: preparedTeardownTexts(id),
  }));
}

export function buildPreparedSuite(sql: Readonly<Record<PreparedBenchmarkId, string>>): Suite {
  return {
    id: "prepared",
    title: "Prepared Suite",
    description:
      "The Speedtest's seven statement-heavy scripts (rows 1, 2, 3, 7, 8, 9 and 10), each sent as one " +
      "PREPARE of its statement's shape, untimed, followed by the script's statements as EXECUTEs with the " +
      "Speedtest's own values in one timed text, so each row measures a reused plan. The tables each row " +
      "needs are built untimed before it. One timing per row. Postgres Engines only.",
    benchmarks: buildPreparedBenchmarks(sql),
    // Every row builds what it needs in its own untimed setup; the Suite has nothing to add before them.
    initialSetupFor: () => "",
    editableSetup: false,
    iterations: 1,
    aggregation: "mean",
    columnNoteFor: (engine: EngineId) => (engineDialect(engine) === "sqlite" ? PREPARED_SQLITE_NOTE : undefined),
    unsupportedReasonFor: (dialect) => (dialect === "sqlite" ? PREPARED_SQLITE_REASON : undefined),
  };
}
