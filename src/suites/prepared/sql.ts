// Based on wa-sqlite's benchmarks.
// Copyright 2021 Roy T. Hashimoto. All Rights Reserved.
// Modified by the PGLite authors.
// Ported by pglite-v-pgrust.

/**
 * The Prepared Suite's timed texts, imported byte-identically from the `prepared<N>.sql` files in
 * this directory (generated from the Speedtest's own scripts; see `benchmarks.ts`).
 *
 * Kept in its own module for the same reason as the Speedtest's `sql.ts`: `?raw` is a bundler
 * feature, so nothing that runs under `bun test` imports this file. `prepared.test.ts` reads the same
 * `.sql` files from disk instead.
 */

import type { PreparedBenchmarkId } from "./benchmarks";
import prepared1 from "./prepared1.sql?raw";
import prepared2 from "./prepared2.sql?raw";
import prepared3 from "./prepared3.sql?raw";
import prepared7 from "./prepared7.sql?raw";
import prepared8 from "./prepared8.sql?raw";
import prepared9 from "./prepared9.sql?raw";
import prepared10 from "./prepared10.sql?raw";

export const PREPARED_SQL: Readonly<Record<PreparedBenchmarkId, string>> = {
  "1": prepared1,
  "2": prepared2,
  "3": prepared3,
  "7": prepared7,
  "8": prepared8,
  "9": prepared9,
  "10": prepared10,
};
