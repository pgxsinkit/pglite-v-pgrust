/**
 * The claim, one step past the live scenario: **pgxsinkit's STORE contract is answered by pgrust**,
 * not just its query path.
 *
 * `bun run scenario:pgxsinkit-factory`
 *
 * `scripts/pgxsinkit-live-scenario.ts` proved a `@pgxsinkit/client` runs against a pgrust backend.
 * It did so on a hand-built session and a client that could not dump its datadir, could not be
 * restored from one, and had no `strictSync()` — three of the six things pgxsinkit's own store seam
 * (`createPglite`) hands back. This scenario runs the seam itself, `src/client/pgrust-factory.ts`,
 * end to end on the memory backend:
 *
 *  a. `createPgrustPglite("memory://factory-a", { durability: "strict", extensions: { live } })` —
 *     one call, no engine wiring; `SHOW synchronous_commit` and `SHOW fsync` must say `on`, which
 *     is what the strict mode means here, the engine's own store settings must be in place
 *     (`wal_init_zero` `off`, `wal_buffers` `4MB`), and `strictSync()` — the broker's store-wide
 *     sync, which the commitment barrier calls — must resolve;
 *  b. that instance is handed to `createSyncClient({ precreatedPglite, … })` exactly as the live
 *     scenario hands its own, and rows are written through the client;
 *  d. `dumpDataDir()` — a `CHECKPOINT` and then the whole datadir read out over the host's broker
 *     channel — produces a tarball in PGlite's own layout: entries named relative to the datadir
 *     root with a leading `/`, and no `pgdata/` prefix wrapping them;
 *  c. `client.stop()` calls `pglite.close()`, and close here means the WHOLE engine: the assertion
 *     is that the postmaster exited 0 with its shutdown checkpoint written, inside the deadline;
 *  e. a SECOND store is created from that tarball —
 *     `createPgrustPglite("memory://factory-b", { durability: "relaxed", loadDataDir })` — which
 *     must report `synchronous_commit` and `fsync` `off`, the same two store settings as (a), and
 *     must hold the rows written in (b);
 *  f. its own `close()` shuts down as cleanly as the first.
 *
 * Then the question the shared tar FORMAT raises on its own: is the DATADIR portable too? Both
 * engines are PostgreSQL 18.3 — same `CATALOG_VERSION_NO` (202506291), same `PG_CONTROL_VERSION`
 * (1800) — and pgrust's own `GOAL.md` claims a C 18.3 binary can boot its data directory. So this
 * scenario tests it in both directions rather than assuming either answer:
 *
 *  h. a plain in-memory `PGlite` writes rows and dumps its datadir; `createPgrustPglite` boots ON
 *     that tarball and must find the rows, with `version()` naming pgrust;
 *  i. the reverse — the pgrust tarball from (d) handed to `PGlite.create({ loadDataDir })`, which
 *     must find the rows pgxsinkit's client wrote in (b).
 *
 * The answer, measured here and written up in `docs/results/2026-09-07-datadir-portability.md`, is
 * NO in both directions and for one reason: `ReadControlFile` compares the cluster's `float8ByVal`
 * against the server's own `USE_FLOAT8_BYVAL`, and PGlite is a 32-bit emscripten build (4-byte
 * Datum) where pgrust has an 8-byte one. Same 18.3, same catalog version, same control version, two
 * physically incompatible clusters. So this lane passes by REPRODUCING that refusal, in both
 * directions, with the server's own words — and fails if either direction ever does anything else,
 * because a changed answer is news and the note would then be out of date.
 *
 * Sync is off, as in the live scenario: the store seam is the subject, not the network one.
 *
 * Exit 0 on `VERDICT: pgxsinkit-factory PASS` plus `VERDICT: datadir-portability
 * REFUSED-AS-RECORDED`, exit 1 with the reason otherwise.
 */

