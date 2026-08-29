// Based on wa-sqlite's benchmarks.
// Copyright 2021 Roy T. Hashimoto. All Rights Reserved.
// Modified by the PGLite authors.
// Ported by pglite-v-pgrust.

/**
 * The Speedtest Suite's SQL, imported byte-identically from the copies in this directory.
 *
 * Kept in its own module: `?raw` is a bundler feature, so nothing that runs under `bun test` imports
 * this file. `speedtest.test.ts` reads the same `.sql` files from disk instead.
 */

import benchmark1 from "./benchmark1.sql?raw";
import benchmark21 from "./benchmark2.1.sql?raw";
import benchmark2 from "./benchmark2.sql?raw";
import benchmark31 from "./benchmark3.1.sql?raw";
import benchmark3 from "./benchmark3.sql?raw";
import benchmark4 from "./benchmark4.sql?raw";
import benchmark5 from "./benchmark5.sql?raw";
import benchmark6 from "./benchmark6.sql?raw";
import benchmark7 from "./benchmark7.sql?raw";
import benchmark8 from "./benchmark8.sql?raw";
import benchmark9 from "./benchmark9.sql?raw";
import benchmark10 from "./benchmark10.sql?raw";
import benchmark11 from "./benchmark11.sql?raw";
import benchmark12 from "./benchmark12.sql?raw";
import benchmark13 from "./benchmark13.sql?raw";
import benchmark14 from "./benchmark14.sql?raw";
import benchmark15 from "./benchmark15.sql?raw";
import benchmark16 from "./benchmark16.sql?raw";
import type { SpeedtestBenchmarkId } from "./benchmarks";

export const SPEEDTEST_SQL: Readonly<Record<SpeedtestBenchmarkId, string>> = {
  "1": benchmark1,
  "2": benchmark2,
  "2.1": benchmark21,
  "3": benchmark3,
  "3.1": benchmark31,
  "4": benchmark4,
  "5": benchmark5,
  "6": benchmark6,
  "7": benchmark7,
  "8": benchmark8,
  "9": benchmark9,
  "10": benchmark10,
  "11": benchmark11,
  "12": benchmark12,
  "13": benchmark13,
  "14": benchmark14,
  "15": benchmark15,
  "16": benchmark16,
};
