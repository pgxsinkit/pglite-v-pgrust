/**
 * The Warm-up's SQL, imported byte-identically from `warmup.sql` (see `./warmup.ts`).
 *
 * Kept in its own module for the same reason as the Speedtest's `sql.ts`: `?raw` is a bundler
 * feature, so nothing that runs under `bun test` imports this file. The tests read `warmup.sql`
 * from disk instead.
 */

import warmupSql from "./warmup.sql?raw";

export const WARMUP_SQL: string = warmupSql;
