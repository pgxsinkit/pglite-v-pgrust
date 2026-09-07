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
 *     one call, no engine wiring; `SHOW synchronous_commit` must say `on`, which is what the strict
 *     mode means here, and `strictSync()` — the broker's store-wide sync, which the commitment
 *     barrier calls — must resolve;
 *  b. that instance is handed to `createSyncClient({ precreatedPglite, … })` exactly as the live
 *     scenario hands its own, and rows are written through the client;
 *  d. `dumpDataDir()` — a `CHECKPOINT` and then the whole datadir read out over the host's broker
 *     channel — produces a tarball in PGlite's own layout: entries named relative to the datadir
 *     root with a leading `/`, and no `pgdata/` prefix wrapping them;
 *  c. `client.stop()` calls `pglite.close()`, and close here means the WHOLE engine: the assertion
 *     is that the postmaster exited 0 with its shutdown checkpoint written, inside the deadline;
 *  e. a SECOND store is created from that tarball —
 *     `createPgrustPglite("memory://factory-b", { durability: "relaxed", loadDataDir })` — which
 *     must report `synchronous_commit` `off` and must hold the rows written in (b);
 *  f. its own `close()` shuts down as cleanly as the first.
 *
 * Sync is off, as in the live scenario: the store seam is the subject, not the network one.
 *
 * Exit 0 on `VERDICT: pgxsinkit-factory PASS`, exit 1 with the reason on FAIL.
 */

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

    const strictCommit = await show(first, "synchronous_commit");
    log(`(a) SHOW synchronous_commit = ${strictCommit}`);
    if (strictCommit !== "on") {
      throw new Error(`strict durability must be synchronous_commit=on, got ${strictCommit}`);
    }

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

    const relaxedCommit = await show(second, "synchronous_commit");
    log(`(e) SHOW synchronous_commit = ${relaxedCommit}`);
    if (relaxedCommit !== "off") {
      throw new Error(`relaxed durability must be synchronous_commit=off, got ${relaxedCommit}`);
    }

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

await main();
