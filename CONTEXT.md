# pglite-v-pgrust

A browser benchmark that runs the same SQL workloads against PGlite and pgrust (both WebAssembly Postgres builds), with wa-sqlite as a calibration reference, and reports the timings side by side.

## Language

**Suite**:
A named, fixed list of Benchmarks run in order against one Engine. Phase 1 has exactly two: the Speedtest Suite and the RTT Suite.
_Avoid_: test set, benchmark set, scenario

**Speedtest Suite**:
The 16 SQL scripts ported from the SQLite speedtest via wa-sqlite and PGlite, byte-identical to PGlite's copies; one timing per script.
_Avoid_: wa-sqlite benchmarks, SQLite benchmarks

**RTT Suite**:
Twelve single-statement CRUD queries each executed 100 times; reports the per-statement round-trip time as a trimmed mean (lowest and highest 10% of Measurements discarded), exactly as PGlite does.
_Avoid_: latency suite, CRUD suite

**Engine**:
One of the WebAssembly databases under comparison: PGlite, pgrust, pgrust Threads, pgrust Postmaster, or wa-sqlite. PGlite and the pgrust Engines are the subjects; wa-sqlite is the Reference Engine.
_Avoid_: database, backend, target, implementation

**pgrust Threads**:
pgrust built for `wasm32-wasip1-threads` rather than `wasm32-wasip1`, from the same commit as the pgrust Engine. Its session runs on a real thread spawned through the guest's own `wasi` `thread-spawn` import over one shared `WebAssembly.Memory`, so its blocking stdin read blocks a Worker in `Atomics.wait` instead of suspending with JSPI — which is why it needs cross-origin isolation and no JSPI, and pgrust needs JSPI and no isolation. A separate Engine, never a mode of pgrust.
_Avoid_: threaded pgrust, pgrust MT, the SAB build

**pgrust Postmaster**:
The `wasm32-wasip1-threads` build again, started as `postgres --host-pipes` — which selects a transport and then falls through to the ordinary `PostmasterMain` — instead of as one `--stdio-wire-threaded` session. What runs is a whole server: a startup process, a checkpointer, a background writer, a WAL writer, a warm standby pool, and one real backend thread per Session. Its filesystem is always the Broker's, because a checkpointer with its own copy of the packed image could not see what the backends wrote. A separate Engine, never a mode of pgrust Threads: it is a different thing to boot, a different pool size (12 plus one slot per Session) and a different shutdown.
_Avoid_: postmaster mode, multi-session pgrust, pgrust server

**Session**:
One pgwire connection to one Engine: on pgrust Postmaster a real Postgres backend on its own guest thread, reached over its own pair of SharedArrayBuffer rings; on every other Engine the one place that Engine has to run SQL. How many a Run opens is the **Suite's** request, not the Configuration's, and the postmaster is the only Engine that can answer with more than one. A Session is not a Run: a Run is one Suite against one Configuration, and it may hold several Sessions.
_Avoid_: connection, client (a **Client** is the scripted program that uses one), backend

**Reference Engine**:
An Engine included only so results can be calibrated against numbers published elsewhere (wa-sqlite's and PGlite's own benchmark pages); never the Baseline of a ratio.
_Avoid_: control, sanity engine

**Baseline**:
The Configuration every ratio is computed against: PGlite Memory.
_Avoid_: reference, control column

**Configuration**:
An Engine plus the storage and durability settings it is opened with; one Configuration is one column of results. There are exactly fourteen: PGlite Memory, PGlite Memory (unlogged), PGlite OPFS repacked (relaxed), PGlite OPFS repacked (strict), pgrust Memory, pgrust Memory (unlogged), pgrust Threads Memory, pgrust Threads Memory (broker, pre-release store), pgrust Threads OPFS repacked (relaxed, pre-release store), pgrust Threads OPFS repacked (strict, pre-release store), pgrust Postmaster Memory (broker, pre-release store), pgrust Postmaster OPFS repacked (relaxed, pre-release store), wa-sqlite Memory, wa-sqlite Memory (journal off).
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
One timed unit within a Suite: a Speedtest script, or one RTT statement. It is the row of the results table.
_Avoid_: test, case, step, query

**Measurement**:
The wall time, taken inside the Engine's worker, from handing SQL to the Engine until decoded rows or a command tag are available in JS. Nothing outside that window counts.
_Avoid_: timing, latency, elapsed, duration

**Run**:
One execution of one Suite against one Configuration, on a freshly opened Engine; it yields one Measurement per Benchmark. A Run may hold several **Sessions** — that is the postmaster's whole point — but it is never called one.
_Avoid_: session, pass, execution
