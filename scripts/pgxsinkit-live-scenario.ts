/**
 * The claim, run end to end: **pgxsinkit's client is unchanged, and the engine underneath it is
 * pgrust.**
 *
 * `bun run scenario:pgxsinkit-live`
 *
 * What happens, in order:
 *
 *  1. a pgrust **postmaster** boots under bun — the broker store, the prewarmed wasi thread pool,
 *     the real `PostmasterMain` — and one session is announced on its host pipes
 *     (`src/client/pgrust-engine.ts`);
 *  2. {@link PgrustPGlite} completes that session's pgwire handshake and becomes a PGlite client:
 *     PGlite's own `BasePGlite`, PGlite's `live` extension loaded verbatim, only the transport
 *     hooks replaced (`src/client/pgrust-pglite.ts`);
 *  3. `@pgxsinkit/client` — the **published package**, at the version in `package.json`, through its
 *     public entry points only — adopts that instance as its store and runs its ordinary boot
 *     against it: schema exec for the registry, the local-meta table, the registry-fingerprint
 *     reconcile, journal recovery;
 *  4. a live subscription is registered through the client's own `subscribeLiveRows` seam (which is
 *     what the `@pgxsinkit/react` hooks consume), a row is written through the client's `rawExec`,
 *     and the assertion is that the live callback delivers that row — which means PGlite's `live`
 *     extension created its temp view, its `pg_notify` trigger and its prepared statement inside a
 *     pgrust backend, `LISTEN`ed on that backend, and the `NotificationResponse` came back inline
 *     on the writing statement's own reply.
 *
 * Sync is off (`syncEnabled: false`): nothing here needs a control plane, and the point of the
 * scenario is the store seam, not the network one.
 *
 * Exit 0 on `VERDICT: pgxsinkit-live PASS`, exit 1 with the reason on FAIL.
 */

import { live } from "@electric-sql/pglite/live";
import { createSyncClient, type ClientPGlite, type SyncClient } from "@pgxsinkit/client";
import { testStoreAcknowledgment } from "@pgxsinkit/client/testing";
import type { SyncTableRegistry } from "@pgxsinkit/contracts";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import { startPgrustPostmaster, type PgrustEngine } from "../src/client/pgrust-engine";
import { PgrustPGlite } from "../src/client/pgrust-pglite";

/** How long the live callback has to deliver the written row before the scenario fails. */
const LIVE_DEADLINE_MS = 5_000;
/** The poll interval while waiting for it — short, so the reported latency is the transport's. */
const LIVE_POLL_MS = 20;

/** The one row this scenario writes. Fixed, so a failure names the row it did not see. */
const NOTE_ID = "9f3a1c62-0d4b-4f9e-8a71-2c5d6e7f8a90";
const NOTE_TITLE = "the same client, the other engine";

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

interface NoteRow extends Record<string, unknown> {
  readonly id: string;
  readonly title: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  let engine: PgrustEngine | undefined;
  let client: SyncClient<SyncTableRegistry> | undefined;
  let unsubscribe: (() => void) | undefined;

  try {
    const bootStart = performance.now();
    engine = await startPgrustPostmaster({ sessions: 1 });
    log(`pgrust postmaster ready in ${(performance.now() - bootStart).toFixed(0)} ms`);

    const handshakeStart = performance.now();
    const pglite = await PgrustPGlite.create(engine.openSession(), {
      extensions: { live },
      applicationName: "pgxsinkit-live-scenario",
    });
    log(`pgwire session + PGlite client ready in ${(performance.now() - handshakeStart).toFixed(0)} ms`);

    const clientStart = performance.now();
    client = await createSyncClient({
      registry: noteRegistry(),
      // Sync is off, so these are never dialled; the client still requires them to be well-formed.
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      syncEnabled: false,
      // The store is a pgrust session, which pgxsinkit cannot classify as persistent — acknowledge
      // it past the bring-your-own refusal, exactly as the package's own unit lane does.
      ...testStoreAcknowledgment(),
      // `precreatedPglite`, not `pgliteInstance`: the client then owns every post-create step —
      // schema exec, the prepare hooks, the registry reconcile — so all of them run over the wire
      // too, which is a stronger claim than adopting an already-provisioned store.
      precreatedPglite: Promise.resolve(pglite as unknown as ClientPGlite),
    });
    await client.ready;
    log(`@pgxsinkit/client booted against it in ${(performance.now() - clientStart).toFixed(0)} ms`);

    // The live seam the React hooks consume, over PGlite's `live` extension, in a pgrust backend.
    let latest: NoteRow[] = [];
    let deliveries = 0;
    const subscription = await client.subscribeLiveRows<NoteRow>(
      { sql: "select id, title from note order by title", params: [] },
      (rows) => {
        deliveries += 1;
        latest = rows;
      },
    );
    unsubscribe = subscription.unsubscribe;
    log(`live subscription registered; initial rows: ${JSON.stringify(subscription.initialRows)}`);
    if (subscription.initialRows.length !== 0) {
      throw new Error(`expected an empty initial snapshot, got ${JSON.stringify(subscription.initialRows)}`);
    }

    // The write. `rawExec` is the client's own inspection surface — a public API that lands straight
    // in the store — because with sync disabled the Mutation journal has nowhere to drain to.
    const writtenAt = performance.now();
    await client.rawExec(`insert into note (id, title) values ('${NOTE_ID}', '${NOTE_TITLE}')`);

    const deadline = writtenAt + LIVE_DEADLINE_MS;
    let deliveredAt: number | null = null;
    while (performance.now() < deadline) {
      if (latest.some((row) => row.id === NOTE_ID && row.title === NOTE_TITLE)) {
        deliveredAt = performance.now();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
    }
    if (deliveredAt === null) {
      throw new Error(
        `the live subscription never delivered note ${NOTE_ID} within ${LIVE_DEADLINE_MS} ms ` +
          `(${deliveries} delivery/deliveries, last rows ${JSON.stringify(latest)})`,
      );
    }
    log(
      `live delivery: ${(deliveredAt - writtenAt).toFixed(1)} ms from insert to callback, over ${deliveries} delivery/deliveries`,
    );
    log(`live rows now: ${JSON.stringify(latest)}`);

    unsubscribe();
    unsubscribe = undefined;
    await client.stop();
    client = undefined;

    const stop = await engine.shutdown();
    engine = undefined;
    log(
      `pgrust postmaster stopped in ${stop.shutdownMs.toFixed(0)} ms ` +
        `(exit ${stop.exitCode}, shutdown checkpoint ${stop.checkpointed ? "ran" : "did NOT run"})`,
    );
    if (stop.exitCode !== 0) {
      throw new Error(`the pgrust postmaster exited with code ${stop.exitCode}`);
    }

    log("VERDICT: pgxsinkit-live PASS");
  } catch (error: unknown) {
    log(`VERDICT: pgxsinkit-live FAIL — ${describe(error)}`);
    unsubscribe?.();
    await client?.stop().catch(() => {});
    await engine?.shutdown().catch(() => {});
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

await main();
