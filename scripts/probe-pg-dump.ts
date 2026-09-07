/**
 * pgxsinkit's data export, over the wire: PGlite's wasm `pg_dump` against a pgrust backend.
 *
 * `bun run probe:pg-dump`            — the working path
 * `bun run probe:pg-dump --async`    — the same run with the blocking path switched off, which is
 *                                      how the failure this probe exists to fix is reproduced
 *
 * **What is being asked.** pgxsinkit exports data by running `@electric-sql/pglite-tools`'
 * `pgDump({ pg })`, which is a whole `pg_dump` — a real libpq — compiled to wasm, wired to a PGlite
 * instance by two emscripten callbacks. The write callback calls `pg.execProtocolRawStream(bytes,
 * { onRawData })` and does not await it; the read callback then consumes the buffered reply
 * IMMEDIATELY, on the same tick, from inside a blocking `callMain` where no microtask can run. That
 * works against PGlite because its engine produces the reply synchronously inside the call. Our
 * transport is a wire, and the reply arrives after an `await` — so the question is whether an
 * asynchronous transport can carry pg_dump at all.
 *
 * **The answer**, implemented in `PgrustPGlite` and exercised here: yes, wherever the agent may park
 * in `Atomics.wait` — bun's main thread and any Worker, which is every place this transport runs
 * outside a browser's main thread. `execProtocolRawStream` then drives the ring with the blocking
 * half of the `SabPipe` API and reaches `onRawData` inside its own synchronous prefix. Two things
 * had to come with it: a startup packet is answered with the handshake this session already
 * completed (libpq opens with one, and the backend is long past accepting another), and the reply
 * terminator is taken from the LAST message in a write rather than the first (libpq flushes whole
 * batches, `BasePGlite` never does).
 *
 * The schema is deliberately small and deliberately varied: two tables, an index, a few rows and a
 * plpgsql function, so the dump has to carry DDL, data and a function body.
 *
 * Exit 0 on `VERDICT: pg-dump PASS`, exit 1 with the reason on FAIL. `--async` is expected to FAIL,
 * and the point of it is the message it fails with.
 */

import type { PGlite } from "@electric-sql/pglite";
import { pgDump } from "@electric-sql/pglite-tools/pg_dump";

import { startPgrustPostmaster, type PgrustEngine } from "../src/client/pgrust-engine";
import { PgrustPGlite } from "../src/client/pgrust-pglite";

/** How much of the dump to print, so the note can quote it without the whole file. */
const PREVIEW_LINES = 40;

const SCHEMA = `
create table author (
  id int primary key,
  name text not null
);

create table book (
  id int primary key,
  author_id int not null references author (id),
  title text not null,
  published date
);

create index book_author_idx on book (author_id);

insert into author (id, name) values (1, 'Ursula K. Le Guin'), (2, 'Stanisław Lem');
insert into book (id, author_id, title, published) values
  (1, 1, 'The Dispossessed', '1974-01-01'),
  (2, 1, 'A Wizard of Earthsea', '1968-01-01'),
  (3, 2, 'Solaris', '1961-01-01');

create function book_count(author int) returns bigint language plpgsql as $$
declare
  total bigint;
begin
  select count(*) into total from book where author_id = author;
  return total;
end;
$$;
`;

/** What the dump has to contain for the probe to pass. */
const REQUIRED: readonly { readonly what: string; readonly test: (dump: string) => boolean }[] = [
  { what: "CREATE TABLE public.author", test: (dump) => dump.includes("CREATE TABLE public.author") },
  { what: "CREATE TABLE public.book", test: (dump) => dump.includes("CREATE TABLE public.book") },
  { what: "the index", test: (dump) => dump.includes("book_author_idx") },
  {
    what: "the plpgsql function body",
    test: (dump) => dump.includes("book_count") && dump.includes("select count(*)"),
  },
  // `pgDump` hard-codes `--inserts`, so the rows come back as INSERT statements rather than as COPY
  // data; either form is accepted here and the run reports which one it got.
  {
    what: "the authors' rows",
    test: (dump) => dump.includes("Ursula K. Le Guin") && dump.includes("Stanis"),
  },
  { what: "the books' rows", test: (dump) => dump.includes("The Dispossessed") && dump.includes("Solaris") },
];

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(argv: readonly string[]): Promise<void> {
  const forceAsync = argv.includes("--async");
  let engine: PgrustEngine | undefined;
  let pglite: PgrustPGlite | undefined;

  try {
    const bootStart = performance.now();
    engine = await startPgrustPostmaster({ sessions: 1 });
    log(`pgrust postmaster ready in ${(performance.now() - bootStart).toFixed(0)} ms`);

    pglite = await PgrustPGlite.create(engine.openSession(), {
      applicationName: "probe-pg-dump",
      syncRawStream: !forceAsync,
    });
    log(
      `pgwire session + PGlite client ready; execProtocolRawStream path: ` +
        `${forceAsync ? "asynchronous (forced, --async)" : "blocking where permitted"}`,
    );

    await pglite.exec(SCHEMA);
    log("schema created: two tables, one index, five rows, one plpgsql function");

    const dumpStart = performance.now();
    const file = await pgDump({ pg: pglite as unknown as PGlite });
    const dumpMs = performance.now() - dumpStart;
    const dump = await file.text();
    log(`pg_dump produced ${file.name}: ${dump.length} bytes in ${dumpMs.toFixed(0)} ms`);
    log(`data is dumped as ${dump.includes("COPY public.") ? "COPY" : "INSERT"} statements`);

    log("");
    log(`--- first ${PREVIEW_LINES} lines ---`);
    for (const line of dump.split("\n").slice(0, PREVIEW_LINES)) {
      log(line);
    }
    log("--- end of preview ---");
    log("");

    const missing = REQUIRED.filter((requirement) => !requirement.test(dump)).map((requirement) => requirement.what);
    if (missing.length > 0) {
      throw new Error(`the dump is missing: ${missing.join(", ")}`);
    }
    log(`the dump contains all ${REQUIRED.length} required parts`);

    // The session has to survive pg_dump: it set a search_path, prepared statements and ran a
    // read-only serializable transaction on the very backend this client is still talking to.
    const after = await pglite.query<{ count: number }>("select count(*)::int as count from book");
    log(`the session is still usable after the dump: ${JSON.stringify(after.rows)}`);

    await pglite.close();
    pglite = undefined;
    const stop = await engine.shutdown();
    engine = undefined;
    log(
      `pgrust postmaster stopped in ${stop.shutdownMs.toFixed(0)} ms ` +
        `(exit ${stop.exitCode}, shutdown checkpoint ${stop.checkpointed ? "ran" : "did NOT run"})`,
    );
    if (stop.exitCode !== 0) {
      throw new Error(`the pgrust postmaster exited with code ${stop.exitCode}`);
    }

    log("VERDICT: pg-dump PASS");
  } catch (error: unknown) {
    log(`VERDICT: pg-dump FAIL — ${describe(error)}`);
    await pglite?.close().catch(() => {});
    await engine?.shutdown().catch(() => {});
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

await main(process.argv.slice(2));
