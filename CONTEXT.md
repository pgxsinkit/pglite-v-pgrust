# pglite-v-pgrust

A browser benchmark that runs the same SQL workloads against PGlite and pgrust (both WebAssembly Postgres builds) and reports the timings side by side.

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
One of the two WebAssembly Postgres builds under comparison: PGlite or pgrust.
_Avoid_: database, backend, target, implementation

**Configuration**:
An Engine plus the storage and durability settings it is opened with; one Configuration is one column of results. Phase 1 has exactly three: PGlite Memory, PGlite Memory (unlogged), pgrust Memory.
_Avoid_: setup, mode, variant, column

**Memory Configuration**:
A Configuration whose data directory lives entirely in the worker's heap and is discarded when the worker ends.
_Avoid_: in-memory mode, ephemeral, transient

**Benchmark**:
One timed unit within a Suite: a Speedtest script, or one RTT statement. It is the row of the results table.
_Avoid_: test, case, step, query

**Measurement**:
The wall time, taken inside the Engine's worker, from handing SQL to the Engine until decoded rows or a command tag are available in JS. Nothing outside that window counts.
_Avoid_: timing, latency, elapsed, duration

**Run**:
One execution of one Suite against one Configuration, on a freshly opened Engine; it yields one Measurement per Benchmark.
_Avoid_: session, pass, execution
