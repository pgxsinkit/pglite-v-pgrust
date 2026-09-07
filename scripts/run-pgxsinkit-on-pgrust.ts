/**
 * Run **pgxsinkit's own unit suite** against a pgrust backend.
 *
 * `bun run test:pgxsinkit-on-pgrust [files…]`
 *
 * The suite lives in the pgxsinkit checkout and stays there: this script only points its test-store
 * seam at `src/client/pgxsinkit-test-store-factory.ts` and runs it in place. Nothing is copied, and
 * pgxsinkit needs no knowledge of pgrust — the whole coupling is one environment variable holding an
 * absolute module path.
 *
 * **Where pgxsinkit is.** `PGXSINKIT_DIR`, or the first non-flag argument, or — by default —
 * `../../pgxsinkit/pgxsinkit` relative to this repo's root.
 *
 * **Which runner.** `scripts/run-unit-tests.ts`, pgxsinkit's raw sharder, and deliberately not its
 * `test:unit` entry point. `test:unit` is the *selection* layer: it skips files whose fingerprint is
 * already recorded green and, worse for this lane, RECORDS a green run in `test-registry.json`. A
 * pgrust pass is not a PGlite pass, so certifying files from here would let a later PGlite validate
 * skip tests that never ran on PGlite. The raw sharder writes no cache entry at all (its own header
 * says so), which is exactly what a foreign-engine experiment needs: every file runs, nothing is
 * certified, and pgxsinkit's cache is left untouched.
 *
 * **Concurrency.** The sharder pools `availableParallelism()/2` `bun test` processes. Each pgrust
 * store is a postmaster with a dozen worker threads rather than a WASM heap, so the pool is narrowed
 * here (`PGXSINKIT_TEST_CONCURRENCY`, honoured if already set) — the run is bounded by engine boots,
 * not by cores, and oversubscribing turns 1.4 s boots into timeouts.
 *
 * Extra arguments are unit-test file names (`local-store`, or `tests/unit/local-store.test.ts`),
 * passed through to the sharder; with none, the whole suite runs.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** This repo's root: the script lives in `<root>/scripts/`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The default sibling checkout, relative to this repo's root. */
const DEFAULT_PGXSINKIT_DIR = "../../pgxsinkit/pgxsinkit";

/** The module `PGXSINKIT_TEST_STORE_FACTORY` names — absolute, because pgxsinkit resolves it. */
const FACTORY_MODULE = path.join(REPO_ROOT, "src", "client", "pgxsinkit-test-store-factory.ts");

/** Shard processes, when the caller has not said. See the header. */
const DEFAULT_CONCURRENCY = "3";

function resolvePgxsinkitDir(args: readonly string[]): string {
  const explicit = process.env["PGXSINKIT_DIR"] ?? args[0];
  const candidate =
    explicit !== undefined && !explicit.startsWith("-") && explicit.includes("/") && !explicit.endsWith(".test.ts")
      ? explicit
      : DEFAULT_PGXSINKIT_DIR;
  return path.resolve(REPO_ROOT, candidate);
}

const argv = process.argv.slice(2);
const pgxsinkitDir = resolvePgxsinkitDir(argv);
// A path given as the first argument is consumed by the lookup above; everything else is a file name.
const files = argv.filter((arg) => path.resolve(REPO_ROOT, arg) !== pgxsinkitDir);

const runner = path.join(pgxsinkitDir, "scripts", "run-unit-tests.ts");
for (const [label, target] of [
  ["pgxsinkit checkout", pgxsinkitDir],
  ["its unit runner", runner],
  ["the store factory", FACTORY_MODULE],
] as const) {
  if (!existsSync(target)) {
    process.stderr.write(`run-pgxsinkit-on-pgrust: ${label} not found at ${target}\n`);
    process.exit(2);
  }
}

process.stdout.write(`[pgrust] pgxsinkit: ${pgxsinkitDir}\n`);
process.stdout.write(`[pgrust] factory:   ${FACTORY_MODULE}\n`);
process.stdout.write(`[pgrust] files:     ${files.length === 0 ? "(all)" : files.join(", ")}\n`);

const startedAt = Date.now();
const child = spawn("bun", ["scripts/run-unit-tests.ts", ...files], {
  cwd: pgxsinkitDir,
  stdio: "inherit",
  env: {
    ...process.env,
    PGXSINKIT_TEST_STORE_FACTORY: FACTORY_MODULE,
    PGXSINKIT_TEST_CONCURRENCY: process.env["PGXSINKIT_TEST_CONCURRENCY"] ?? DEFAULT_CONCURRENCY,
  },
});

child.on("close", (code) => {
  process.stdout.write(`[pgrust] finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (exit ${code ?? 1})\n`);
  process.exit(code ?? 1);
});