import { PGlite } from "@electric-sql/pglite";
import { live } from "@electric-sql/pglite/live";
import { createSyncClient, type ClientPGlite, type SyncClient } from "@pgxsinkit/client";
import { testStoreAcknowledgment } from "@pgxsinkit/client/testing";
import type { SyncTableRegistry } from "@pgxsinkit/contracts";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { untar } from "tinytar";

import { createPgrustPglite, type PgrustClientPGlite } from "../src/client/pgrust-factory";

/** The rows written through the client in (b), and counted again in (e) after the restore. */
const NOTES: readonly { readonly id: string; readonly title: string }[] = [
  { id: "9f3a1c62-0d4b-4f9e-8a71-2c5d6e7f8a90", title: "the store, not just the query" },
  { id: "1c0e5b7d-3a62-4c18-9f4e-70b2d5a6c381", title: "dumped over the broker channel" },
  { id: "b47c9e21-58d0-4a3f-8e6b-19c4f2a7d503", title: "restored before the postmaster booted" },
];

/** The table (h) writes on the PGlite side and reads back on the pgrust one. */
const PORTABLE_ROWS = 5;

/** A one-table registry: the smallest thing `createSyncClient` will provision and read. */
const noteTable = pgTable("note", { id: uuid("id").primaryKey(), title: text("title") });

function noteRegistry(): SyncTableRegistry {
  return {
    note: {
      table: noteTable,
      mode: "readonly",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "note", shapeKey: "schema.note" },
      clientProjection: { syncedTable: "note" },
    },
  } as unknown as SyncTableRegistry;
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/** The message alone: a portability refusal is a RESULT, and its stack is this script's, not news. */
function describeShort(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The last few non-empty lines of a server log, which is where a FATAL and its DETAIL are. */
function tail(text: string, lines = 12): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(-lines);
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function ms(value: number): string {
  return `${value.toFixed(0)} ms`;
}

/** Gunzip, so the tarball can be read back the way PGlite's `loadTar` reads one. */
async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const written = writer.write(bytes).then(async () => await writer.close());
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value !== undefined) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  await written;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** `SHOW <name>`, as one string. The GUC is the claim each durability mode makes about itself. */
async function show(pglite: PgrustClientPGlite, name: string): Promise<string> {
  const result = await pglite.query<Record<string, string>>(`show ${name}`);
  const row = result.rows[0];
  const value = row?.[name];
  if (value === undefined) {
    throw new Error(`SHOW ${name} returned nothing`);
  }
  return value;
}

/**
 * The four settings a durability mode and the engine's store defaults decide, each checked against
 * what it must be: `synchronous_commit` and `fsync` follow the mode, `wal_init_zero` and
 * `wal_buffers` are the engine's own for every store (`src/client/pgrust-engine.ts`).
 */
async function assertDurabilitySettings(
  label: string,
  pglite: PgrustClientPGlite,
  durability: "strict" | "relaxed",
): Promise<void> {
  const onWhenStrict = durability === "strict" ? "on" : "off";
  const expected: readonly (readonly [string, string])[] = [
    ["synchronous_commit", onWhenStrict],
    ["fsync", onWhenStrict],
    ["wal_init_zero", "off"],
    ["wal_buffers", "4MB"],
  ];
  for (const [name, want] of expected) {
    const value = await show(pglite, name);
    log(`${label} SHOW ${name} = ${value}`);
    if (value !== want) {
      throw new Error(`${durability} durability must be ${name}=${want}, got ${value}`);
    }
  }
}

/** What a shutdown must look like: the guest's own exit(0), with the shutdown checkpoint written. */
function assertCleanShutdown(label: string, pglite: PgrustClientPGlite): string {
  const shutdown = pglite.engineShutdown;
  if (shutdown === undefined) {
    throw new Error(`${label}: close() returned without shutting the engine down`);
  }
  if (shutdown.exitCode !== 0) {
    throw new Error(`${label}: the pgrust postmaster exited with code ${shutdown.exitCode}`);
  }
  if (!shutdown.checkpointed) {
    throw new Error(`${label}: the postmaster exited without writing its shutdown checkpoint`);
  }
  return `${label}: engine down in ${ms(shutdown.shutdownMs)} (exit 0, shutdown checkpoint ran)`;
}

