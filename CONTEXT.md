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
One of the WebAssembly databases under comparison: PGlite, pgrust, pgrust Threads, or wa-sqlite. PGlite and the two pgrust builds are the subjects; wa-sqlite is the Reference Engine.
_Avoid_: database, backend, target, implementation

**pgrust Threads**:
pgrust built for `wasm32-wasip1-threads` rather than `wasm32-wasip1`, from the same commit as the pgrust Engine. Its session runs on a real thread spawned through the guest's own `wasi` `thread-spawn` import over one shared `WebAssembly.Memory`, so its blocking stdin read blocks a Worker in `Atomics.wait` instead of suspending with JSPI — which is why it needs cross-origin isolation and no JSPI, and pgrust needs JSPI and no isolation. A separate Engine, never a mode of pgrust.
_Avoid_: threaded pgrust, pgrust MT, the SAB build

**Reference Engine**:
An Engine included only so results can be calibrated against numbers published elsewhere (wa-sqlite's and PGlite's own benchmark pages); never the Baseline of a ratio.
_Avoid_: control, sanity engine

**Baseline**:
The Configuration every ratio is computed against: PGlite Memory.
_Avoid_: reference, control column

**Configuration**:
An Engine plus the storage and durability settings it is opened with; one Configuration is one column of results. Phase 1 has exactly ten: PGlite Memory, PGlite Memory (unlogged), PGlite OPFS repacked (relaxed), PGlite OPFS repacked (strict), pgrust Memory, pgrust Memory (unlogged), pgrust Threads Memory, pgrust Threads Memory (broker, pre-release store), wa-sqlite Memory, wa-sqlite Memory (journal off).
_Avoid_: setup, mode, variant, column

**Memory Configuration**:
A Configuration whose data directory lives entirely in the worker's heap and is discarded when the worker ends.
_Avoid_: in-memory mode, ephemeral, transient

**Storage Configuration**:
A Configuration whose data directory lives in a Store rather than the worker's heap. It still carries nothing between Runs: the Run empties the Store's directory before opening it and removes it on close, so it measures a cold data directory on real storage.
_Avoid_: persistent mode, OPFS mode, disk configuration

**Store**:
The package a Storage Configuration opens its data directory through, and the durability it is opened with. Phase 1 has one: `@pgxsinkit/pglite-opfs-repacked`, which packs a whole Postgres data directory into four exclusively owned OPFS files, in either its relaxed or its strict durability. The pgrust Threads broker column runs the same package's Broker on its memory port, which is a filesystem seam rather than a Store: nothing leaves the worker's heap, so that column is a Memory Configuration.
_Avoid_: VFS, filesystem, backend, persistence layer

**Broker**:
The pgrust Threads filesystem seam in which one repacked store lives alone in a dedicated coordinator worker and every guest instance reaches it over a SharedArrayBuffer channel, blocking in `Atomics.wait`. Its alternative is the copy seam, where every worker builds its own filesystem from its own copy of the packed image. A property of two columns' Configurations, never of the Engine.
_Avoid_: shared FS, coordinator mode, broker store

**Pre-release store**:
A build of the Store package taken from a pgxsinkit checkout rather than from npm, because the code a column needs exists in no published version. Phase 1 has one, loaded by the broker column alone; it is named in that column's own label and its commit is recorded in `src/vendor/pgrust/SOURCE.md`. The two OPFS repacked columns never use one.
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
One execution of one Suite against one Configuration, on a freshly opened Engine; it yields one Measurement per Benchmark.
_Avoid_: session, pass, execution
