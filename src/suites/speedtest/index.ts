// Based on wa-sqlite's benchmarks.
// Copyright 2021 Roy T. Hashimoto. All Rights Reserved.
// Modified by the PGLite authors.
// Ported by pglite-v-pgrust.

import type { Suite } from "../types";
import { SPEEDTEST_BENCHMARK_IDS, SPEEDTEST_BENCHMARK_LABELS, SPEEDTEST_DEFAULT_PREAMBLE } from "./benchmarks";
import { SPEEDTEST_SQL } from "./sql";

/** The 16 SQL scripts ported from the SQLite speedtest via wa-sqlite and PGlite. One timing each. */
export const SPEEDTEST_SUITE: Suite = {
  id: "speedtest",
  title: "Speedtest Suite",
  description:
    "The 16 SQL scripts ported from the SQLite speed test via wa-sqlite and PGlite, byte-identical to PGlite's copies. One timing per script.",
  benchmarks: SPEEDTEST_BENCHMARK_IDS.map((id) => ({
    id,
    label: SPEEDTEST_BENCHMARK_LABELS[id],
    sql: SPEEDTEST_SQL[id],
  })),
  defaultSetupSql: SPEEDTEST_DEFAULT_PREAMBLE,
  editableSetup: true,
  iterations: 1,
  aggregation: "mean",
};
