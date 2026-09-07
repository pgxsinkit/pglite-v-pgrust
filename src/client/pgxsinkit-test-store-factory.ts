/**
 * The pgrust side of pgxsinkit's **test store seam** — its own unit suite, on this engine.
 *
 * pgxsinkit's `tests/support/pglite.ts` builds every store its unit suite uses. Since the seam went
 * in, it will hand that job to a module named by `PGXSINKIT_TEST_STORE_FACTORY` instead, over an
 * engine-agnostic contract:
 *
 *   - `createFresh(options?)` — a fresh, empty store on the factory's OWN seed image, honouring what
 *     it can of the PGlite create options (`extensions` above all);
 *   - `createFromDump(dump, options?)` — a store booted on a datadir dump THIS factory produced;
 *   - `cacheKeyPrefix` — the filename prefix pgxsinkit gives its schema-snapshot disk cache;
 *   - `cacheIdentity` — extra fingerprint material, so an engine bump invalidates its own snapshots;
 *   - `closeAll()` — teardown of anything the factory still owns.
 *
 * This module is that contract answered by {@link createPgrustPglite} on the memory backend. Run it
 * with `bun run test:pgxsinkit-on-pgrust`.
 *
 * **Three things the contract's shape forces, and why each is what it is.**
 *
 * 1. *No top-level await, anywhere reachable from the module's static graph.* pgxsinkit loads a
 *    factory with `require`, not `import()`, because a computed `import()` in its test-support file
 *    would make every test that imports it ungraphable to its unit-test selector — permanently
 *    uncacheable. `require` of an async module throws, and the pgrust host's graph IS async, so this
 *    file statically imports **types only** and reaches the engine through a dynamic `import()` in
 *    {@link engineModule}. That is one lazy import for the whole suite, not one per store.
 * 2. *A pgrust store never boots a PGlite datadir, and the reverse fails too* — `ReadControlFile`
 *    compares `USE_FLOAT8_BYVAL`, and PGlite is a 32-bit build with a 4-byte Datum where pgrust has
 *    an 8-byte one (`docs/results/2026-09-07-datadir-portability.md`). So `createFresh` does NOT and
 *    cannot use pgxsinkit's `@electric-sql/pglite-prepopulatedfs` base: a pgrust store boots from
 *    pgrust's own packed image. The same fact is why {@link cacheKeyPrefix} must be distinct — a
 *    schema snapshot is engine-private, and the two lanes' tarballs must never meet on one filename.
 * 3. *Every instance is a whole engine* — a postmaster and its worker threads, not a WASM heap in
 *    the caller's process. A leaked one does not slow the run down, it stops the process exiting.
 *    Hence the {@link live} registry below: `close()` deregisters, {@link closeAll} takes down
 *    whatever pgxsinkit lost track of.
 *
 * Everything else is pgxsinkit's own semantics, unchanged: relaxed durability unless the caller's
 * options say otherwise, extensions passed through, and the store URL (`memory://…`) reported as
 * `dataDir` so the client's non-persistent-store guard sees the true answer and the suite's existing
 * acknowledgment covers it.
 */

import type { Extensions, PGliteOptions } from "@electric-sql/pglite";

import type * as PgrustFactoryModule from "./pgrust-factory";
import type { CreatePgrustPgliteOptions, PgrustClientPGlite } from "./pgrust-factory";

/** The pgrust build this factory runs, as `src/vendor/pgrust/VERSION` records it. */
const PGRUST_VERSION = "9bab6bff11";

/**
 * pgxsinkit's schema-snapshot cache filename prefix for THIS lane.
 *
 * Distinct from its default `pgxsinkit-schema-` because the two engines' dumps are mutually
 * unbootable; sharing a prefix would mean each lane deleting and rebuilding the other's snapshots at
 * best, and probing an unbootable tar at worst.
 */
export const cacheKeyPrefix = "pgxsinkit-pgrust-schema-";

/** Folded into the cache key, so a vendored-host bump invalidates this lane's snapshots by itself. */
export const cacheIdentity = `pgrust@${PGRUST_VERSION}`;

