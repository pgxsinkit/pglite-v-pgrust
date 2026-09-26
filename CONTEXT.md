# pglite-v-pgrust

A browser benchmark that runs the same SQL workloads against PGlite and pgrust (both WebAssembly Postgres builds), with wa-sqlite as a calibration reference, and reports the timings side by side.

## Language

**Suite**:
A named, fixed list of Benchmarks run in order against one Engine. There are exactly four: the Speedtest Suite, the RTT Suite, the Concurrency Suite and the Prepared Suite.
_Avoid_: test set, benchmark set (a **Scenario** is a different thing: one Benchmark's script)

**Speedtest Suite**:
The 16 SQL scripts ported from the SQLite speedtest via wa-sqlite and PGlite, byte-identical to PGlite's copies; one timing per script.
_Avoid_: wa-sqlite benchmarks, SQLite benchmarks

**RTT Suite**:
Twelve single-statement CRUD queries each executed 100 times; reports the per-statement round-trip time as a trimmed mean (lowest and highest 10% of Measurements discarded), exactly as PGlite does.
_Avoid_: latency suite, CRUD suite

**Concurrency Suite**:
Five Benchmarks run by N Clients at once (four by default) against one 100,000-row indexed table built in the untimed setup: a read fan-out, a reader under a bulk write, short queries beside a long one, writers on disjoint rows and writers on the same row. Each row reports one headline number — a wall time, a percentile or a rate — and its Detail. Every Engine runs it. What concurrency _is_ differs per Engine and is the thing being reported, so every column's header states its **Concurrency mode**.
_Avoid_: parallel suite, contention suite, multi-client suite

**Prepared Suite**:
The Speedtest's statement-heavy rows sent as one `PREPARE` per shape followed by an `EXECUTE` per statement, so a Benchmark measures a reused plan: rows 1, 2, 3, 7, 8, 9 and 10, with the Speedtest's own statements and values. Each row's `PREPARE`, and the tables and indexes the row needs, are sent untimed just before it, the `PREPARE` as a short text of its own; its `DEALLOCATE` just after. Byte-identical for every Postgres Engine; wa-sqlite's columns are skipped, because SQLite has no `PREPARE`.
_Avoid_: prepared speedtest, plan-cache suite, variant A2

**Concurrency mode**:
How an Engine gives N Clients concurrency, stated in every Concurrency Suite column header and carried into the Markdown export. Exactly two: `one backend per Client`, which is pgrust Postmaster giving Client `i` its own Session and therefore its own real backend; and `interleaved on one session`, which is PGlite, both pgrust wire builds and wa-sqlite serving one statement at a time from one place to run SQL, with a transaction holding it from BEGIN to COMMIT. A cell cannot be read without it: a reader p95 of 0.4 ms and one of 670 ms are both correct answers to different questions.
_Avoid_: concurrency level, parallelism, threading model

**Client**:
One scripted program inside a Scenario — a list of Steps — run against one Session, concurrently with every other Client of that Scenario. N Clients is what "concurrent" means in the Concurrency Suite; on an Engine with one Session every Client runs on it, which is exactly the property being measured there.
_Avoid_: worker, thread, connection, user

**Scenario**:
The script one Concurrency Benchmark runs: a list of Clients, an optional per-Session setup and the SQLSTATEs it tolerates. It is data, not code — it crosses the worker boundary by structured clone and a Configuration's SQL rewrite reaches every statement in it — and it yields one Measurement, whose number the Benchmark's own summary picks out.
_Avoid_: workload, script, plan, test case

**Step**:
One entry in a Client's program: a statement, a transaction (every statement of it, committed or rolled back, timed as ONE sample), a repeat of a statement, a statement looped until a Signal, or the raising of a Signal.
_Avoid_: command, instruction, action

**Signal**:
A name one Client raises and others wait on, and the only thing Clients share besides the database. It is how "read until the bulk write finishes" is expressed without either Client knowing how long the other will take. A Client waiting on a Signal always runs its statement at least once.
_Avoid_: flag, event, barrier, latch

**Detail**:
The supporting numbers of a Measurement whose single figure cannot say what happened — per-Client percentiles, statement counts, SQLSTATE counts, the writer's own total. It is rendered under the table in the Markdown export (one line per Configuration per Benchmark) and folded away under the row in the page; never inside a cell, which is one number.
_Avoid_: metadata, extras, breakdown, stats

**Store work**:
What a Configuration's store did while one Measurement ran, counted only when the page is opened with `?brokerStats=1`: on every pgrust Configuration the guest's file calls by kind (bytes, and the ms spent inside them by the Session's backend and by every guest thread), on the Broker ones the requests the coordinator answered and the ms it spent answering, and on every Storage Configuration on OPFS — PGlite's included — the synchronous access handle calls by kind. It is exported as tables of its own under the results table (one row per Benchmark per Configuration, summed over the Benchmark's Measurements), never in a cell and never in a Detail.
_Avoid_: IO stats, broker counts, store counters (the counters are how it is measured, not what it is)

**Store lever**:
A change to how the pgrust Broker's coordinator talks to its Port, switched on for one Run with `?storeLevers=`: `grow` (the arena file grows in 4 MiB chunks and is trimmed back on close) and `coalesce` (contiguous arena writes inside one store call become one access handle write). It is a wrapper around the Port in pgrust's host, never a change to the Store package, so it reaches the pgrust Broker Configurations and no other: a PGlite column in the same Run runs the published Store untouched, and the environment line says `(pgrust columns only)` because a ratio between the two is then not like for like.
_Avoid_: store option, store tuning, store flag (a lever is not a Store setting; the Store does not know it is there)

**Engine**:
One of the WebAssembly databases under comparison: PGlite, pgrust, pgrust Threads, pgrust Postmaster, or wa-sqlite. PGlite and the pgrust Engines are the subjects; wa-sqlite is the Reference Engine.
_Avoid_: database, backend, target, implementation

**pgrust Threads**:
pgrust built for `wasm32-wasip1-threads` rather than `wasm32-wasip1`, from the same commit as the pgrust Engine. Its session runs on a real thread spawned through the guest's own `wasi` `thread-spawn` import over one shared `WebAssembly.Memory`, so its blocking stdin read blocks a Worker in `Atomics.wait` instead of suspending with JSPI — which is why it needs cross-origin isolation and no JSPI, and pgrust needs JSPI and no isolation. A separate Engine, never a mode of pgrust.
_Avoid_: threaded pgrust, pgrust MT, the SAB build

**pgrust Postmaster**:
The `wasm32-wasip1-threads` build again, started as `postgres --host-pipes` — which selects a transport and then falls through to the ordinary `PostmasterMain` — instead of as one `--stdio-wire-threaded` session. What runs is a whole server: a startup process, a checkpointer, a background writer, a WAL writer, a warm standby pool, and one real backend thread per Session. Its filesystem is always the Broker's, because a checkpointer with its own copy of the packed image could not see what the backends wrote. A separate Engine, never a mode of pgrust Threads: it is a different thing to boot, a different pool size (8 plus one slot per Session) and a different shutdown.
_Avoid_: postmaster mode, multi-session pgrust, pgrust server

**Session**:
One pgwire connection to one Engine: on pgrust Postmaster a real Postgres backend on its own guest thread, reached over its own pair of SharedArrayBuffer rings; on every other Engine the one place that Engine has to run SQL. How many a Run opens is the **Suite's** request, not the Configuration's, and the postmaster is the only Engine that can answer with more than one. A Session is not a Run: a Run is one Suite against one Configuration, and it may hold several Sessions.
_Avoid_: connection, client (a **Client** is the scripted program that uses one), backend

**Reference Engine**:
An Engine included only so results can be calibrated against numbers published elsewhere (wa-sqlite's and PGlite's own benchmark pages); never the Baseline of a ratio. It runs every Suite but the Prepared Suite, which SQLite cannot express.
_Avoid_: control, sanity engine

**Baseline**:
The Configuration every ratio is computed against: PGlite Memory by default, and any other selected Configuration a Run chooses (`?baseline=<id>`, or the radio in the page's Configurations panel) — never a Reference Engine one.
_Avoid_: reference, control column

**Configuration**:
An Engine plus the storage and durability settings it is opened with; one selected Configuration is one column of results, and a Run may select any subset of them (`?configurations=<id,id,…>`, or the checkboxes in the page's Configurations panel), always in the order below. There are exactly fourteen: PGlite Memory, PGlite Memory (unlogged), PGlite OPFS repacked (relaxed), PGlite OPFS repacked (strict), pgrust Memory, pgrust Memory (unlogged), pgrust Threads Memory, pgrust Threads Memory (broker, pre-release store), pgrust Threads OPFS repacked (relaxed, pre-release store), pgrust Threads OPFS repacked (strict, pre-release store), pgrust Postmaster Memory (broker, pre-release store), pgrust Postmaster OPFS repacked (relaxed, pre-release store), wa-sqlite Memory, wa-sqlite Memory (journal off).
_Avoid_: setup, mode, variant, column

**Memory Configuration**:
A Configuration whose data directory lives entirely in the worker's heap and is discarded when the worker ends.
_Avoid_: in-memory mode, ephemeral, transient

**Storage Configuration**:
A Configuration whose data directory lives in a Store rather than the worker's heap. It still carries nothing between Runs: the Run empties the Store's directory before opening it and removes it on close, so it measures a cold data directory on real storage.
_Avoid_: persistent mode, OPFS mode, disk configuration

**Store**:
The package a Storage Configuration opens its data directory through, and the durability it is opened with. There is one: `@pgxsinkit/pglite-opfs-repacked`, which packs a whole Postgres data directory into four exclusively owned OPFS files, in either its relaxed or its strict durability. Five columns open it: two through PGlite's own filesystem, two through the pgrust Threads Broker on its OPFS port, and one through the same Broker under a whole postmaster. The same Broker on its **memory** port is a filesystem seam rather than a Store — nothing leaves the worker's heap — so that column is a Memory Configuration.
_Avoid_: VFS, filesystem, backend, persistence layer

**Port**:
Where the Broker's one store physically lives: `memory`, the coordinator worker's heap, which dies with it; or `opfs`, one dedicated OPFS directory the coordinator owns in full. The port is what decides whether a broker column is a Memory or a Storage Configuration, and it is chosen once when the store is opened. A property of a Configuration, never of the Broker.
_Avoid_: storage mode, backend, medium

**Broker**:
The filesystem seam in which one repacked store lives alone in a dedicated coordinator worker and every guest instance reaches it over a SharedArrayBuffer channel, blocking in `Atomics.wait`. Its alternative is the copy seam, where every worker builds its own filesystem from its own copy of the packed image. For pgrust Threads it is a property of a Configuration — three of its four columns are on the Broker, one is on the copy seam — and for pgrust Postmaster it is a property of the Engine, which has no copy seam to offer: a checkpointer thread with its own image would see none of the backends' files.
_Avoid_: shared FS, coordinator mode, broker store

**Pre-release store**:
A build of the Store package taken from a pgxsinkit checkout rather than from npm, because the code a column needs exists in no published version. There is one, loaded by the five Broker columns alone; it is named in each of their labels and its commit is recorded in `src/vendor/pgrust/SOURCE.md`. The two PGlite OPFS repacked columns never use one: they run the published dependency.
_Avoid_: dev build, unreleased store, local store

**Unlogged Configuration**:
A Postgres Memory Configuration whose tables are created UNLOGGED, so the Engine writes no WAL for them; it pays for no durability the Memory Configuration could not deliver anyway. wa-sqlite's twin is the journal-off Configuration (`PRAGMA journal_mode = OFF`).
_Avoid_: no-WAL mode, fast mode, unsafe mode

**Benchmark**:
One timed unit within a Suite: a Speedtest script, one RTT statement, one Concurrency Scenario, or one Prepared Suite row's text of `EXECUTE`s. It is the row of the results table.
_Avoid_: test, case, step (a **Step** is one entry in a Client's program), query

**Measurement**:
The wall time, taken inside the Engine's worker, from handing SQL to the Engine until decoded rows or a command tag are available in JS. Nothing outside that window counts. A Concurrency Benchmark's Measurement is a number computed from many such windows — a percentile, a wall time or a rate — every one of them taken inside the worker, and it carries its Detail with it.
_Avoid_: timing, latency, elapsed, duration

**Warm-up**:
The timed phase every Engine runs once after it boots and before a Suite's first Benchmark: one fixed script, the same for every Engine and every Suite. It is reported as its own line above the Suite's rows, with a ratio against the Baseline like any row, and is never part of a Suite total. It exists so that an Engine's first-use costs are paid in the open, by every Engine alike, rather than by whichever Benchmark happens to come first.
_Avoid_: warmup benchmark, bootstrap test, row 0

**Run**:
One execution of one Suite against one Configuration, on a freshly opened Engine; it yields one Measurement per Benchmark. A Run may hold several **Sessions** — that is the postmaster's whole point — but it is never called one.
_Avoid_: session, pass, execution

**Arm**:
One module variant under measurement, distinguished from the published module only by what its experiment changes. It is swapped into `dist/` for a Run and restored afterwards, and it is never the module behind a published number unless it is adopted.
_Avoid_: variant, build, candidate
