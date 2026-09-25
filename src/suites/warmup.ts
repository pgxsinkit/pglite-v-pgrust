/**
 * The **Warm-up** (see CONTEXT.md): one fixed SQL script every Engine runs once after it boots and
 * before a Suite's first Benchmark, timed exactly as a Benchmark is and reported as its own line
 * above the Suite's rows — never as one of them, and never in a Suite total.
 *
 * It exists because the first Benchmark of a Suite used to pay the Engine's first-use costs: the
 * browser compiling each wasm function at its first call, the catalog and relation caches filling.
 * On the Speedtest that put pgrust's row 1 at about 4x PGlite cold against about 1.6x warm
 * (`docs/results/2026-09-25-per-statement-profile.md` §8). Those costs are still paid, by every
 * Engine, and still reported; they are just no longer billed to a Benchmark.
 *
 * The script is one file, `warmup.sql` beside this module, shared by all four Suites and
 * byte-identical for every Engine; it is sent as one query text, the way a Speedtest script is, and
 * a Configuration's SQL rewrite reaches it as it reaches everything else a Run executes. Its SQL is
 * imported with `?raw` in `./warmup-sql.ts`, which only the bundle loads; this module holds what
 * `bun test` can load too.
 */

/** The file the Warm-up's SQL is read from, relative to this directory. */
export const WARMUP_SCRIPT_NAME = "warmup.sql";

/**
 * The Warm-up line's label, in the page and in the Markdown export.
 *
 * It must never start with `Test`: every total this repo's notes and scratch scripts take from a
 * pasted table is a sum over its `| Test` rows, and this label keeps the Warm-up out of all of them
 * by construction.
 */
export const WARMUP_LABEL = "Warm-up";

/**
 * The line the Markdown export carries above a table that has a Warm-up, so an export from a Run
 * with one can be told from an older export without one.
 */
export const WARMUP_EXPORT_LINE =
  `Warm-up: ${WARMUP_SCRIPT_NAME}, timed once per Run after the Engine opens and before the Suite's ` +
  "untimed setup; its row is not part of any Suite total";
