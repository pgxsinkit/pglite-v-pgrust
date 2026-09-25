# pglite-v-pgrust

A browser benchmark that runs the same SQL workloads against [PGlite](https://pglite.dev) and
[pgrust](https://github.com/malisper/pgrust) — two WebAssembly Postgres builds — and reports the
timings side by side, with [wa-sqlite](https://github.com/rhashimoto/wa-sqlite) alongside them as a
calibration reference.

Two Suites are ported unchanged from PGlite's own benchmark pages, and a third asks what the first
two cannot:

- **Speedtest Suite** — the 16 SQL scripts ported from the SQLite speed test via
  [wa-sqlite](https://github.com/rhashimoto/wa-sqlite), byte-identical to PGlite's copies. One timing
  per script.
- **RTT Suite** — twelve single-statement CRUD queries, 100 iterations each, top and bottom 10% of
  timings discarded, mean of the rest.
- **[Concurrency Suite](#the-concurrency-suite)** — five scripted scenarios run by four **Clients**
  at once against one 100 000-row table: a read fan-out, a reader under a bulk write, short queries
  beside a long one, writers on disjoint rows and writers on the same row. Every Engine runs it; what
  "at once" means is the Engine's answer, stated in each column's header and exactly what the Suite
  reports.

Each Engine runs in its own dedicated module worker, and every timing is taken **inside** that worker
around the Engine call alone — the main-thread messaging is deliberately outside the measured window.
Results are shown per Configuration (an Engine plus its storage and durability settings), with a ratio
column against the `PGlite Memory` baseline and a "Copy as Markdown" button per Suite.

Times are milliseconds; lower is better — except one Concurrency row that reports a rate and says so
in its own label.

**Run it without cloning anything: <https://pgxsinkit.github.io/pglite-v-pgrust/>** — the same page,
the same fourteen columns, on your own browser. See [GitHub Pages](#github-pages).

## Quick start from a clone

Five commands. No sibling checkouts, no Rust toolchain, no pgxsinkit checkout:

```sh
mise install                              # Bun and Node at the versions this repo pins
bun install
bun run sync:pgrust --release latest      # the pgrust wasm and the store bundle, ~30 MB
bunx playwright install chromium firefox  # only for the headless lane
bun run dev                               # http://localhost:5580, then press Start
```

`bun run bench --suite rtt --iterations 3` runs the same page headlessly instead and prints the
tables; `bun run bench` on its own runs all three Suites (see [the headless lane](#headless-lane)).

`bun run scenario:pgxsinkit-live` is the one lane here that is not a benchmark: it boots a pgrust
postmaster under bun and runs the published `@pgxsinkit/client` against it — unchanged, over PGlite's
own `BasePGlite` with a pgwire transport (`src/client/`). It needs the synced assets and nothing else.

`bun run scenario:pgxsinkit-factory` runs the same client over the STORE half of that seam:
`createPgrustPglite(storePath, …)` (`src/client/pgrust-factory.ts`), which is what pgxsinkit's own
`createPglite` hook takes. One call opens a store, and the instance answers the rest of the contract
— `strictSync()` over the broker's store-wide sync, `dumpDataDir()` as a tarball in PGlite's own
entry layout, `loadDataDir` seeding a second store before its postmaster boots, and a `close()` that
takes the whole engine down with it. The scenario proves each of those in turn and prints its
timings, and then asks whether the DATADIR is portable between the two engines as well as the
tarball format — it is not, and
[the note](docs/results/2026-09-07-datadir-portability.md) says which single control-file field
stops it.

Only `bun install` and the sync need a network. The sync downloads the newest `pgrust-assets/*`
[release](#pgrust-assets) of this repo — ~30 MB gzipped, ~135 MB unpacked into `public/pgrust/`,
which is gitignored — verifies every file against the release's `SHA256SUMS` **and** the unpacked
sizes and digests in its `manifest.json`, and writes nothing at all if any of that disagrees. It is
the only step that is not instant, and it is the only one that ever has to be repeated: run it again
when a newer release is published.

Without it the app still builds and runs; the eight pgrust columns report their own missing asset in
their own headers and the six others are unaffected.

What each column needs beyond that, all of it satisfied by a current Chromium, Firefox or Safari:

| Column                                                  | Needs                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| the two `PGlite Memory` and two `wa-sqlite Memory` ones | nothing beyond `bun install`                                                     |
| `PGlite OPFS repacked`, relaxed and strict              | an OPFS synchronous access handle in a dedicated worker                          |
| `pgrust Memory` and `pgrust Memory (unlogged)`          | the synced assets **and JSPI** — the only two columns that need it               |
| every `pgrust Threads` and `pgrust Postmaster` one      | the synced assets and [cross-origin isolation](#cross-origin-isolation); no JSPI |
| the three of those whose store is on OPFS               | the above, plus a synchronous access handle in a dedicated worker                |

Cross-origin isolation is not something you have to arrange: `vite.config.ts` sends both headers for
`bun run dev` and `bun run preview`, and the bench lane's own static server sends them too, so a
`cross-origin isolated no` in the header is a browser withholding them rather than a missing config.
(The one host that cannot send them is [GitHub Pages](#github-pages), where a service worker does it
instead, at the cost of one reload on the first visit.)
The four broker and postmaster columns additionally load a pre-release build of the OPFS store, which
[ships with the release](#download-a-published-build) — nothing else to fetch.

`PGLITE_V_PGRUST_RELEASE_BASE_URL` points the sync at a directory of release assets instead of
GitHub (a local static server, say). That directory has no release list, so pass the tag:
`PGLITE_V_PGRUST_RELEASE_BASE_URL=http://127.0.0.1:8791 bun run sync:pgrust --release pgrust-assets/08a30644`.

## The Reference Engine

PGlite and pgrust are the subjects of the comparison. wa-sqlite is not: it is the **Reference
Engine**, and its `wa-sqlite Memory` column exists so the harness itself can be checked. Both Suites
originate in wa-sqlite's benchmarks and both wa-sqlite and PGlite publish their own numbers for
them, so a wa-sqlite column that lands where those pages say it should is evidence that this
harness measures what they measure — and a column that lands somewhere else is evidence that it
does not. It is never the baseline of a ratio; like every other Configuration it is reported
against `PGlite Memory`.

It is opened the way PGlite's own benchmark page opens it — the synchronous wasm build with
`MemoryVFS` — and its timed call is `sqlite3.exec(db, sql, rowCallback)` with the rows collected,
which is the wa-sqlite equivalent of PGlite's `pg.exec(sql)`: SQL in, decoded rows out.

wa-sqlite is installed **from its GitHub tag**, not from npm: npm only ever received `1.0.0`, while
upstream has gone on releasing by tag with `dist/` committed. The dependency is pinned to an exact
tag, `github:rhashimoto/wa-sqlite#v1.1.2`, and `bun.lock` records the commit that resolved to. The
environment header reports the tag rather than the installed manifest — `wa-sqlite v1.1.2 (github)` —
because a tagged tree's manifest can lag its tag, and `v1.1.2` still says `1.1.1` inside. Reporting
that would be reporting a version that was never released. The rule is in `src/dependency-version.ts`
and is unit-tested; a plain semver dependency still reports its manifest version as before.

One consequence of it being SQLite rather than Postgres: **the RTT Suite's untimed setup is
dialect-specific.** Its two `CREATE TABLE` statements are run as `INTEGER PRIMARY KEY AUTOINCREMENT`
rather than `SERIAL`, byte-identical to PGlite's own SQLite variant. That is the only SQL that differs
anywhere: every timed Benchmark in both Suites is run byte-identically against every Engine.

## PGlite, once

The PGlite columns and the OPFS store have to be the **same** PGlite: a benchmark that ran the Engine
on one build and the store on another would be measuring neither. PGlite here is this project's fork,
published as `@pgxsinkit/pglite`, while the store package declares its peer against the upstream name
`@electric-sql/pglite`. Rather than install both, PGlite is installed under the upstream name through
an npm alias:

```json
"@electric-sql/pglite": "npm:@pgxsinkit/pglite@0.5.5-pgx.2"
```

One dependency, one copy in `node_modules` (`bun pm ls`), one `pglite.wasm` and one `pglite.data` in
`dist/`, and the store's peer satisfied by the exact build being measured. The environment header
still names the fork — `@pgxsinkit/pglite 0.5.5-pgx.2` — and takes the version from the alias rather
than from the dependency key, which under an alias is not the installed package's name at all. That
rule lives beside wa-sqlite's git-tag rule in `src/dependency-version.ts` and is unit-tested with it.

## The columns

Fourteen Configurations. Nine are **Memory Configurations**. For PGlite, pgrust and wa-sqlite the
pair is the Engine's default settings and the least durable settings it offers: `PGlite Memory`,
`PGlite Memory (unlogged)`, `pgrust Memory`, `pgrust Memory (unlogged)`, `wa-sqlite Memory`,
`wa-sqlite Memory (journal off)`. For the pgrust threads build the pair is its two filesystem seams
instead: `pgrust Threads Memory` and `pgrust Threads Memory (broker, pre-release store)`. The ninth
is `pgrust Postmaster Memory (broker, pre-release store)`, which is the same store and the same seam
under a real postmaster rather than one session. Five are **Storage Configurations**, and they are
one store measured through three Engines: `PGlite OPFS repacked (relaxed)` and
`PGlite OPFS repacked (strict)` reach it through PGlite,
`pgrust Threads OPFS repacked (relaxed, pre-release store)` and
`pgrust Threads OPFS repacked (strict, pre-release store)` reach the same store through the threads
build's broker coordinator, and `pgrust Postmaster OPFS repacked (relaxed, pre-release store)`
reaches it through that coordinator with a whole postmaster on top. Every ratio is against
`PGlite Memory`, which is the only column without one.

The two unlogged columns rewrite `CREATE TABLE` to `CREATE UNLOGGED TABLE` — PGlite's own benchmark
page does this, and pgrust accepts the same syntax — so the Engine writes no WAL for the Suite's
tables. In a Memory Configuration the data directory dies with the worker anyway, so the WAL buys no
durability there; unlogged only stops paying for it. The rewrite is applied on the main thread to
**every** SQL string a Run executes, the untimed setup included: the RTT Suite creates its two tables
in its setup and nowhere else, so an unlogged column whose setup was left alone would silently be a
second copy of the logged column.

`CREATE UNLOGGED TABLE` is Postgres-only, so SQLite's no-durability twin is a journal mode instead: the
`wa-sqlite Memory (journal off)` column issues `PRAGMA journal_mode = OFF` immediately after `open_v2`,
before any setup and outside every Measurement, which removes the rollback journal entirely — SQLite
then cannot roll a statement or a transaction back. The pragma is verified rather than assumed (SQLite
answers a refused journal change with the mode still in force, not with an error), and the Run fails
loudly if the read-back is not `off`. The default `wa-sqlite Memory` column keeps SQLite's own default
journal mode.

### The pgrust Threads columns

The four `pgrust Threads` columns are the **same pgrust commit as the two `pgrust` columns**, built
for `wasm32-wasip1-threads` instead of `wasm32-wasip1`. That is one source tree, two targets, one
packed data directory image — the environment header names a single pgrust commit because there is
only one.

What changes is how the guest waits. The `pgrust` columns run a `postgres --stdio-wire` session that
suspends on its blocking stdin read, which needs JSPI. The threads build runs
`postgres --stdio-wire-threaded`: the session runs on a **real thread**, spawned through the guest's
own `wasi` `thread-spawn` import out of a prewarmed pool of workers, over one shared
`WebAssembly.Memory` — so the same blocking `read(0)` simply blocks that worker in `Atomics.wait`,
the way it blocks under a native host's pipe. **No JSPI anywhere.** What it needs instead is
`SharedArrayBuffer` and a shared memory, and therefore [cross-origin
isolation](#cross-origin-isolation); where a browser withholds those all four columns are greyed out
with that reason, exactly as the pgrust columns are without JSPI, and every other column runs.

What the four differ in is where the guest's files live.

| Column                                                      | `--fs`   | Store port | The data directory                                                                                                    |
| ----------------------------------------------------------- | -------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `pgrust Threads Memory`                                     | `copy`   | —          | Every worker builds its own VFS from its own copy of the packed image — the host's own default                        |
| `pgrust Threads Memory (broker, pre-release store)`         | `broker` | `memory`   | One repacked store in a dedicated coordinator worker, which every instance reaches over a `SharedArrayBuffer` channel |
| `pgrust Threads OPFS repacked (relaxed, pre-release store)` | `broker` | `opfs`     | That same coordinator's store, in one dedicated OPFS directory instead of its heap; `relaxed` durability              |
| `pgrust Threads OPFS repacked (strict, pre-release store)`  | `broker` | `opfs`     | The same again, `strict`: every mutating broker request is followed by a store-wide arena-before-metadata sync        |

The first two keep the data directory in memory and die with their workers, so they are Memory
Configurations: nothing survives a Run, and the broker column's store is on the memory port
precisely so that stays true. The last two are [Storage
Configurations](#the-opfs-repacked-columns) on the same store the `PGlite OPFS repacked` columns
run on.

**`pre-release store` is not decoration.** The five broker columns — the three above and the two
[postmaster columns](#the-pgrust-postmaster-columns) — load a build of
`@pgxsinkit/pglite-opfs-repacked` whose sync broker and WASI filesystem adapter are in **no
published version** of that package: `bun run sync:pgrust` copies it out of a pgxsinkit checkout and
records the exact commit in `src/vendor/pgrust/SOURCE.md`. The two `PGlite OPFS repacked` columns
are a different thing entirely — they run the published package this repo depends on. Without that
bundle the broker columns report it missing and everything else runs.

### The pgrust Postmaster columns

The two `pgrust Postmaster` columns are **the same wasm module as the four `pgrust Threads` columns,
booted as a server instead of as a session**. The threads columns run
`postgres --stdio-wire-threaded`: one session, on one spawned thread, reading fd 0 and writing fd 1.
These two run `postgres --host-pipes`, which picks a transport and then falls through to the ordinary
`PostmasterMain` — so what starts is a postmaster with a startup process, a checkpointer, a
background writer, a WAL writer and a warm standby pool, and **every session is a real backend on its
own guest thread**. Two sessions here are two backends contending in shared memory and in the lock
manager, not two callers of one queue.

| Column                                                         | Store port | What is on top of the store                                                         |
| -------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `pgrust Postmaster Memory (broker, pre-release store)`         | `memory`   | A whole postmaster; nothing leaves the coordinator's heap, so it is a Memory column |
| `pgrust Postmaster OPFS repacked (relaxed, pre-release store)` | `opfs`     | The same postmaster on the same four OPFS files the other repacked columns use      |

The transport is pgrust's host-pipe file-descriptor contract, and the host half of it lives in
`src/engines/pgrust-postmaster/pgrust-postmaster.worker.ts`: a listener ring on fd 1000, a wake
channel on fd 999 and one `(in, out)` pair of `SharedArrayBuffer` rings per session at fds
1001+2k/1002+2k. **Every one of those rings is created before the guest starts**, because the fd
registry is handed to the pool workers at prewarm — which is why the number of sessions is settled
when the Engine is opened (`EngineOpenOptions.sessions`, asked for by the Suite) rather than grown on
demand. A session is opened by writing a 16-byte `HPGP` record to the listener and one token byte to
the wake fd; the postmaster wakes, accepts, spawns the backend, and the backend answers the startup
packet. That accept costs 10–110 ms per session and is paid inside `open`, outside every Measurement.

There is no `--fs copy` here. A postmaster's checkpointer is its own guest thread, and on the copy
seam it would build its filesystem from its own copy of the packed image and see nothing the backends
wrote — so the broker seam is not a knob on this Engine, it is a requirement, and both columns load
the same [pre-release store](#the-pgrust-threads-columns) the broker threads columns do.

Shutdown is Postgres's own. Each session is sent Terminate, then the listener ring is **closed**, and
that EOF is what `pqcomm_hostpipes` turns into a fast-shutdown request — the same flag a `SIGINT`
raises. The guest then walks its ordinary ceremony (stop backends, wait for them, shutdown
checkpoint, `exit(0)`) and the worker waits for that exit rather than terminating a worker out from
under a running server. Only then is the coordinator stopped through its doorbell, and only then can
the OPFS directory be removed.

These are the only columns that can be asked more than one thing at a time and answer it with more
than one backend: N sessions here are N real Postgres backends, sharing one buffer pool, one lock
manager and one WAL. That is what the [Concurrency Suite](#the-concurrency-suite) is for.

### The OPFS repacked columns

The four OPFS repacked columns are the ones whose data directory is real storage rather than the
worker's heap. Two of them run PGlite on
[`@pgxsinkit/pglite-opfs-repacked`](https://www.npmjs.com/package/@pgxsinkit/pglite-opfs-repacked), a
PGlite filesystem that packs a whole Postgres data directory into exactly four exclusively owned OPFS
files — an arena, two metadata logs and an activation record — instead of giving every virtual file
its own synchronous access handle the way PGlite's native OPFS filesystem does. The store's
`durability` is chosen once when it is opened and is the **only** difference between the two columns:
`relaxed` skips the per-query strict sequence and amortizes arena flushes, `strict` flushes arena data
before metadata on every awaited host sync, so a successful query has a stable boundary behind it.
Same Engine, same SQL, same store, one option.

The other two — `pgrust Threads OPFS repacked (relaxed, pre-release store)` and
`(strict, pre-release store)` — are **the same store, reached the other way**: not through PGlite's
filesystem but through the threads build's broker, where the store lives alone in a coordinator
worker and every guest instance asks it for files over a `SharedArrayBuffer` channel. Same four OPFS
files, same two durability modes, a whole Postgres and a whole filesystem seam in between. They are
the OPFS-port half of [the pgrust Threads columns](#the-pgrust-threads-columns), and their store is
the pre-release bundle those columns describe, which is why their labels say so. One difference is
worth knowing: the coordinator can only own a **root-level** OPFS directory
(`pglite-v-pgrust-threads-opfs-repacked-relaxed` and `-strict`, one each), because it is vendored
byte-verbatim and resolves the one directory name it is given against the OPFS root, which refuses a
name with a `/` in it.

**No column here persists anything between Runs.** Each Run starts from an emptied directory —
PGlite's worker empties it, the coordinator is asked to `reset` its own — and the directory is
removed again when the Run closes, so what these columns measure is what OPFS costs a cold data
directory per statement, not what a warm one reads back. That is the same rule the Memory
Configurations get for free by dying with their worker, and it is the reason a repeated Run gives
repeatable numbers. All that outlives a Run is an empty `pglite-v-pgrust/` directory: no page this
app has ever loaded can read a byte of an earlier Run's database back.

The store needs a `createSyncAccessHandle()` that really opens, in a dedicated worker — PGlite's own,
or the coordinator the threads columns run their store in. That is probed at page load — a real
handle on a real file, because the method's presence proves nothing — and reported in the header:

| Browser                    | Synchronous access handle in a dedicated worker | OPFS columns     |
| -------------------------- | ----------------------------------------------- | ---------------- |
| Chromium                   | granted                                         | run              |
| Firefox                    | granted                                         | run              |
| Playwright's WebKit        | refused                                         | reported skipped |
| Safari (SharedWorker only) | refused in a dedicated worker                   | reported skipped |

Where it is refused the four columns are greyed out with that reason, the probe's own words are in
the header, and every other column runs as normal — exactly as the pgrust column behaves without
JSPI. The two threads columns need cross-origin isolation as well, and are told about that first: it
is what decides whether that Engine can exist at all.

## The Concurrency Suite

The Speedtest and RTT Suites time one statement at a time. This one runs **four Clients at once** and
reports what they did to each other, which is a different question — and one where the Engines
genuinely differ rather than merely differing in speed.

**Every Engine runs it, and every column says how.** There are exactly two answers to "what does at
once mean here", and each column's header carries its own — its **Concurrency mode** — right beside
the label, in the page and in the Markdown export:

| Concurrency mode             | Which Engines                                     | What it is                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `one backend per Client`     | `pgrust Postmaster`                               | **Real backends.** Client `i` gets Session `i`, which is a Postgres backend on its own guest thread; they share one buffer pool, one lock manager and one WAL, and they block on each other exactly as backends do                                             |
| `interleaved on one session` | `PGlite`, `pgrust`, `pgrust Threads`, `wa-sqlite` | **One place to run SQL, taken a statement at a time.** A Client's plain statement takes it and gives it back, so another Client's can be served in between; a transaction takes it at `BEGIN` and holds it through `COMMIT`, so nothing interleaves inside one |

That is not a hedge and it is not a serialised Run wearing the word "concurrent": it is how an
application really gets concurrency out of any of the four — several callers, one place, one
statement at a time — and it is what PGlite was already being measured doing. The four share one
queue (`src/engines/single-session.ts`), so they differ in their database and in nothing else. **No
cell in this Suite is ever `skipped` for what an Engine is;** the only reasons a Concurrency column
can be empty are the browser capabilities every other Suite is gated on too.

The mode belongs in the header because the cell under it cannot be read without it. A reader p95 of
`0.4 ms` and one of `670 ms` are both honest answers to "what did the other Clients feel" — which one
an Engine gives is decided entirely by the mode, and a pasted table has to carry it.

**Two dialects.** The Suite's SQL is Postgres-flavoured and wa-sqlite is not, so the dataset, the
per-Session lock wait and the third Benchmark's long query each have a SQLite spelling, exactly as
the RTT Suite's setup does. `generate_series` becomes a recursive CTE and `rpad(md5(…), 100, 'x')`
becomes `substr(hex(x) || 'xxx…', 1, 100)`; `SET lock_timeout = '2s'` becomes
`PRAGMA busy_timeout = 2000` and `55P03` becomes `SQLITE_BUSY`; and the long query — SQLite has no
`~` operator, and its `GLOB` over the same payloads finishes in single-digit milliseconds — becomes
a recursive CTE doing arithmetic, sized to land in the same band as the Postgres full scan (it
measures 151 ms against PGlite's 267). Nothing else differs: the keys, the Clients and the statement
counts come out of the same seeded draws in the same order.

**The dataset** is built in each Run's untimed setup and is the same everywhere: `concurrency_rows`,
100 000 rows with an integer key, an integer value and a 100-byte text payload (different in every
row), a primary key and a second index; plus `concurrency_contended`, the one row the last Benchmark
fights over.

**The five rows**, each with the one number it reports and the Detail beneath it:

| Benchmark                       | What runs                                                                                                                                                   | The cell                              | The Detail                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| Read fan-out                    | 4 Clients x 500 indexed point SELECTs by random key                                                                                                         | total wall for all Clients            | statements, statements/s, per-Client p50/p95/max  |
| Reader under a bulk write       | Client 0 inserts 25 000 rows in one transaction, then signals; the others read `untilSignal`                                                                | the readers' **p95**                  | writer total, reader max, reader statement count  |
| Short queries beside a long one | Client 0 runs one long query — a full scan with two string comparisons in Postgres, a recursive CTE in SQLite, both ~150-400 ms — then signals; others read | the short Clients' **p95**            | long query time, short max, short statement count |
| Writers on disjoint rows        | 4 Clients x 200 short transactions, each in its own quarter of the key space                                                                                | **transactions/s** (higher is better) | per-Client p95, total wall, transactions          |
| Writers on the same row         | 4 Clients x 200 short transactions on one row, `lock_timeout = 2s` (`PRAGMA busy_timeout` on SQLite) per Session                                            | **p95** commit latency                | lock timeouts, per-Client totals, total wall      |

A **transaction is one sample**, not three. A postmaster Session can time a `COMMIT` on its own and
PGlite cannot (its `transaction` issues both ends itself), so the only unit both can be asked for
honestly is the whole short transaction — which is what "commit latency" means in this Suite.

**The keys are seeded.** Every key every Client reads or updates is drawn from a fixed seed on the
main thread and written into the Scenario as a literal, so every Engine is asked the same questions
in the same order and a re-run reads the same rows. A column whose keys came from `random()` inside
the database would be a different workload per column, and the table would compare nothing.

**The Detail** is under the table in the Markdown export (one line per Configuration per Benchmark)
and folded away under the row in the page. A cell stays one number; a p95 with no statement count
behind it is not something a reader can check.

The Suite runs four Clients by definition, and the page offers no control that changes it. For
automation only, the URL query `?concurrencyClients=N` — an integer from 2 to 8, anything else
ignored — rebuilds the Suite for another Client count, and says so in the environment header, in the
Suite itself and in every Markdown export. Every export carries the Client count either way, as its
own line under the environment: `Concurrency clients: 4`.

## Results

> **2026-09-24: every OPFS number in the runs below was taken in an off-the-record context.**
> Until 2026-09-24 `bun run bench` ran the page in Playwright's `browser.newContext()`, where
> Chromium keeps OPFS in memory in the browser process and every access-handle call is a round trip
> to it. The lane now runs on an on-disk profile, where PGlite OPFS repacked (relaxed) is 1.05×
> PGlite Memory rather than 1.68× and the postmaster 1.57× PGlite OPFS rather than 1.50× — see
> [2026-09-24, the persistent context](docs/results/2026-09-24-persistent-context.md). The figures
> below are unchanged.

Committed runs live in [`docs/results/`](docs/results/) — the page's own Markdown export, one file per
browser and date, produced by `bun run bench`. The current run
([2026-09-06, Chromium 152, Linux, fourteen columns](docs/results/2026-09-06-chromium-152-linux-fourteen-columns.md))
covers all fourteen Configurations and all three Suites, the two pgrust Postmaster columns and the
Concurrency Suite included; the run before it
([2026-09-06, Chromium 152, Linux, twelve columns](docs/results/2026-09-06-chromium-152-linux-twelve-columns.md))
is the two-Suite run it extends, on the same browser and the same machine, and before that
([2026-09-06, Chromium 152, Linux, ten columns](docs/results/2026-09-06-chromium-152-linux-ten-columns.md))
and
([2026-09-06, Chromium 152, Linux, eight columns](docs/results/2026-09-06-chromium-152-linux-eight-columns.md))
extend it backwards, and
([2026-08-29, Chromium 152, Linux, six columns](docs/results/2026-08-29-chromium-152-linux-six-columns.md))
is the memory-only baseline it all started from.

Two things to read off the fourteen-column run before anything else.

**A postmaster backend measures like a session.** `pgrust Postmaster Memory (broker)` lands on top of
`pgrust Threads Memory (broker)` throughout the two single-statement Suites — 4602 against 4589 ms on
`25000 INSERTs in a transaction`, 216.7 against 219.9 on `25000 INSERTs in single statement`, 0.253
against 0.265 ms on `select small row` — which is what says a whole server, its auxiliary processes
and a host-pipe transport cost the Engine nothing per statement. The same holds on the OPFS port
against `pgrust Threads OPFS repacked (relaxed)`.

**And a backend is a different thing when something else is running.** On the Concurrency Suite a
reader under a 25 000-row bulk write reports p95 **672.860 ms** on `PGlite Memory` and **0.395 ms** on
the postmaster: PGlite's queue is held for the writer's whole transaction, so its readers complete 3
statements while four real backends complete 60 000. Short queries beside a full scan are 273.015
against 0.495 ms; writers on disjoint rows are 2005 against 5670 transactions/s. Writers on the _same_
row are the row where they meet — 2.415 against 2.165 ms p95, no lock timeouts either side — because
one contended row is a queue however you reach it.

`pgrust Threads Memory` still lands on top of
`pgrust Memory` throughout both single-statement Suites — the two builds of one commit measure the
same database, which is what says the threads transport costs the Engine nothing.

The broker column's ~25 ms RTT floor is gone: every writing statement in it used to settle at ~25 ms
while every reading one stayed under a millisecond, and it now reports 0.27–0.84 ms across the whole
RTT Suite. That floor was never the broker seam — it was the store's memory port cloning its whole
~43 MiB arena on every flush, and the broker turns every guest `fd_sync` into one. The pre-release
bundle these columns load was re-synced after that was fixed upstream (`SOURCE.md` names the
commit), so the ten-column run and the runs after it differ in the store as well as in the columns.

And the new pair says where the broker seam actually costs something. Per **statement** it is nearly
free: on the RTT Suite `pgrust Threads OPFS repacked (relaxed)` sits within a hair of
`PGlite OPFS repacked (relaxed)` on every one of the twelve statements (0.72 against 0.70 ms on
`insert small row`, 0.26 against 0.30 on `select small row`), which is the same store answering the
same question through two entirely different filesystems. Per **script** it is not: the Speedtest
rows that write a lot in one statement pay for the round trip per file operation — `INSERTs from a
SELECT` is 1935 ms relaxed and 2634 ms strict against PGlite's 1308 ms, `25000 INSERTs into an
indexed table in single statement` 586/702 against 322 — and strict costs the threads path
noticeably more than it costs PGlite's, because there strict means a store-wide sync after every
mutating broker request rather than after every awaited host sync.

**And on a phone the postmaster used to be the one column that could not finish.** An iPhone Xs
(4 GB, iOS 18.7.1) reloaded the page for memory when only `pgrust Postmaster OPFS repacked
(relaxed)` and wa-sqlite were selected, while every PGlite column plus wa-sqlite completed all three
Suites on the same phone. [The memory diet](docs/results/2026-09-08-webkit-memory-diet.md) measured
it on real Safari 26.6.2 and took the Speedtest Suite's shared memory from 1101 to 657 MiB and the
Concurrency Suite's from 979 to 367 MiB, at the same speed. Almost all of it was one thing:
`max_stack_depth`, which is not a memory GUC anywhere else but on wasm sizes every child thread
stack the postmaster carves out of its one shared memory.

Things the harness turned up along the way are written up in [`docs/findings/`](docs/findings/).
The first — [pgrust needs (statements × message size) memory for multi-statement
queries](docs/findings/0001-pgrust-multi-statement-memory.md) — is why the pgrust column is currently
built from a patched branch (see [pgrust assets](#pgrust-assets)).

## Prerequisites

- [mise](https://mise.jdx.dev) for tool versions, which pins Bun and Node for this repo:

  ```sh
  mise install
  ```

- Bun 1.4 (installed by the step above).

## Getting started

```sh
bun install
bun run dev      # http://localhost:5580
```

The pgrust columns need one more step before they can run — `bun run sync:pgrust --release latest`;
the [quick start](#quick-start-from-a-clone) is the whole sequence in order.

To build and serve the production bundle:

```sh
bun run build
bun run preview
```

Both Suites are started from the page — nothing runs until you press **Start**. Each Run opens a fresh
Engine in a fresh worker, so no state carries over between Configurations; a Storage Configuration's
OPFS directory is emptied before its Run and removed after it, so nothing carries over between page
loads either.

The **Configurations** panel above the Suites chooses which columns a Run compares and which of them
every ratio is taken against. Every Configuration is ticked by default; the ones this browser cannot
run are greyed out, unticked and carry their own reason. Only ticked Configurations are run and only
they become columns, always in the fixed order. The Baseline radio picks the column the ratio headers
name — `PGlite Memory` unless it is unticked, in which case the first ticked column takes over — and
the Reference Engine's radio is greyed out, because wa-sqlite is here to calibrate the harness rather
than to be the thing every other column is measured against.

Both choices are written to the URL as `?configurations=<id,id,…>` and `?baseline=<id>`
(`history.replaceState`, so ticking four boxes is one history entry), which is what makes a narrowed
Run reproducible: the link **is** the run. An absent `configurations` means every Configuration this
browser can run; an id that names nothing is ignored with a note on the page and dropped from the
URL, and a Baseline outside the selection falls back and corrects the URL the same way. Every
Markdown export carries the line `Configurations (N of 14): … | Baseline: …` under the environment,
so a table of three columns can never be mistaken for a table of fourteen.

Both Suites the page runs unchanged are fixed by definition. The RTT Suite is 100 iterations, and the
page offers no control that changes it. For
automation only, the URL query `?rttIterations=N` — an integer from 1 to 1000, anything else ignored —
shortens it, and says so everywhere: the environment header, the Suite itself and every Markdown
export carry `RTT iterations: N (non-standard)`, so a shortened Run cannot be mistaken for a real one.

### `?postmasterTuning=` — what the postmaster costs on other memory knobs

The `pgrust Postmaster` columns are the only ones whose memory is a set of choices rather than a
property of the Engine. A postmaster is a shared `WebAssembly.Memory` with a guest thread stack
carved out of it for every child Postgres would have forked, and a live host Worker standing by for
each of those threads, so three numbers decide what one Run costs a tab: the pool's base size, the
memory's initial claim, and `max_stack_depth`, which on wasm sizes every child stack rather than
merely guarding recursion. All three are Engine defaults, and `?postmasterTuning=` moves them for a
Run without rebuilding the app:

| Entry             | Moves                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pool:<n>`        | Pool slots for the server itself, before the one added per Session. Default 8, the measured minimum: 7 refuses the spawn.                                                                                                              |
| `initial:<bytes>` | The shared memory's initial claim. Default 256 MiB, which is also the wasm module's own declared minimum — a smaller claim is a `LinkError`, and a module linked smaller was measured as a boot that traps or takes the renderer down. |
| `name=value`      | A GUC, appended to the postmaster's argv as `-c name=value` and therefore winning its duplicate.                                                                                                                                       |

`?postmasterTuning=pool:12,max_stack_depth=60000` is the server this repo's tables were produced
with before [the memory diet](docs/results/2026-09-08-webkit-memory-diet.md). Like the two overrides
above it is never silent: the environment header and every Markdown export carry
`postmaster tuning: … (non-standard)`.

A `name=value` entry also overrides the three store settings every postmaster has booted with since
2026-09-24: `wal_init_zero=off` and `wal_buffers=4MB`, and `fsync=off` unless the store's durability
is `strict` (the store factory's `strict` mode keeps `fsync=on` beside `synchronous_commit=on`).
`?postmasterTuning=wal_init_zero=on,wal_buffers=-1,fsync=on` is the server as it was before them;
[the store-levers note](docs/results/2026-09-24-store-levers.md#adopted-2026-09-24) has what each one
bought and what it gives up.

## pgrust assets

PGlite installs from npm; pgrust does not. Its host JavaScript is vendored into this repo and
committed; its ~131 MB of wasm build assets are not, so the eight pgrust columns need one setup
step — the one in the [quick start](#quick-start-from-a-clone).

There are **two wasm modules from one pgrust commit**: `postgres.wasm` (`wasm32-wasip1`) for the two
`pgrust` columns and `postgres-threads.wasm` (`wasm32-wasip1-threads`) for the four `pgrust Threads`
and two `pgrust Postmaster` columns. They share `vfs.img`/`vfs.json`, because the packed image is
`initdb` output and carries no pgrust code and no target. Beside them travels one thing that is not
pgrust at all: the **pre-release store bundle** the four broker and postmaster columns load, MIT
licensed, from a pgxsinkit checkout that a cloner has no reason to have — so it is published with
the assets rather than left as a second thing to arrange.

> **Which pgrust?** The committed results are built from the pgrust branch
> [`spike/wasip1-threads`](https://github.com/pgxsinkit/pgrust/tree/spike/wasip1-threads)
> (commit `08a30644`, on top of upstream `438c8c42`), which carries both the fix from
> [finding 0001](docs/findings/0001-pgrust-multi-statement-memory.md) — stock pgrust cannot finish
> the Speedtest Suite on wasm32 — and the `wasm32-wasip1-threads` host the two Threads columns run
> on. `src/vendor/pgrust/VERSION` and the environment header always name the exact commit a run
> used, and it is one commit for all four columns.

### Download a published build

```sh
bun run sync:pgrust --release latest                     # newest published build
bun run sync:pgrust --release pgrust-assets/dab0f929     # a specific one
```

That needs no pgrust checkout, no Rust toolchain and no pgxsinkit checkout. The assets are published
as **GitHub Release assets of this repo**, one release per pgrust commit, tagged
`pgrust-assets/<short-commit>` — the tag names the exact pgrust the binaries were built from. The
download is ~30 MB gzipped and unpacks to ~135 MB in `public/pgrust/`; every file is verified against
the release's `SHA256SUMS` **and** against the unpacked sizes and digests in its `manifest.json`
before anything is written, and a release that fails to verify leaves `public/pgrust/` untouched.

Five assets: `postgres.wasm.gz`, `postgres-threads.wasm.gz`, `vfs.img.gz`, `vfs.json` and
`pglite-opfs-repacked.js.gz` — the pre-release store bundle, which the sync installs at
`public/pgrust/host/vendor/pglite-opfs-repacked.js`, where the vendored `broker-fs.js` looks for it.

Two of the five are **optional**, both because they arrived after the first releases were published:
`postgres-threads.wasm` and the store bundle. A release from before either is still a complete,
verifiable set for the columns that existed then, so downloading one succeeds, removes any stale copy
rather than leaving two commits side by side, and says which columns will report the asset missing —
for the store bundle, that it is the four broker and postmaster ones and that a pgxsinkit checkout
can supply it instead.

The release also updates `src/vendor/pgrust/VERSION` and the assets section of
`src/vendor/pgrust/SOURCE.md`, but deliberately **not** the vendored host JavaScript — releases carry
binaries, and the JS is committed here. If the two end up on different pgrust commits the sync says
so loudly rather than letting the column measure one commit's JS against another's wasm.

pgrust is AGPL-3.0. Each release names the complete corresponding source — repository, branch,
commit, upstream base and the exact build recipe — in its notes and in `manifest.json`, and
`SOURCE.md` keeps that record in the tree. The store bundle gets its own record beside it, MIT and
its own repository, rather than being folded into pgrust's statement: package, manifest version,
pgxsinkit commit, branch and the one command that rebuilds it. That record is written identically
whether the bundle came from a release or from a checkout, so a clone's `SOURCE.md` and a
maintainer's can be compared line for line.

`PGLITE_V_PGRUST_RELEASE_REPO` reads the releases of a different repo;
`PGLITE_V_PGRUST_RELEASE_BASE_URL` fetches the assets from a directory URL instead of GitHub (the
release list has no meaning there, so `latest` needs a real tag).

### Building your own

Build the assets in a pgrust checkout:

```sh
cd ../pgrust
PGRUST_WASM_PROFILE=wasm-release wasm/wasm-build.sh    # postgres.wasm (wasm32-wasip1)
wasm/build.sh                                          # packs vfs.img + vfs.json beside it
PGRUST_WASM_TARGET=wasm32-wasip1-threads \
  PGRUST_WASM_PROFILE=wasm-release wasm/wasm-build.sh  # postgres-threads.wasm, into target/
```

The threads module is taken straight out of `target/wasm32-wasip1-threads/wasm-release/`: it is the
same source tree built for a second target, and `wasm/build.sh` packs only the default target's
module.

Then sync them into this repo:

```sh
bun run sync:pgrust                 # vendored host JS + public/pgrust/ assets + host runtime
bun run sync:pgrust --vendor-only   # host JS only; skips everything under public/
PGRUST_DIR=/path/to/pgrust bun run sync:pgrust      # non-sibling checkout
PGXSINKIT_DIR=/path/to/pgxsinkit bun run sync:pgrust  # non-sibling store-bundle checkout
```

The script does four things:

1. Copies the vendored host JS — `pgrust-wasi.js`, `wiresession.js`, `wire.js`, the five files of the
   threads host (`threads-host.js`, `thread-worker.js`, `sab-pipe.js`, `broker-fs.js`,
   `storage-worker.js`), `LICENSE` and `NOTICE` — into `src/vendor/pgrust/` (committed), and writes
   the synced commit to `src/vendor/pgrust/VERSION`, which the environment header reports.
2. Copies `postgres.wasm`, `postgres-threads.wasm`, `vfs.img` and `vfs.json` into `public/pgrust/`
   (gitignored, ~134 MB).
3. Lays the threads host out again under `public/pgrust/host/`, served verbatim — see
   [the vendored threads host](#the-vendored-threads-host).
4. Copies the **pre-release** `@pgxsinkit/pglite-opfs-repacked` bundle the broker columns load out of
   a pgxsinkit checkout into `public/pgrust/host/vendor/`, and records its commit in `SOURCE.md`. If
   that checkout is not there the script says so and carries on: only those four columns need it, and
   `--release` brings the same bundle down from the release instead — a release that carries it is
   never overwritten from a checkout.

Run it again after every pgrust rebuild. This is also the only way to update the vendored host JS:
`--release` never touches it.

Without the assets the app still builds and the PGlite columns still run; each pgrust column reports
its own fetch failure in its header.

### Browser requirements

pgrust runs a single long-lived `postgres --stdio-wire` instance and suspends the guest on its
blocking stdin read, which needs **JS Promise Integration** (`WebAssembly.Suspending` plus
`WebAssembly.promising`):

| Browser        | JSPI        | pgrust column    |
| -------------- | ----------- | ---------------- |
| Chrome / Edge  | 137+        | runs             |
| Firefox        | 153+        | runs             |
| Safari         | 27+         | runs             |
| Anything older | unavailable | reported skipped |

The header shows whether JSPI was detected. Where it is missing the pgrust column is greyed out with
that reason and the PGlite columns run as normal — no Run is aborted for it.

The four `pgrust Threads` columns and the two `pgrust Postmaster` columns need the opposite thing.
Their build spawns real threads and blocks on `Atomics.wait`, so they need **no JSPI at all** — what
they need is `SharedArrayBuffer` and a shared `WebAssembly.Memory`, which every browser gates on
[cross-origin isolation](#cross-origin-isolation) (and, for the three whose store is on OPFS, a
synchronous access handle as well):

| Browser                        | `crossOriginIsolated` under COOP+COEP | pgrust Threads and Postmaster columns |
| ------------------------------ | ------------------------------------- | ------------------------------------- |
| Chrome / Edge, Firefox, Safari | yes                                   | run                                   |
| Anything that withholds it     | no                                    | reported skipped                      |

The header shows the answer as `cross-origin isolated yes|no`. Because this repo serves both headers
from every server it owns, a `no` there is a browser withholding them, not a missing server config.

## Cross-origin isolation

Every server that serves this page sends both isolation headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`vite.config.ts` sets them for `bun run dev` and `bun run preview`; `scripts/bench.ts`'s own static
server sets the same pair, because the headless lane serves `dist/` itself rather than through Vite.
The page reports the result — `cross-origin isolated yes|no` — in the environment header and in every
Markdown export, so a run that silently lost isolation cannot be mistaken for one that had it.

Isolation is what makes `SharedArrayBuffer` and a shared `WebAssembly.Memory` available at all, and
they are the whole of the pgrust threads build (see [the columns](#the-columns)). It costs the other
Configurations nothing: `require-corp` only constrains **cross-origin** subresources, and this page
loads none — PGlite's `pglite.wasm` and `pglite.data`, wa-sqlite's `wa-sqlite.wasm`, the pgrust
assets and every worker are all served from this origin. There is no CDN script, no hosted font and
no remote image anywhere in `index.html` or in the built `dist/`.

One host cannot send a header at all: [GitHub Pages](#github-pages). There `index.html` registers
[`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker), a service worker that re-serves
every response with the same pair from inside the page, and the columns run on that instead. It is
registered **only** where `window.crossOriginIsolated` is already `false`, so on `bun run dev`,
`bun run preview` and the bench lane — all of which send the real headers — it is never fetched, let
alone installed. `bun run bench --plain` serves `dist/` without the headers on purpose and is the
test of that path.

## Using the engine from another app

The pgrust postmaster in this repo is not only a benchmark column. It also answers **pgxsinkit's
local-store seam**, so a pgxsinkit app — the `apps/board` demo above all — can be driven against
pgrust instead of PGlite without a line of engine-specific code landing in that repo.

The seam has **two ways in, and both take the same module**. `VITE_BOARD_STORE_FACTORY=<absolute
module URL>` bakes one engine into one build; the login screen's **Store engine** preference picks one
at run time, with no rebuild, out of a **drop-in** directory the app serves from its own origin. Either
way the board `import()`s that module and takes its **default export** as
`(storePath: string, backendOverride?: "memory") => Promise<ClientPGlite>`; every local store the app
opens is then minted by it (see `apps/board/docs/local-store-seam.md` in pgxsinkit). It passes a plain
store **name** and nothing else — no asset base, no storage layout — so the module owns all of that.
`src/client/pgrust-browser-factory.ts` is that module on this engine:

- **its own assets**, from `import.meta.url`: whatever URL the bundle is served from, `./pgrust/` sits
  beside it;
- **its own storage layout**: `opfs://<name>` opens the OPFS directory pgxsinkit's store-path contract
  implies — `pgxsinkit/stores/<identity>` — so the store lands where the toolkit looks for one;
- **its own boot**: the postmaster starts _inside the worker that called the factory_, with the thread
  pool and the storage coordinator as nested workers. It is the same
  `src/client/pgrust-browser-engine.ts` the `pgrust Postmaster` column runs — one boot, two drivers.

### Package it

```bash
bun run sync:pgrust                                   # once: the wasm, the image, the host runtime
bun run engine:package --into <app>/public/store-engine
```

That builds the bundle (`bun run engine:build` → `dist/store-engine/pgrust-store-factory.js`, one
self-contained ESM file with PGlite's `BasePGlite`, the `live` extension and the wire codec inside it)
and copies it plus everything it fetches at run time into the directory you name:

```
<dir>/manifest.json                 how the drop-in names itself: `{ "factory", "name" }`
<dir>/pgrust-store-factory.js       the seam module — its default export is the factory
<dir>/pgrust/postgres-threads.wasm  the wasm32-wasip1-threads Postgres
<dir>/pgrust/vfs.img, vfs.json      the packed image a fresh store is seeded from
<dir>/pgrust/host/                  pgrust's host runtime, loaded by URL and never bundled
<dir>/pgrust/LICENSE, NOTICE        pgrust is AGPL-3.0; the notice travels with the binary
```

`manifest.json` is **required**, and writing it is the engine's job rather than the app's: the board
will not guess a bundle's file name, because knowing one would be precisely the engine-specific
knowledge the seam exists to keep out of that repo. A directory without a manifest is not a drop-in —
the preference is simply not offered, and the board behaves as if nothing had been laid down. This
script writes it with the factory's file name and a label taken from `src/vendor/pgrust/VERSION` (and
the branch `SOURCE.md` records, or the fork's default):

```json
{
  "factory": "pgrust-store-factory.js",
  "name": "pgrust df11a1dd (spike/wasip1-threads)"
}
```

It then prints that manifest and the exact variable to set. The directory is ~88 MB, so a `public/`
one that the app's repo ignores is the right place for it.

### Serve it, and point the app at it

```bash
VITE_BOARD_STORE_FACTORY=http://localhost:5173/store-engine/pgrust-store-factory.js \
VITE_BOARD_ISOLATED=1 bun run build      # in apps/board
VITE_BOARD_ISOLATED=1 bun run preview    # 5173
```

Or bake nothing at all and let the person at the keyboard choose: with the drop-in served, the login
screen offers **Store engine → External (pgrust …)**, read from the manifest above. Apply obsoletes
the current stores and reloads, so fresh ones mint under the new declaration — a datadir belongs to
the engine that wrote it, and the other engine will not open it.

```bash
VITE_BOARD_ISOLATED=1 bun run build      # in apps/board — no factory variable
VITE_BOARD_ISOLATED=1 bun run preview    # 5173, then pick the engine on the login screen
```

Two things are not optional:

- **Same origin.** The host runtime builds its workers with `new Worker(url)`, which refuses a
  cross-origin script. Serving the directory from the app's own origin (a vite `public/`
  subdirectory) is the whole answer; a cross-origin module would additionally need CORS and
  `Cross-Origin-Resource-Policy: cross-origin` under the isolation headers.
- **Cross-origin isolation.** `VITE_BOARD_ISOLATED=1` makes the app serve COOP `same-origin` +
  COEP `require-corp` on **every** response, which is what puts `SharedArrayBuffer` and a shared
  `WebAssembly.Memory` in the engine's worker as well as in the page. It gates the preference route
  outright: an engine is only OFFERED on a cross-origin-isolated page, because a threaded one served
  without those headers could do nothing but refuse to construct. See
  [Cross-origin isolation](#cross-origin-isolation).

There is a third requirement the factory enforces rather than documents: it must run **in a worker**.
Its store client blocks in `Atomics.wait`, which a window's main thread may not do, so pgxsinkit's
in-process (main-thread) engine home cannot host it — the elected dedicated worker of ADR-0049 can.
Called on the main thread it throws saying so, instead of deadlocking.

### Two things the seam's contract does not say, and both bite

Found by running pgxsinkit's board on this engine end to end. Neither is engine-specific; anything
answering that seam with a persistent OPFS store owes both.

1. **Brand the instance `Symbol.for("pgxsinkit.opfsRepackedPersistent")`.** The toolkit runs its
   commitment barrier — `strictSync()`, then a sentinel, then the store's meta record at
   `opfs-committed` — on an ADOPTED store only when that brand is present (`resolveAdoptedCommitmentBarrier`
   gates on it, because its own OPFS store reports no `dataDir` and nothing else identifies one). An
   unbranded store stays at `opfs-candidate` for its whole life, and the NEXT boot reads that as a torn
   candidate and **deletes the directory**. The symptom is a first visit that works perfectly and a
   reload that says `Could not start the local sync engine: Failed to execute 'removeEntry' … modifications
are not allowed`. `attachPgrustClient` stamps it for every `opfs://` store.

2. **Be patient with a store its last owner has not released.** A repacked store owns its OPFS files
   exclusively and releases them when its worker dies — which, after a reload, happens a moment AFTER
   the next page has begun booting. The mint refuses with `StoreOwnedError` inside 300 ms of a reload
   and succeeds a few seconds later, so the engine retries that one failure (six attempts, linear
   backoff) and throws every other storage failure at once.

   Getting this wrong is worse than it sounds: pgxsinkit answers a rejected seam mint by falling back
   to **its own** opfs-repacked PGlite on the same directory — which opens the store with a 64 KiB
   extent size where pgrust's coordinator writes 8 KiB, so the fallback dies on
   `configured extent size 65536 does not match persisted extent size 8192`. A store minted through
   the seam is only ever readable through the seam.

### The one console error that is not this engine's

Driving the board on this engine logs, around a reload:

```
Cannot access 'R' before initialization
    at http://localhost:5173/store-engine/pgrust-store-factory.js:16677:11
```

The frame is in the drop-in; the code is **PGlite's own `live` extension**, bundled into it. `live.query`
registers its `table_change__<schema_oid>__<table_oid>` listeners _inside_ its init transaction, and the
callback they close over calls `refresh` — which is `const`-declared **after** `await init()`. A
notification for that channel delivered before that assignment runs, which is exactly what a
`NotificationResponse` riding back on a reply inside that same transaction is, calls it in its temporal
dead zone. `R` is `refresh`: the published package is minified and the bundler kept the name.

None of it is the bundle and none of it is pgrust. The bundle evaluates clean in a fresh module worker
on an isolated page, twice over, and the fault reproduces in bun on stock PGlite in memory — no
bundler, no engine of ours — by calling the callback the moment `listen` registers it:

```ts
const original = pg.listen.bind(pg);
pg.listen = async (channel, callback, tx) => {
  const unsubscribe = await original(channel, callback, tx);
  await callback(""); // ReferenceError: Cannot access 'R' before initialization.
  return unsubscribe;
};
await pg.live.query("SELECT id FROM t ORDER BY id", []);
```

It costs one dropped refresh — the update that landed while that query was being set up waits for the
next notification — and nothing else: the store is fine and the board boots. The fix is a hoist in
`packages/pglite/src/live/index.ts`, declaring `refresh` before the `init` that closes over it, and it
belongs in the PGlite fork this repo pins (`@electric-sql/pglite` → `@pgxsinkit/pglite`), not here.

### Prove it is actually the one that answered

A store minted by this factory says so, on the console of the worker that minted it and on a
`BroadcastChannel` named `pgrust-store-factory` that any page or worker can read:

```js
new BroadcastChannel("pgrust-store-factory").onmessage = (event) => console.log(event.data);
// { kind: "pgrust-store-minted", storePath: "…", dataDir: "opfs://…",
//   opfsDir: "pgxsinkit/stores/…", version: "PostgreSQL 18.0 on wasm32-wasip1-threads…",
//   restored: false, elapsedMs: 4210 }
```

`version` is the server's own `SELECT version()` — the only honest way to know which engine answered,
because a silent success looks exactly like the built-in PGlite one. `restored` is `false` on the
first mint of an OPFS directory and `true` on every one after it, which is what a reload proves.

## GitHub Pages

<https://pgxsinkit.github.io/pglite-v-pgrust/> — the same page, the same fourteen columns, nothing to
install. Everything is measured in your browser; the site is static and stores nothing anywhere else.

Two things about a first visit:

- **It reloads once.** Pages cannot send a response header, so the page has to earn cross-origin
  isolation from inside: `coi-serviceworker` installs on the first load and reloads once, and the
  header then reads `cross-origin isolated yes` (see [above](#cross-origin-isolation)). Every later
  visit is one load. The service worker exists only on hosts that send no headers — never on
  `bun run dev`, `bun run preview` or the bench lane.
- **The pgrust columns are a large download.** `postgres.wasm`, `postgres-threads.wasm` and
  `vfs.img` are ~134 MB unpacked, fetched on first use and then cached by the browser. The eight
  PGlite and wa-sqlite columns need none of it.

On **Safari** the page is the diagnosis: every Configuration it cannot run says why in its own
column header, and the ones it can run still run. Safari grants the OPFS synchronous access handle
the four repacked-store columns need, and the service worker gives the six threads and postmaster
columns their isolation; the two single-session `pgrust Memory` columns additionally need
[JSPI](#browser-requirements), which is Safari 27+, and report themselves skipped where it is
missing. The environment header states all three answers — `JSPI available|unavailable`,
`cross-origin isolated yes|no`, `OPFS sync access available|unavailable` — and they travel with
every "Copy as Markdown" export.

### Deploying it

`.github/workflows/pages.yml` runs on every push to `main` and on manual dispatch. It installs,
runs `bun run sync:pgrust --release latest`, builds with `BASE_PATH=/pglite-v-pgrust/` and uploads
`dist/`. It runs no test, no bench and no browser: a deploy that ran the Suites would be measuring a
GitHub runner.

`BASE_PATH` is why the deployed page works at all. A project site is served from `/<repo>/`, and
every URL the page builds at run time — the pgrust assets, the vendored host modules the threads
Engines `import()` by URL, every worker — goes through `import.meta.env.BASE_URL`. Locally,
`bun run bench --base /pglite-v-pgrust/` builds and serves the same shape, which is how that stays
true.

The site is built from a **release**, not from a checkout, so publishing new pgrust assets is what
puts a new pgrust build on the page:

```sh
bun run pgrust:bundle                        # package public/pgrust/ and print the gh command
gh release create pgrust-assets/<commit> …   # what it printed, after reading NOTES.md
git push origin main                         # or run the Pages workflow by hand
```

One setting, once: **Settings → Pages → Source: GitHub Actions**. The workflow needs no secret —
`GITHUB_TOKEN` is the automatic one, and it is used only to keep the release-list API call off the
shared unauthenticated rate limit.

## Development & contributing

Scripts are check-default: a bare verb never mutates files.

| Script                   | What it does                                     |
| ------------------------ | ------------------------------------------------ |
| `bun run dev`            | Vite dev server on port 5580                     |
| `bun run build`          | Production build into `dist/`                    |
| `bun run preview`        | Serve the production build                       |
| `bun run format`         | oxfmt, check only                                |
| `bun run format:write`   | oxfmt, rewrite files                             |
| `bun run lint`           | oxlint (type-aware), check only                  |
| `bun run lint:fix`       | oxlint with autofixes applied                    |
| `bun run typecheck`      | `tsc --noEmit`                                   |
| `bun run test`           | `bun test src scripts` — unit tests only         |
| `bun run check`          | typecheck + lint + test                          |
| `bun run validate`       | format + check; installed as the pre-commit hook |
| `bun run bench`          | Drive the page headlessly and capture the tables |
| `bun run test:e2e`       | `bun test tests/e2e` — the bench lane, asserted  |
| `bun run validate:full`  | validate + test:e2e                              |
| `bun run sync:pgrust`    | Vendor pgrust's host JS; fetch or copy assets    |
| `bun run pgrust:bundle`  | Package `public/pgrust/` for a release           |
| `bun run engine:build`   | Bundle the store-engine seam module into `dist/` |
| `bun run engine:package` | Drop the store engine into another app's assets  |

`bun install` runs `prepare`, which points `core.hooksPath` at `.githooks/`, so `bun run validate`
gates every commit.

### Publishing pgrust assets

`bun run pgrust:bundle` turns whatever is in `public/pgrust/` into a publishable release:

```sh
bun run pgrust:bundle          # --help lists every field of the source statement
```

It reads the pgrust commit from `src/vendor/pgrust/VERSION` and `SOURCE.md` (and refuses a `-dirty`
one — a build from a working tree no one can check out has no publishable source), gzips
`postgres.wasm`, `postgres-threads.wasm`, `vfs.img` and the store bundle at level 9, and writes
`tmp/pgrust-assets/<tag with the slash flattened>/`: the five assets, `SHA256SUMS`, `manifest.json`
and `NOTES.md`. The tag is `pgrust-assets/<first 8 of the commit>`.

The store bundle's own source statement is read back out of `SOURCE.md`'s store block, which the sync
wrote when it installed the bundle — a published provenance nobody checked is a provenance nobody
should trust — and a bundle copied from a dirty pgxsinkit tree is refused exactly as a dirty pgrust
one is. `--store-branch`, `--store-commit`, `--store-version` and `--store-repo` override it.

The rest of the source statement — branch, upstream base, cargo profile, **both** targets,
toolchain, the `initdb` that minted `vfs.img` — cannot be read off the built files, so it comes from
flags whose defaults describe the assets currently in tree (`--target` for `postgres.wasm`,
`--threads-target` for `postgres-threads.wasm`). Anything rebuilt differently must say so on the
command line; a guess in an AGPL source statement is worse than no statement. The threads target is
claimed only when the threads module is really in the bundle, and `NOTES.md` then carries both build
recipes.

Nothing is uploaded. The script prints the `gh release create` line — tag, title, `--notes-file
NOTES.md`, the seven files — for a human to read `NOTES.md` and then run.

### Headless lane

`bun run bench` runs the page for you: it builds, serves `dist/` over loopback on a free port, opens
it in a real browser, presses each Suite's **Start**, waits for the Suite section to report
`data-state="complete"`, and captures exactly the Markdown the "Copy as Markdown" button produces.

The lane times nothing. Every Measurement is still taken inside the Engine's worker by the app
itself, so a headless result and a hand-run result are the same result.

The page runs in a **persistent** browser context on a fresh profile made for the Run under
`tmp/bench-profiles/` (repo-local, on the real disk) and removed after it, so OPFS is files on disk
as it is in anyone's own browser. Until 2026-09-24 the lane used Playwright's off-the-record
`browser.newContext()` instead, where Chromium keeps OPFS in memory in the browser process and
every access-handle call is a round trip to it; `--ephemeral-context` is that lane, kept so the
older tables can be reproduced ([what changed](docs/results/2026-09-24-persistent-context.md)). The
results file's header names the context a Run used.

```sh
bun run bench                                # all three Suites, Chromium, fresh build
bun run bench --suite rtt --iterations 5     # one Suite, deliberately short RTT Run
bun run bench --suite concurrency            # the Concurrency Suite on its own
bun run bench --browser firefox --no-build   # reuse the existing dist/
bun run bench --help                         # every flag, and every Configuration id

# exactly what GitHub Pages serves: a subpath build, and no isolation headers
bun run bench --base /pglite-v-pgrust/ --plain --suite rtt --iterations 3

# three columns, ratios against the OPFS one
bun run bench --suite rtt \
  --configurations pglite-memory,pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed \
  --baseline pglite-opfs-repacked-relaxed
```

| Flag                       | Meaning                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `--browser <name>`         | `chromium` (default), `firefox` or `webkit`                                                   |
| `--suite <id>`             | `speedtest`, `rtt` or `concurrency`; repeatable, defaults to all three                        |
| `--iterations <N>`         | Passes `?rttIterations=N` to the page; 1-1000                                                 |
| `--configurations <id,id>` | Passes `?configurations=` to the page: only these columns, in Configuration order; repeatable |
| `--baseline <id>`          | Passes `?baseline=` to the page: the column every ratio is taken against                      |
| `--ephemeral-context`      | The pre-2026-09-24 lane: an off-the-record context, OPFS in memory in the browser process     |
| `--keep-profile`           | Leave the persistent context's profile in `tmp/bench-profiles/` after the Run                 |
| `--no-build`               | Reuse the existing `dist/` instead of rebuilding                                              |
| `--base <path>`            | Build with that `BASE_PATH` and serve under it — the [Pages](#github-pages) shape             |
| `--plain`                  | Serve without COOP/COEP, as Pages does; the page's service worker has to earn isolation back  |
| `--port <N>`               | Port for the local static server; the default asks for a free one, never 5580                 |
| `--headed`                 | Show the browser window                                                                       |
| `--timeout <ms>`           | Overall in-browser deadline (default 2400000)                                                 |
| `--out <dir>`              | Results directory (default `tmp/results`)                                                     |

`--configurations` and `--baseline` are the page's own two query parameters and nothing more, so a
narrowed headless run and a hand-driven one are the same run. Both are validated before the browser
is launched: an id that names no Configuration, or a Baseline outside the selection, exits 2 with a
message listing the ids that would have worked (`bun run bench --help` lists all fourteen). What the
CLI cannot know is which Configurations _this browser_ can run — the page drops those, and says so in
the `Configurations (N of 14): … | Baseline: …` line of every table it exports.

Each run writes `tmp/results/<ISO-timestamp>-<browser>.md` (gitignored) and prints the same content:
the browser context, the environment line, one table per Suite, and any Run failure the page
reported — which is what turns a bare `failed` cell into a diagnosis.

The browsers are Playwright's own builds, driven through its library API; there is no Playwright
config and no second test runner. Install them once with `bunx playwright install chromium firefox`.
`@playwright/test` is pinned to an exact version because a Playwright release pins the browser
revisions it will look for — floating it would silently ask for builds that are not in the cache.

| Browser in the lane           | Behaviour                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium (default)            | JSPI on by default, cross-origin isolation from the lane's own server and synchronous access handles granted in dedicated workers, so all fourteen Configurations run — every Suite, the Concurrency Suite included                                                                                                                                       |
| Firefox (`--browser firefox`) | The lane sets `javascript.options.wasm_js_promise_integration`; where JSPI is still missing the two `pgrust` Configurations are unavailable, so they are unticked and the table is drawn without them — the Configurations panel carries the reason. Firefox's reduced timer precision quantises Measurements, so its numbers are coarser than Chromium's |
| WebKit (`--browser webkit`)   | Exits 0 with `WebKit skipped: Playwright's WebKit build has no JSPI yet`, without launching. That build also refuses synchronous access handles in both worker kinds, so it could contribute neither the pgrust nor the OPFS columns                                                                                                                      |

`bun run test:e2e` drives the same lane from `bun test` (Chromium, all three Suites, RTT at three
iterations) and asserts the shape of the result rather than any timing: an environment line that says
`cross-origin isolated yes` — the lane serves both headers, so anything else is a lane bug — column
headers in Configuration order so the positional assertions cannot drift, a millisecond figure and a
ratio in every PGlite Memory and wa-sqlite cell, and `skipped`, `failed` or a millisecond figure in
every pgrust, pgrust Threads, postmaster and OPFS cell. For the Concurrency Suite it also asserts the
Suite's own header line, the Detail block under the table, and each column's Concurrency mode in the
header it exports — `interleaved on one session` on the four single-session Engines,
`one backend per Client` on the postmaster. The Reference Engine is held to the stricter rule on
purpose — it needs no JSPI, no synchronous access handle and no asset that can be missing, so a cell
without a number in it is a harness bug rather than a browser or a build state. It is deliberately outside `test`, `check` and `validate` — `bun run
validate:full` is `validate` plus this lane.

Everything in `src/` is TypeScript with one sanctioned exception: `src/vendor/pgrust/*.js` is copied
**byte-verbatim** from a pgrust checkout by `bun run sync:pgrust` (provenance in
`src/vendor/pgrust/SOURCE.md`). Those files must never be edited, reformatted or linted here — pgrust
is upstream, and any change would silently fork the thing being benchmarked — so `src/vendor/` is in
the `ignorePatterns` of both `.oxlintrc.jsonc` and `.oxfmtrc.jsonc`. The `.d.ts` files beside them are
ours, hand-written, and are what makes the vendored JavaScript type-check under `allowJs: false`.

### The vendored threads host

The three single-session host files are imported statically and bundled by Vite. The five threads
host files cannot be, and are **served instead of bundled**:

- `threads-host.js` builds its workers from URLs it computes at run time — `threadWorkerUrl(base)`
  and `storageWorkerUrl(base)`, both `new URL("./x", base)` where `base` is whatever asked. Vite only
  rewrites the literal `new Worker(new URL("./x", import.meta.url), { type: "module" })` form, so a
  bundled `threads-host.js` would resolve `./thread-worker.js` against a hashed chunk name and 404.
- Making it fit that form means editing a vendored file, which is the one thing that must not happen:
  those bytes are what is being benchmarked.

So `bun run sync:pgrust` copies them (plus `pgrust-wasi.js`, which `threads-host.js` imports) from
`src/vendor/pgrust/` into `public/pgrust/host/`, where Vite serves them verbatim in `dev` and copies
them into `dist/` for `preview` and the bench lane. `pgrust-threads.worker.ts` loads them with a
single `import(/* @vite-ignore */ url)` of a run-time URL, and their own relative imports then
resolve inside that directory exactly as they do in pgrust's `wasm/` tree. The committed copy under
`src/vendor/pgrust/` stays the source of truth: `public/pgrust/host/` is generated from it, and the
`.d.ts` files are what `import()` is typed against.

Adding an Engine is additive: write `src/engines/<engine>/<engine>.worker.ts` against the message
protocol in `src/engines/protocol.ts`, register its worker factory in `src/engines/registry.ts`, give
it a SQL dialect in `src/engines/contract.ts`, and add its Configuration to `src/configurations.ts`.
Engine-specific open settings go under that Engine's own key in `EngineOpenOptions` — `wasqlite` for
the journal mode, `pglite` for the store and its durability, `pgrustThreads` for the filesystem seam,
the store's port and its durability, `pgrustPostmaster` for the port and durability of the
postmaster's store — so one Engine's knob can never reach another's constructor.
Everything this app puts in OPFS goes through `src/opfs.ts`, which keeps it under one owned prefix
and takes it away again; the one thing that cannot sit inside that prefix directory is a store the
vendored pgrust coordinator opens, which gets a root-level directory carrying the prefix in its name
(`opfsOwnedRootDirectory`) instead.
The dialect is read only by `Suite.initialSetupFor(dialect)`, which is what a Suite's untimed setup
comes from; no Benchmark is ever rewritten for an Engine. Whether a Configuration can run is decided at
runtime in `src/engines/availability.ts` rather than stored on the Configuration; a Configuration that
cannot run, or whose Run fails, greys out its own column and leaves the others alone.

The Speedtest Suite's `.sql` files are held byte-identical to PGlite's copies;
`src/suites/speedtest/speedtest.test.ts` proves it when a PGlite checkout is present (point
`PGLITE_BENCHMARK_SRC` at one, or let the test skip).

Vocabulary used throughout the code and UI — Engine, Configuration, Suite, Benchmark, Measurement,
Run — is defined in [CONTEXT.md](CONTEXT.md).

## Attributions

- The benchmark workloads originate in the
  [wa-sqlite benchmarks](https://rhashimoto.github.io/wa-sqlite/demo/benchmarks.html), Copyright 2021
  Roy T. Hashimoto, MIT licensed.
- [wa-sqlite](https://github.com/rhashimoto/wa-sqlite) itself, Copyright 2021 Roy T. Hashimoto, MIT
  licensed, is used unmodified as the Reference Engine. It is installed from the exact upstream tag
  `v1.1.2` rather than from npm, whose latest publication is `1.0.0`; only its committed
  `dist/wa-sqlite.mjs` + `dist/wa-sqlite.wasm` (the synchronous build) and `src/` are used. The
  `.d.ts` in `src/engines/wasqlite/` is ours: upstream declares its API and `src/VFS.js` but no
  longer declares the example VFS modules.
- They were adapted for Postgres by the [PGlite](https://github.com/electric-sql/pglite) authors
  (ElectricSQL), Apache-2.0 licensed; the SQL and statement lists here are byte-identical ports of
  PGlite's copies.
- [`@pgxsinkit/pglite-opfs-repacked`](https://www.npmjs.com/package/@pgxsinkit/pglite-opfs-repacked),
  MIT licensed, is the OPFS store the two Storage Configurations run on, installed from npm and used
  unmodified. It declares a peer dependency on `@electric-sql/pglite`, which is why PGlite is
  installed here under that name (see [PGlite, once](#pglite-once)).
- [pgrust](https://github.com/malisper/pgrust) is AGPL-3.0 licensed. Its browser host JavaScript —
  both the single-session host and the `wasm32-wasip1-threads` host — is vendored byte-verbatim under
  `src/vendor/pgrust/`, together with its `LICENSE` and `NOTICE`; the synced commit is recorded in
  `src/vendor/pgrust/SOURCE.md`. The wasm binaries published from this repo's `pgrust-assets/*`
  releases are built from
  [`pgxsinkit/pgrust@spike/wasip1-threads`](https://github.com/pgxsinkit/pgrust/tree/spike/wasip1-threads),
  and each release names its exact commit, upstream base and both build recipes as the complete
  corresponding source.
- The four broker and postmaster columns additionally load a **pre-release** build of
  `@pgxsinkit/pglite-opfs-repacked` — the sync broker and WASI adapter are in no published version —
  published as an asset of this repo's `pgrust-assets/*` releases and, when you are building one,
  copied out of a pgxsinkit checkout by `bun run sync:pgrust`. Either way its commit, branch and
  build recipe are recorded in `src/vendor/pgrust/SOURCE.md` and in the release's `manifest.json`. It
  is MIT licensed like the published package.
- [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker), Copyright Guido Zuidhof and
  contributors, MIT licensed, is what gives the deployed page [cross-origin
  isolation](#cross-origin-isolation) on a host that cannot send headers. It is installed from npm
  and copied unmodified — banner and all — from `node_modules/` into `dist/coi-serviceworker.js` at
  build time, because a service worker only controls the directory it is served from and a hashed
  asset would sit one directory too deep.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