async function main(): Promise<void> {
  let first: PgrustClientPGlite | undefined;
  let second: PgrustClientPGlite | undefined;
  let client: SyncClient<SyncTableRegistry> | undefined;

  try {
    // ---- (a) one call, and the strict mode's own claim about itself ---------------------------
    const bootStart = performance.now();
    first = await createPgrustPglite("memory://factory-a", {
      durability: "strict",
      extensions: { live },
      applicationName: "pgxsinkit-factory-scenario",
    });
    const bootMs = performance.now() - bootStart;
    log(`(a) createPgrustPglite("memory://factory-a", strict) ready in ${ms(bootMs)}`);

    await assertDurabilitySettings("(a)", first, "strict");

    const strictSyncStart = performance.now();
    await first.strictSync();
    log(`(a) strictSync() resolved in ${ms(performance.now() - strictSyncStart)}`);

    // ---- (b) the published client, over that instance -----------------------------------------
    const clientStart = performance.now();
    client = await createSyncClient({
      registry: noteRegistry(),
      // Sync is off, so these are never dialled; the client still requires them to be well-formed.
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      syncEnabled: false,
      // The instance reports `dataDir: "memory://factory-a"`, which pgxsinkit correctly classifies
      // as non-persistent — so the memory lane is acknowledged, exactly as its own tests do.
      ...testStoreAcknowledgment(),
      precreatedPglite: Promise.resolve(first as unknown as ClientPGlite),
    });
    await client.ready;
    log(`(b) @pgxsinkit/client booted against it in ${ms(performance.now() - clientStart)}`);

    for (const note of NOTES) {
      await client.rawExec(`insert into note (id, title) values ('${note.id}', '${note.title}')`);
    }
    const written = await client.rawQuery("select count(*)::int as count from note");
    const writtenCount = Number((written.rows[0] as { count?: number } | undefined)?.count ?? -1);
    log(`(b) ${writtenCount} row(s) written through the client`);
    if (writtenCount !== NOTES.length) {
      throw new Error(`expected ${NOTES.length} rows after the writes, got ${writtenCount}`);
    }

    // ---- (d) the backup, before anything is stopped -------------------------------------------
    const dumpStart = performance.now();
    const tarball = await first.dumpDataDir();
    const dumpMs = performance.now() - dumpStart;
    const tarballName = tarball instanceof File ? tarball.name : "(Blob)";
    log(`(d) dumpDataDir() -> ${tarballName} ${tarball.size} bytes, type ${tarball.type}, in ${ms(dumpMs)}`);

    // The layout claim, checked rather than asserted in prose: PGlite's `createTarball` names every
    // entry `fullPath.substring(PGDATA.length)`, so each one begins with `/` and NOTHING wraps them
    // in a `pgdata/` root. Read here the way `loadTar` reads a backup — gunzip, then the same
    // `untar` — because the artefact under test is the gzipped one `auto` produced.
    const entries = untar(await gunzip(new Uint8Array(await tarball.arrayBuffer())), { extractData: false });
    const rooted = entries.filter((entry) => entry.name.startsWith("/"));
    const wrapped = entries.filter((entry) => entry.name.startsWith("/pgdata") || entry.name.startsWith("pgdata/"));
    const directories = entries.filter((entry) => entry.type === 5);
    log(
      `(d) tarball holds ${entries.length} entries (${directories.length} directories); ` +
        `${rooted.length} rooted at "/" like PGlite's, ${wrapped.length} wrapped in a datadir name`,
    );
    log(
      `(d) first entries: ${entries
        .slice(0, 4)
        .map((entry) => entry.name)
        .join(", ")}`,
    );
    if (entries.length === 0 || rooted.length !== entries.length || wrapped.length !== 0) {
      throw new Error("the tarball is not in PGlite's entry layout");
    }

    // ---- (c) stop, which closes the store, which takes the server with it ---------------------
    const stopStart = performance.now();
    await client.stop();
    client = undefined;
    const stopMs = performance.now() - stopStart;
    log(`(c) client.stop() returned in ${ms(stopMs)}`);
    log(`(c) ${assertCleanShutdown("factory-a", first)}`);
    if (!first.closed) {
      throw new Error("factory-a: the client reports itself open after close()");
    }
    first = undefined;

    // ---- (e) a second store, booted ON that tarball -------------------------------------------
    const restoreStart = performance.now();
    second = await createPgrustPglite("memory://factory-b", {
      durability: "relaxed",
      loadDataDir: tarball,
      extensions: { live },
      applicationName: "pgxsinkit-factory-scenario",
    });
    const restoreMs = performance.now() - restoreStart;
    log(`(e) createPgrustPglite("memory://factory-b", relaxed, loadDataDir) ready in ${ms(restoreMs)}`);

    await assertDurabilitySettings("(e)", second, "relaxed");

    const restored = await second.query<{ count: number }>("select count(*)::int as count from note");
    const restoredCount = Number(restored.rows[0]?.count ?? -1);
    log(`(e) the restored store holds ${restoredCount} note row(s)`);
    if (restoredCount !== NOTES.length) {
      throw new Error(`the restored store holds ${restoredCount} rows, expected ${NOTES.length}`);
    }

    // ---- (f) and it closes as cleanly as the first --------------------------------------------
    const secondCloseStart = performance.now();
    await second.close();
    const secondCloseMs = performance.now() - secondCloseStart;
    log(`(f) close() returned in ${ms(secondCloseMs)}`);
    log(`(f) ${assertCleanShutdown("factory-b", second)}`);
    const restoredInstance = second;
    second = undefined;

    // ---- (g) ---------------------------------------------------------------------------------
    log(
      `(g) timings: boot ${ms(bootMs)}, dump ${ms(dumpMs)}, restore-boot ${ms(restoreMs)}, ` +
        `close ${ms(stopMs)} (via client.stop) / ${ms(secondCloseMs)} (direct)`,
    );
    log(
      `(g) tar: ${tarball.size} bytes, ${entries.length} entries, root "/" ` +
        `(${restoredInstance.engineShutdown?.exitCode ?? -1} exit on the restored engine)`,
    );
    log("VERDICT: pgxsinkit-factory PASS");

    // ---- (h) and (i): is the DATADIR portable, not just the tarball? --------------------------
    // The recorded answer is no, symmetrically, over one control-file field — so this lane passes by
    // REPRODUCING that, and fails if either direction ever does something else, because a changed
    // answer (in either direction) is news and the note has to be rewritten.
    const portability = await datadirPortability(tarball, NOTES.length);
    log(
      `(h/i) pglite->pgrust ${portability.forward.state} (${portability.forward.reason}); ` +
        `pgrust->pglite ${portability.reverse.state} (${portability.reverse.reason})`,
    );
    if (!portability.asRecorded) {
      log(
        "VERDICT: datadir-portability CHANGED — docs/results/2026-09-07-datadir-portability.md " +
          `records both directions refusing over ${RECORDED_REFUSAL}; this run did not, so the note is out of date`,
      );
      process.exitCode = 1;
      return;
    }
    log(`VERDICT: datadir-portability REFUSED-AS-RECORDED (both directions, ${RECORDED_REFUSAL})`);
  } catch (error: unknown) {
    log(`VERDICT: pgxsinkit-factory FAIL — ${describe(error)}`);
    await client?.stop().catch(() => {});
    await first?.close().catch(() => {});
    await second?.close().catch(() => {});
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

/** How one direction of the datadir-portability test ended, and why. */
interface PortabilityDirection {
  readonly state: "booted" | "refused";
  /** `USE_FLOAT8_BYVAL` for the recorded refusal, `booted`, or the message of anything else. */
  readonly reason: string;
}

interface PortabilityOutcome {
  /** Whether both directions did what `docs/results/2026-09-07-datadir-portability.md` records. */
  readonly asRecorded: boolean;
  readonly forward: PortabilityDirection;
  readonly reverse: PortabilityDirection;
}

/**
 * The RECORDED outcome: both engines refuse the other's datadir over one control-file field.
 *
 * `ReadControlFile` compares the cluster's `float8ByVal` against the server's own
 * `USE_FLOAT8_BYVAL`, which is a build-time consequence of `SIZEOF_DATUM`: PGlite is a 32-bit
 * emscripten build (4-byte Datum, float8 by reference), pgrust an 8-byte-Datum one. Same
 * PostgreSQL 18.3, same `CATALOG_VERSION_NO`, same `PG_CONTROL_VERSION` — and still two physically
 * incompatible clusters, symmetrically.
 */
const RECORDED_REFUSAL = "USE_FLOAT8_BYVAL";

/** Classify a refusal by the server's own words, so a DIFFERENT refusal is not read as the same one. */
function classifyRefusal(evidence: string): string {
  return evidence.includes(RECORDED_REFUSAL) ? RECORDED_REFUSAL : (tail(evidence, 1)[0] ?? "no server output");
}

/**
 * (h) PGlite's datadir under pgrust, and (i) pgrust's under PGlite.
 *
 * Each direction is attempted on its own and reported whatever it does — a refusal is a RESULT here
 * rather than a crash, and the server's own FATAL is the interesting part. The two engines agree on
 * `CATALOG_VERSION_NO` and `PG_CONTROL_VERSION`, and pgrust's `GOAL.md` claims a C 18.3 binary can
 * boot its datadir, which is why the question is worth asking at all.
 */
async function datadirPortability(pgrustTarball: File | Blob, pgrustRows: number): Promise<PortabilityOutcome> {
  // --- (h) PGlite writes the datadir, pgrust boots it ----------------------------------------
  let forward: PortabilityDirection = { state: "refused", reason: "not attempted" };
  let pgliteTarball: File | Blob | undefined;
  let source: PGlite | undefined;
  try {
    const sourceStart = performance.now();
    // `memory://` rather than `new PGlite()`: pgxsinkit's ADR-0036 D5 records that a dump taken from
    // an explicit-`fs` memory instance silently omits relation files, and the scheme-selected form
    // is the one it sanctions. Still entirely in memory.
    source = await PGlite.create({ dataDir: "memory://pglite-source" });
    log(`(h) a plain PGlite booted in ${ms(performance.now() - sourceStart)}`);
    await source.exec("create table portable (id int primary key, note text)");
    for (let id = 1; id <= PORTABLE_ROWS; id += 1) {
      await source.exec(`insert into portable (id, note) values (${id}, 'written by PGlite')`);
    }
    await source.exec("CHECKPOINT");
    const dumpStart = performance.now();
    pgliteTarball = await source.dumpDataDir();
    log(
      `(h) PGlite dumpDataDir() -> ${pgliteTarball instanceof File ? pgliteTarball.name : "(Blob)"} ` +
        `${pgliteTarball.size} bytes in ${ms(performance.now() - dumpStart)}`,
    );
    const version = await source.query<{ version: string }>("select version()");
    log(`(h) source version(): ${version.rows[0]?.version ?? "?"}`);
  } finally {
    await source?.close().catch(() => {});
  }

  if (pgliteTarball !== undefined) {
    let target: PgrustClientPGlite | undefined;
    // The server's own stderr, kept for the refusal path: "exited with code 1" says nothing and the
    // FATAL that preceded it says everything. Silent while it works.
    let serverLog = "";
    try {
      const bootStart = performance.now();
      target = await createPgrustPglite("memory://from-pglite", {
        loadDataDir: pgliteTarball,
        extensions: { live },
        applicationName: "pgxsinkit-factory-scenario",
        onServerLog: (text) => {
          serverLog += text;
        },
      });
      const bootMs = performance.now() - bootStart;
      const counted = await target.query<{ count: number }>("select count(*)::int as count from portable");
      const count = Number(counted.rows[0]?.count ?? -1);
      const version = await target.query<{ version: string }>("select version()");
      const reported = version.rows[0]?.version ?? "";
      log(`(h) pgrust booted PGlite's datadir in ${ms(bootMs)}; portable holds ${count} row(s)`);
      log(`(h) target version(): ${reported}`);
      forward =
        count === PORTABLE_ROWS && reported.toLowerCase().includes("pgrust")
          ? { state: "booted", reason: "booted" }
          : { state: "refused", reason: `booted but read ${count} of ${PORTABLE_ROWS} rows on "${reported}"` };
    } catch (error: unknown) {
      forward = { state: "refused", reason: classifyRefusal(serverLog) };
      log(`(h) REFUSED: pgrust would not boot PGlite's datadir — ${describeShort(error)}`);
      for (const line of tail(serverLog, 4)) {
        log(`(h)   server: ${line}`);
      }
    } finally {
      await target?.close().catch(() => {});
    }
  }

  // --- (i) pgrust wrote the datadir, PGlite boots it -----------------------------------------
  let reverse: PortabilityDirection;
  let restored: PGlite | undefined;
  try {
    const bootStart = performance.now();
    restored = await PGlite.create({ dataDir: "memory://from-pgrust", loadDataDir: pgrustTarball });
    const bootMs = performance.now() - bootStart;
    const counted = await restored.query<{ count: number }>("select count(*)::int as count from note");
    const count = Number(counted.rows[0]?.count ?? -1);
    const version = await restored.query<{ version: string }>("select version()");
    log(`(i) PGlite booted pgrust's datadir in ${ms(bootMs)}; note holds ${count} row(s)`);
    log(`(i) target version(): ${version.rows[0]?.version ?? "?"}`);
    reverse =
      count === pgrustRows
        ? { state: "booted", reason: "booted" }
        : { state: "refused", reason: `booted but read ${count} of ${pgrustRows} rows` };
  } catch (error: unknown) {
    log(`(i) REFUSED: PGlite would not boot pgrust's datadir — ${describeShort(error)}`);
    const evidence = await pgliteBootLog(pgrustTarball);
    reverse = { state: "refused", reason: classifyRefusal(evidence) };
    for (const line of tail(evidence, 4)) {
      log(`(i)   server: ${line}`);
    }
  } finally {
    await restored?.close().catch(() => {});
  }

  return {
    asRecorded:
      forward.state === "refused" &&
      forward.reason === RECORDED_REFUSAL &&
      reverse.state === "refused" &&
      reverse.reason === RECORDED_REFUSAL,
    forward,
    reverse,
  };
}

/**
 * The server output of a PGlite boot that failed, which PGlite itself will not hand back.
 *
 * Its `printErr` goes to `console.error` and only when `debug` is on, so the one way to READ a
 * refusal — rather than let it scroll past interleaved with everything else — is to boot once more
 * with `debug: 1` and collect the console while it happens. Reached only on the failure path, and
 * the console is restored in a `finally`.
 */
async function pgliteBootLog(tarball: File | Blob): Promise<string> {
  const captured: string[] = [];
  const collect = (...args: unknown[]): void => {
    captured.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  };
  const original = { error: console.error, debug: console.debug, log: console.log, warn: console.warn };
  console.error = collect;
  console.debug = collect;
  console.log = collect;
  console.warn = collect;
  let diagnostic: PGlite | undefined;
  try {
    diagnostic = await PGlite.create({ dataDir: "memory://from-pgrust-debug", loadDataDir: tarball, debug: 1 });
  } catch {
    // The boot exists for its output; the throw is the outcome the caller already has.
  } finally {
    console.error = original.error;
    console.debug = original.debug;
    console.log = original.log;
    console.warn = original.warn;
    await diagnostic?.close().catch(() => {});
  }
  return captured.join("\n");
}

await main();