/** Where the server's stderr goes when `PGXSINKIT_PGRUST_SERVER_LOG=1`; nowhere otherwise. */
const SERVER_LOG_ENABLED = process.env["PGXSINKIT_PGRUST_SERVER_LOG"] === "1";

/**
 * Every store handed out and not yet closed.
 *
 * `close()` is wrapped on the way out so an instance deregisters itself: the registry holds OPEN
 * engines only, and never keeps a closed one's shared memory alive.
 */
const live = new Set<PgrustClientPGlite>();

/** One store path per instance in this process — the memory port, so nothing outlives the engine. */
let storeSequence = 0;

/**
 * The engine module, imported once and lazily.
 *
 * Lazy because of the `require` rule in the header: this module must be loadable synchronously, and
 * `./pgrust-factory` reaches an async graph (the vendored wasi host). The promise is memoized, so the
 * cost lands on the first store of a process and never again.
 */
let engineModulePromise: Promise<typeof PgrustFactoryModule> | undefined;

async function engineModule(): Promise<typeof PgrustFactoryModule> {
  engineModulePromise ??= import("./pgrust-factory");
  return await engineModulePromise;
}

/**
 * pgxsinkit's create options, as this engine's.
 *
 * `relaxedDurability` is PGlite's own name for the choice and the only durability signal the suite
 * ever sends; absent, the lane is relaxed — the same default pgxsinkit's own helpers run under.
 * `extensions` is passed through verbatim (`live` when a test asks for it). Options with no meaning
 * on a pgrust store — `dataDir`, `fs`, `wasmModule`, `debug` — are deliberately dropped rather than
 * half-honoured.
 */
function engineOptions(options: PGliteOptions | undefined): CreatePgrustPgliteOptions<Extensions> {
  const extensions = options?.extensions;
  return {
    durability: options?.relaxedDurability === false ? "strict" : "relaxed",
    ...(extensions ? { extensions } : {}),
    applicationName: "pgxsinkit-unit-suite",
    ...(SERVER_LOG_ENABLED
      ? {
          onServerLog: (text: string) => {
            process.stderr.write(text);
          },
        }
      : {}),
  };
}

/** Register an instance and make its own `close()` the deregistration. */
function track(instance: PgrustClientPGlite): PgrustClientPGlite {
  live.add(instance);
  const close = instance.close.bind(instance);
  // An own property shadowing the prototype method: every caller's `close()`, whichever one it is,
  // goes through this.
  (instance as { close: () => Promise<void> }).close = async () => {
    try {
      await close();
    } finally {
      live.delete(instance);
    }
  };
  return instance;
}

/**
 * A fresh, empty store — pgrust's own packed image, one engine, one session.
 *
 * `loadDataDir` in the caller's options is ignored on purpose: pgxsinkit's default path overrides it
 * with its base image here too, and a restore has its own entry point below.
 */
export async function createFresh(options?: PGliteOptions): Promise<PgrustClientPGlite> {
  const { createPgrustPglite } = await engineModule();
  storeSequence += 1;
  const path = `memory://pgxsinkit-unit-${process.pid}-${storeSequence}`;
  return track(await createPgrustPglite(path, engineOptions(options)));
}

/**
 * A store booted ON a dump this factory produced: the datadir is emptied and the tarball's entries
 * written in its place before the postmaster starts.
 */
export async function createFromDump(dump: Blob | File, options?: PGliteOptions): Promise<PgrustClientPGlite> {
  const { createPgrustPglite } = await engineModule();
  storeSequence += 1;
  const path = `memory://pgxsinkit-unit-${process.pid}-${storeSequence}`;
  return track(await createPgrustPglite(path, { ...engineOptions(options), loadDataDir: dump }));
}

/**
 * Close every engine still open — idempotent, and never throwing.
 *
 * pgxsinkit closes each instance it tracks; this is the backstop for one it never saw (a create that
 * succeeded inside a test that then failed). Sequential rather than parallel: each shutdown is a
 * postmaster writing its checkpoint, and a stampede of them is what makes a teardown time out.
 */
export async function closeAll(): Promise<void> {
  for (const instance of [...live]) {
    live.delete(instance);
    try {
      await instance.close();
    } catch {
      // Best-effort teardown: a store that will not close must not fail the file that ran green.
    }
  }
}
