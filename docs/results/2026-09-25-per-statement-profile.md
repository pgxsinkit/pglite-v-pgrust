# Per statement: rows 2, 7, 9 and 10 pay across analysis, planning and executor setup, the planner most on the index rows; row 1's multiple is mostly warm-up

- Date: 2026-09-25
- Machine: i7-1165G7 (8 logical cores), 30 GiB, Linux 7.0.0-34-generic. A desktop Chrome and VS Code
  ran throughout; every timed Run waited for a 1-minute load under 2.5 (§1).
- Lane: **node v26.10.0** (V8 14.6.202.34-node.34, with V8's defaults for wasm: lazy compilation,
  dynamic tiering, wasm inlining), bite 1's driver shape (§3); bun 1.4.2 for the drivers.
- Engines:
  - **pgrust**, `spike/wasip1-threads@569d16128c` (PostgreSQL 18.6): the published threads module
    `df17f7e24a33…` ("shipped") and the profile Arm of
    [where the multiple lives](2026-09-24-where-the-multiple-lives.md) §4.1, `c0e376f19e36…`, which
    keeps a `name` section (§2.1).
  - **PGlite**: `@pgxsinkit/pglite 0.5.5-pgx.3`, whose `pglite.wasm` is `@electric-sql/pglite
    0.5.5`'s (`9f9ec7f25956…`, PostgreSQL 18.3), and a named build of that module, `ecd4ef287d40…`,
    byte-identical to it in every section but the added `name` section (§2.2).
- Drivers and raw artefacts: `tmp/agents/profile3/` (untracked). Every number below is printed by a
  script there from the Runs' own JSON and `.cpuprofile` files (Reproduction).
- Nothing was adopted. No pgrust file was edited and no commit was made there. `dist/` and
  `public/pgrust/` were sha-verified before and after every Run and never modified.

## What this answers

[The persistent-context note](2026-09-24-persistent-context.md) and the store-levers note's
[Adopted](2026-09-24-store-levers.md#adopted-2026-09-24) section left pgrust's postmaster at 1.46–1.48×
PGlite OPFS on a disk-backed profile, with the store worth about 5% to either engine. What is left is
the guest's own work on the statement-heavy rows, 1, 2, 7, 9 and 10 (4.00×, 1.84×, 1.80×, 1.69× and
1.61× PGlite OPFS, persistent-context §5), each of them one query text of 1 000 to 25 000 statements.
This note names where that time goes, in named guest functions, row by row, against PGlite's own
profile of the same row.

**Six findings.**

1. **Rows 2, 7, 9 and 10 pay per statement, across the whole path from analysis to executor
   teardown, and on the index rows the planner is the largest single part.** On an engine that has run the Suite once
   ("warm", §8), pgrust spends 1.48–1.82× PGlite's time per statement on these rows. The planner
   carries 40–47% of the difference on rows 7, 9 and 10 (+23.3, +17.8 and +17.4 µs per statement,
   2.9–3.6× PGlite's planner self time), then the executor (+8.8 to +9.7 µs, mostly plan-state setup
   and teardown), the catalog caches, parse analysis and the portal code. The B-tree costs +2.1 to +3.6
   µs, WAL at most +0.8. By phase, planning is 1.9–2.1× PGlite's and ExecutorStart 2.1–2.6×; the raw
   parse is level (§5).
2. **Most of row 1's multiple is warm-up.** Row 1 is the first text after boot. As the Suite runs it,
   pgrust needs 136.9 µs per statement against PGlite's 54.1 (2.53×); on a warm engine 31.4 against
   19.0 (1.65×). 85% of row 1's difference goes when the code has run once, and it goes from every
   subsystem at once; the one `CREATE TABLE` alone costs pgrust 29.4 ms cold and 1.0 ms warm (PGlite
   2.5 and 0.3). pgrust keeps warming for more than ten thousand statements (§8, §9).
3. **The cost is linear in the statement count, with a per-text constant.** On a warm engine a text
   of N statements costs pgrust 3.05 ms + 31.9 µs·N and PGlite 1.15 ms + 20.5 µs·N; the marginal cost
   per statement is the same from 100 to 1 000 as from 1 000 to 10 000 (32.1 and 31.9 µs). No function
   was found whose self time grows faster than the statement count above sampling noise, with one
   small exception (§9).
4. **The runtime taxes bite 1 looked for are absent here too**: seams at most 0.1% of any row,
   thread-local access at most 0.3%, unwinding zero, memcpy and friends at most 0.2%, the allocator
   0.7–2.3%. pgrust's memory contexts cost less per statement than PGlite's `palloc`/`AllocSet` on
   every row but warm row 1, where they are level. Rust's own generic code (`core`, `alloc`,
   `hashbrown`) is 1.5–3.2%, and the broker store 0.4–5.2% (§7).
5. **The client costs both engines the same.** pgrust's backend idles in `pq_getbyte` while node's
   main thread parses the results with PGlite's own protocol code; PGlite runs the same code in its one
   thread. The two lines agree within 0.6 µs per statement on every row cold, 0.9 warm (§4).
6. **No per-statement setting differs, and the plans have the same shape** (§10): `track_*`,
   `log_*`, `debug_*`, `compute_query_id` and `jit` are the same in both engines, and rows 7, 9 and 10
   run a Bitmap Heap Scan in both.

## Method

- **Lane.** Bite 1's node lane, rebuilt in `tmp/agents/profile3/node-suite.ts`: the bench's own
  engine (`createPgrustPglite`, the postmaster with its backends as `node:worker_threads`), the broker
  store on the coordinator's heap (`memory`), and PGlite in memory on node's main thread, as the
  browser's `pglite-memory` column opens it. Each Speedtest script is one `exec`, the simple query
  protocol, so each row is one message and one `exec_simple_query`. The store is not the question
  here, so the heap store is the right one: rows 2, 7, 9 and 10 cost PGlite OPFS 1.01–1.08× PGlite
  Memory on disk (persistent-context §5).
- **Arms.** pgrust: bite 1's Arm, re-checked against the shipped module in four interleaved rounds
  (§2.1). PGlite: a named build proven identical by bytes (§2.2).
- **Profiles.** `node --cpu-prof --cpu-prof-interval 250`, one `.cpuprofile` per thread, sliced by
  each row's window on CLOCK_MONOTONIC as in bite 1 (`slice3.ts`, which extends bite 1's
  `slice-cpuprofile.ts`). Four profiled Runs per engine went into the cold tables (two whole Suites,
  and the first time through the Suite of two Suite-twice Runs), and two into the warm tables. The
  same row's samples are added across Runs. pgrust's backend is the thread with the most distinct
  leaf functions in the window; PGlite has one thread.
- **Per-statement microseconds.** A bucket's (or a function's) share of the backend's sampled time,
  times the median unprofiled row time of the same module, cold or warm, divided by the row's
  statement count (1 000, 25 000, 5 000, 25 000, 25 000). The profiler's own cost (23–26% of the Suite
  on pgrust, 2–5% on PGlite) is so kept out of the microseconds.
- **Buckets.** pgrust: each crate is placed by its directory under `crates/` (`crate-map.tsv`: 892
  crates; `crates/backend/optimizer/...` is the planner, `crates/backend/access/nbtree/...` the B-tree,
  and so on). PGlite: each C function by the object file that defines it in the named build
  (`pglite-symbols.tsv`, from `llvm-nm` over the objects that link into `pglite.wasm`: 15 994
  functions, 52 of them static names defined in more than one file). Host frames by file and name
  (§4).
- **Cold and warm.** "Cold" is the Suite as it runs, the first time through a fresh engine, which is
  what the browser measures. "Warm" is the same Suite the second time through the same engine, in
  one Run of the `suite2` mode (row 16 drops t1, t2 and t3, and the driver drops t2_1 and t3_1
  untimed, so the second time through starts from the same tables).
- **Sweep.** Row 1's shape at 100, 1 000 and 10 000 statements (§9).
- **Load gate.** Every timed Run started only with the 1-minute load under 2.5, checked every 15 s for
  at most 10 minutes (bite 1's `load.ts`). Profiled Runs are gated too.

## 1. Environment and load

Twenty-six timed Runs, one node process at a time, none at the 10-minute cap; the longest wait was 30 s.
Every Run's 1-minute, 5-minute and 15-minute load before and after (`tables3.md`, "Load"); the high
5- and 15-minute figures early on are the named PGlite builds (§2.2), which ran before any timed Run:

| Run | waited | 1-minute load before → after (1/5/15) |
| --- | --- | --- |
| shipped-r1 | 15 s | 1.95 5.06 4.56 → 2.84 5.14 4.59 |
| arm-r1 | 15 s | 2.21 4.89 4.51 → 1.94 4.70 4.46 |
| pglite-r1 | 0 s | 1.94 4.70 4.46 → 1.79 4.58 4.42 |
| shipped-r2 | 0 s | 1.79 4.58 4.42 → 2.08 4.50 4.40 |
| arm-r2 | 0 s | 2.08 4.50 4.40 → 1.99 4.40 4.37 |
| pglite-r2 | 0 s | 1.99 4.40 4.37 → 1.91 4.30 4.33 |
| arm-prof1 | 0 s | 1.56 4.11 4.27 → 1.92 4.02 4.24 |
| arm-prof2 | 0 s | 1.92 4.02 4.24 → 1.85 3.90 4.19 |
| pglite-named-prof | 0 s | 1.85 3.90 4.19 → 1.72 3.81 4.16 |
| shipped-sweep-r1 | 0 s | 0.84 2.60 3.65 → 2.14 2.84 3.72 |
| pglite-sweep-r1 | 0 s | 2.14 2.84 3.72 → 2.36 2.88 3.72 |
| shipped-sweep-r2 | 0 s | 2.36 2.88 3.72 → 2.36 2.88 3.72 |
| pglite-sweep-r2 | 0 s | 2.34 2.86 3.72 → 2.34 2.86 3.72 |
| arm-sweep-prof | 0 s | 2.13 2.80 3.69 → 3.00 2.97 3.74 |
| pglite-named-sweep-prof | 30 s | 2.06 2.75 3.64 → 2.45 2.82 3.65 |
| pglite-named-prof2 | 0 s | 2.34 2.86 3.72 → 2.13 2.80 3.69 |
| shipped-s2-r1 | 0 s | 0.87 2.17 3.33 → 0.95 2.09 3.27 |
| arm-s2-r1 | 0 s | 0.95 2.09 3.27 → 1.33 2.10 3.25 |
| pglite-s2-r1 | 0 s | 1.63 2.15 3.26 → 2.21 2.26 3.28 |
| shipped-s2-r2 | 0 s | 2.21 2.26 3.28 → 3.09 2.47 3.32 |
| arm-s2-r2 | 30 s | 2.22 2.33 3.24 → 1.96 2.26 3.20 |
| pglite-s2-r2 | 0 s | 1.96 2.25 3.19 → 2.09 2.27 3.18 |
| arm-s2-prof1 | 0 s | 2.09 2.27 3.18 → 2.23 2.30 3.16 |
| pglite-named-s2-prof1 | 0 s | 2.13 2.27 3.15 → 1.95 2.23 3.12 |
| arm-s2-prof2 | 0 s | 1.95 2.23 3.12 → 2.12 2.24 3.10 |
| pglite-named-s2-prof2 | 0 s | 2.12 2.24 3.10 → 2.01 2.21 3.07 |

Not in the table: the first attempt at `shipped-s2-r1` (load 1.54 before) stopped on its second time
through the Suite with `relation "t2_1" already exists` (the driver now drops t2_1 and t3_1), and one
attempt at a TurboFan-from-start lane that could not boot (§8).

## 2. The arms

### 2.1 pgrust: bite 1's Arm, and its parity on these rows

The Arm is bite 1's: the shipped build with names kept by a linker wrapper, then Binaryen 133 with
`-g` (where the multiple lives, §4.1). It is still on disk (`tmp/agents/anchors/arm-named.wasm`,
`c0e376f19e36…`, the same bytes as the pgrust checkout's
`target/wasm32-wasip1-threads/wasm-release/postgres.wasm`), with a 3 313 052-byte `name` section and
no `.debug_*` section (`arm-sections.log`). It was not rebuilt.

Parity in this lane, the Suite unprofiled, interleaved: the Suite set ran shipped, arm, PGlite,
shipped, arm, PGlite, and the Suite-twice set the same order again, so each module has four cold
Runs. Milliseconds:

| Benchmark | shipped (4 Runs) | arm (4 Runs) | shipped median | arm median | arm ÷ shipped | shipped spread (max ÷ min) | arm spread | flag (>5%) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 158.5 / 160.1 / 122.0 / 158.7 | 153.3 / 120.4 / 117.1 / 156.7 | 158.6 | 136.9 | 0.86× | 1.31× | 1.34× | **yes** |
| 2: 25000 INSERTs in a transaction | 1093.1 / 1004.8 / 1050.1 / 1184.0 | 1025.9 / 1025.5 / 1073.8 / 1040.8 | 1071.6 | 1033.4 | 0.96× | 1.18× | 1.05× | no |
| 7: 5000 SELECTs with an index | 832.1 / 757.9 / 748.1 / 986.4 | 761.8 / 776.1 / 898.4 / 793.4 | 795.0 | 784.8 | 0.99× | 1.32× | 1.18× | no |
| 9: 25000 UPDATEs with an index | 2520.4 / 2422.7 / 2449.9 / 2441.0 | 2439.7 / 2415.9 / 2450.2 / 2391.0 | 2445.4 | 2427.8 | 0.99× | 1.04× | 1.02× | no |
| 10: 25000 text UPDATEs with an index | 2952.7 / 2769.1 / 2723.2 / 3251.5 | 2756.8 / 2732.0 / 2739.9 / 2754.8 | 2860.9 | 2747.4 | 0.96× | 1.19× | 1.01× | no |
| Suite total | 11643.9 / 11095.4 / 11153.5 / 12325.5 | 11180.5 / 11050.7 / 11379.2 / 11110.1 | 11398.7 | 11145.3 | 0.98× | 1.11× | 1.03× | no |

Warm: the Suite-twice Runs' second time through the Suite, in the same engine:

| Benchmark | shipped s2-r1 / s2-r2 | arm s2-r1 / s2-r2 | arm ÷ shipped (means) |
| --- | --- | --- | --- |
| 1 | 30.8 / 40.3 | 30.9 / 31.8 | 0.88× |
| 2 | 701.0 / 752.1 | 729.8 / 722.0 | 1.00× |
| 7 | 651.8 / 670.6 | 649.6 / 655.3 | 0.99× |
| 9 | 2404.4 / 2672.1 | 2449.3 / 2508.5 | 0.98× |
| 10 | 2662.5 / 2973.2 | 2704.1 / 2680.2 | 0.96× |
| Suite total | 10214.7 / 11215.6 | 10403.2 / 10360.7 | 0.97× |

**Rows 2, 7, 9 and 10 and the Suite are within noise** (0.96–0.99×, inside each module's own spread).
**Row 1 is flagged:** the Arm's median is 0.86× the shipped module's. Both modules put row 1 in two
places, about 120 ms and about 157 ms, the Arm twice in four Runs and the shipped module once, so
the medians fall on different sides; each module's own spread (1.31× and 1.34×) covers the whole
difference. Row 1's profile is scaled by the Arm's own median, and its warm-up reading (§8) does not
depend on which module ran.

### 2.2 PGlite: its published module, with names

The brief expected PGlite's emscripten build to carry names. It does not: `pglite.wasm` has no `name`
section, and V8 shows its functions as `wasm-function[N]`. Its export section names 1 928 of its
14 192 functions, which covered 40–48% of the module's self time in a smoke profile
(`peek-coverage.log`), too little for a subsystem table. So PGlite 0.5.5's module was rebuilt with
names (`pglite-build/build.sh`):

- the source is `postgres-pglite` at `7b4ee5086055`, the submodule commit of the
  `@electric-sql/pglite@0.5.5` tag in the local PGlite checkout, cloned from its `.git/modules`
  (read-only);
- the toolchain is `electricsql/pglite-builder:3.1.74-7`, the image `build-with-docker.sh` names,
  under podman, with the tree mounted at upstream CI's own path
  (`/home/runner/_work/pglite/pglite/postgres-pglite`), because `pg_config`'s `LDFLAGS` string, and so
  the data section, carries the build path;
- the script is upstream's `build-pglite.sh` with the extension steps left out, the exported-function
  list taken from the published module's own export names, sorted in the C locale as the upstream
  Makefile's `sort -u` does, and `--profiling-funcs` on the final link.

The recipe took five builds (`pglite-build/build-*.log`). The first stopped on `___main_argc_argv`
in the export list (emscripten's own name for `main`, listed as `_main` since). An unnamed build at
this checkout's path differs from the published module in 983 935 bytes of data, starting at the build
path string, and in 4 754 function bodies (`pglite-build-path.log`). The last build, at CI's path with
the C-locale list, is **byte-identical to the published module in every non-custom section: all
14 192 function bodies at the same indices, and the same data** (`pglite-named-parity-sections.log`),
plus a 502 821-byte `name` section. So PGlite's profile below is the published module's code; no
timing parity was needed, and none was run. It was passed to the installed package as
`pgliteWasmModule`; everything else is the package as published.

## 3. The lane

`createPgrustPglite` with `durability: "strict"` keeps `synchronous_commit=on`, which the browser's
`pgrust-postmaster-*` columns run. The factory's strict mapping also sets `fsync=on`, which those
columns (a relaxed broker) do not, so the lane passes `fsync=off` last, where a caller's setting wins.
The engine's own argv (`src/client/pgrust-engine.ts`) supplies `wal_init_zero=off` and
`wal_buffers=4MB`. `SHOW` in the lane:

| Run | fsync | wal_init_zero | wal_buffers | synchronous_commit |
| --- | --- | --- | --- | --- |
| shipped-r1 | off | off | 4MB | on |
| pglite-r1 | off | on | 4MB | on |

The node lane's cold ratios sit where the disk lane's do on rows 2, 7, 9 and 10, and below it on
row 1:

| Benchmark | node, shipped ÷ PGlite, cold (medians of 4) | disk lane, pgrust ÷ PGlite Memory (persistent-context §5) | disk lane, pgrust ÷ PGlite OPFS (§5) |
| --- | --- | --- | --- |
| 1: 1000 INSERTs | 2.93× | 4.29× | 4.00× |
| 2: 25000 INSERTs in a transaction | 1.94× | 1.86× | 1.84× |
| 7: 5000 SELECTs with an index | 1.81× | 1.87× | 1.80× |
| 9: 25000 UPDATEs with an index | 1.89× | 1.83× | 1.69× |
| 10: 25000 text UPDATEs with an index | 1.81× | 1.71× | 1.61× |

(The disk-lane figures are from before the adopted settings; the brief's 1.9× and 1.8× for rows 7
and 9 do not match §5's medians, 1.80× and 1.69×.) Row 1's larger browser multiple is outside this
lane (§12).

## 4. Where each row's time goes, by subsystem

Buckets, one list for both engines. The PostgreSQL subsystems are placed by source directory: parser
(the raw grammar and scanner, `gram`, `scan`, keywords), analyzer/rewriter (`parser/` otherwise,
`rewrite/`), planner (`optimizer/`), executor (`executor/`), access/heap (`access/heap`,
`access/common`, `access/table`), access/index (`access/nbtree`, `access/index`), storage/buffer
(`storage/buffer`, `storage/page`), storage/other (lmgr, smgr, ipc, fd), transam/WAL
(`access/transam`, and `crc32c`), catalog/syscache (`catalog/`, `utils/cache/`), tcop/portal/dest
(`tcop/`, `portalmem`, `printtup`, `libpq/`, PGlite's `pglitec` glue), nodes (`nodes/`: walkers,
copy, lists), fmgr/adt, commands, utils/misc (the rest of `utils/`, `common/`, `port/`), and memory
contexts (pgrust's `mcx`, PostgreSQL's `utils/mmgr` but `portalmem`). The rest: the allocator
(`dlmalloc`, `__rust_alloc`), `mem*`/`str*`, Rust generics (`core`, `alloc`, `std`, `hashbrown`
monomorphisations), seams, thread-local, unwinding (pgrust) and PGlite's setjmp trampolines
(`invoke_*`, `getWasmTableEntry`, `stackSave`), the store (pgrust's `#call`, the broker client's
blocking request, and the rest of its bundle; PGlite's emscripten MEMFS and syscalls), pgrust's
message I/O (the WASI shim and SAB pipes), JS/wasm transitions, and **the client**: pgrust's backend
idle in `pq_getbyte` (every such sample, `callers3.log`) while node's main thread parses results with
PGlite's own protocol code (`thread-summary.log`, one profiled Run: 74–110 ms busy on the main thread
in the windows of rows 2 to 10, about the share the backend waits), and PGlite's protocol JS in its
one thread.
`stack_depth_core::with_own_frame`, a never-inlined trampoline around the executor's node-init match
arms, is billed to the crate it runs (the executor).

Microseconds per statement, pgrust / PGlite, **cold** (the Suite as it runs; four profiled Runs per
engine, `matrix-cold.md`):

| bucket (µs/stmt, pgrust / PGlite) | row 1 | row 2 | row 7 | row 9 | row 10 |
| --- | --- | --- | --- | --- | --- |
| parser | 5.3 / 1.3 | 2.4 / 1.1 | 2.1 / 2.1 | 0.9 / 1.0 | 1.1 / 1.1 |
| analyzer/rewriter | 14.3 / 3.7 | 3.4 / 1.8 | 11.4 / 5.8 | 5.8 / 2.3 | 6.3 / 2.3 |
| planner | 17.2 / 6.2 | 5.8 / 2.6 | 42.3 / 13.4 | 25.2 / 7.3 | 26.0 / 7.3 |
| executor | 20.9 / 5.9 | 6.4 / 2.2 | 17.9 / 6.5 | 14.3 / 4.6 | 15.0 / 5.0 |
| access/heap | 4.1 / 1.9 | 1.4 / 0.6 | 4.0 / 2.2 | 4.5 / 2.7 | 7.5 / 6.2 |
| access/index | 0.6 / 0.2 | 0.0 / 0.0 | 5.2 / 1.7 | 8.3 / 4.0 | 9.3 / 5.4 |
| storage/buffer | 1.9 / 0.7 | 0.7 / 0.2 | 3.1 / 1.3 | 3.3 / 1.9 | 3.9 / 2.5 |
| storage/other | 1.9 / 0.8 | 0.3 / 0.3 | 1.9 / 2.2 | 2.3 / 1.9 | 2.4 / 2.1 |
| transam/WAL | 2.4 / 1.0 | 1.0 / 0.5 | 0.1 / 0.1 | 2.5 / 1.5 | 2.6 / 1.5 |
| catalog/syscache | 11.2 / 2.4 | 2.3 / 1.2 | 13.5 / 6.0 | 5.7 / 2.8 | 6.7 / 3.0 |
| tcop/portal/dest | 16.6 / 2.2 | 3.4 / 0.9 | 7.0 / 2.5 | 3.6 / 1.2 | 3.8 / 1.2 |
| nodes | 4.2 / 3.5 | 1.7 / 1.7 | 6.8 / 9.1 | 3.1 / 4.9 | 3.6 / 5.8 |
| fmgr/adt | 1.0 / 0.4 | 0.3 / 0.2 | 4.5 / 3.3 | 0.1 / 1.2 | 0.3 / 1.3 |
| commands | 2.4 / 0.3 | 0.1 / 0.0 | 0.1 / 0.0 | 0.1 / 0.1 | 0.1 / 0.1 |
| utils/misc | 5.7 / 2.4 | 2.2 / 1.5 | 6.7 / 4.5 | 4.9 / 3.5 | 5.2 / 4.5 |
| memory contexts | 3.0 / 6.0 | 2.2 / 2.6 | 6.9 / 8.0 | 3.4 / 4.6 | 3.8 / 4.7 |
| allocator | 0.9 / 0.1 | 0.7 / 0.0 | 1.5 / 0.2 | 0.9 / 0.3 | 1.2 / 0.4 |
| memcpy/memmove/memset/memcmp/str* | 0.3 / 0.4 | 0.1 / 0.4 | 0.2 / 1.2 | 0.0 / 0.8 | 0.0 / 1.5 |
| Rust generics | 2.0 / 0.0 | 1.0 / 0.0 | 3.4 / 0.0 | 2.0 / 0.0 | 3.1 / 0.0 |
| seams | 0.1 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 |
| thread-local | 0.0 / 0.0 | 0.0 / 0.0 | 0.2 / 0.0 | 0.2 / 0.0 | 0.2 / 0.0 |
| unwind / setjmp-longjmp trampolines | 0.0 / 0.2 | 0.0 / 0.1 | 0.0 / 0.4 | 0.0 / 0.3 | 0.0 / 0.4 |
| store: #call | 5.7 / 0.0 | 1.1 / 0.0 | 0.7 / 0.0 | 1.8 / 0.0 | 3.0 / 0.0 |
| store: other JS | 2.8 / 1.7 | 0.3 / 0.3 | 0.5 / 2.7 | 0.5 / 1.3 | 0.4 / 2.7 |
| message I/O JS | 1.1 / 0.0 | 0.3 / 0.0 | 1.4 / 0.0 | 0.3 / 0.0 | 0.3 / 0.0 |
| JS <-> wasm transitions | 0.5 / 2.1 | 0.1 / 0.4 | 0.1 / 1.7 | 0.0 / 0.8 | 0.0 / 0.8 |
| client (pgrust idle in pq_getbyte + PGlite protocol JS) | 7.6 / 7.1 | 3.3 / 2.9 | 11.9 / 11.6 | 2.2 / 2.2 | 2.4 / 2.5 |
| everything else (V8, guest waits, other) | 3.2 / 3.6 | 0.9 / 0.5 | 3.5 / 1.5 | 1.2 / 0.7 | 1.4 / 1.0 |
| **total** | **136.9 / 54.1** | **41.3 / 22.1** | **157.0 / 88.0** | **97.1 / 51.8** | **109.9 / 63.4** |
| ratio | 2.53× | 1.87× | 1.78× | 1.87× | 1.73× |

**Warm** (the same rows the second time through the same engine; two profiled Runs per engine,
`matrix-warm.md`):

| bucket (µs/stmt, pgrust / PGlite) | row 1 | row 2 | row 7 | row 9 | row 10 |
| --- | --- | --- | --- | --- | --- |
| parser | 1.0 / 1.3 | 1.2 / 1.3 | 2.1 / 2.4 | 0.9 / 1.1 | 1.1 / 1.3 |
| analyzer/rewriter | 2.8 / 1.2 | 2.3 / 1.3 | 8.9 / 4.9 | 5.5 / 2.4 | 6.9 / 2.5 |
| planner | 3.1 / 1.9 | 4.3 / 2.1 | 35.3 / 12.1 | 24.9 / 7.0 | 25.2 / 7.8 |
| executor | 5.7 / 1.9 | 4.7 / 1.9 | 14.6 / 5.8 | 14.3 / 4.8 | 14.8 / 5.1 |
| access/heap | 0.8 / 0.6 | 0.9 / 0.5 | 2.4 / 1.9 | 4.5 / 2.3 | 7.7 / 6.3 |
| access/index | 0.2 / 0.0 | 0.0 / 0.0 | 4.1 / 2.0 | 7.9 / 4.3 | 9.2 / 5.9 |
| storage/buffer | 0.0 / 0.6 | 0.5 / 0.4 | 2.2 / 0.8 | 3.4 / 1.9 | 4.0 / 2.8 |
| storage/other | 0.3 / 0.0 | 0.4 / 0.3 | 1.7 / 1.6 | 2.5 / 1.8 | 2.2 / 2.0 |
| transam/WAL | 0.7 / 0.0 | 0.7 / 0.5 | 0.0 / 0.1 | 2.4 / 1.7 | 2.6 / 1.8 |
| catalog/syscache | 3.6 / 0.7 | 1.9 / 1.1 | 11.7 / 6.0 | 5.7 / 2.9 | 6.3 / 3.1 |
| tcop/portal/dest | 2.4 / 0.3 | 2.0 / 0.8 | 5.6 / 2.2 | 3.4 / 1.3 | 3.4 / 1.2 |
| nodes | 0.9 / 1.8 | 1.3 / 1.8 | 4.8 / 7.8 | 3.1 / 4.9 | 3.9 / 6.1 |
| fmgr/adt | 0.0 / 0.0 | 0.1 / 0.2 | 3.9 / 3.0 | 0.1 / 1.0 | 0.3 / 1.5 |
| commands | 0.0 / 0.0 | 0.0 / 0.1 | 0.1 / 0.0 | 0.1 / 0.1 | 0.1 / 0.1 |
| utils/misc | 1.2 / 1.3 | 1.5 / 1.2 | 5.3 / 4.9 | 4.8 / 3.5 | 5.5 / 4.7 |
| memory contexts | 1.9 / 1.9 | 1.5 / 2.2 | 6.1 / 8.1 | 3.8 / 5.0 | 4.0 / 5.9 |
| allocator | 0.4 / 0.0 | 0.7 / 0.0 | 1.4 / 0.3 | 0.9 / 0.3 | 1.1 / 0.4 |
| memcpy/memmove/memset/memcmp/str* | 0.0 / 0.3 | 0.0 / 0.4 | 0.0 / 0.8 | 0.0 / 1.1 | 0.0 / 1.3 |
| Rust generics | 0.6 / 0.0 | 0.5 / 0.0 | 2.4 / 0.0 | 2.1 / 0.0 | 3.4 / 0.0 |
| thread-local | 0.0 / 0.0 | 0.0 / 0.0 | 0.4 / 0.0 | 0.1 / 0.0 | 0.1 / 0.0 |
| unwind / setjmp-longjmp trampolines | 0.0 / 0.0 | 0.0 / 0.2 | 0.0 / 0.4 | 0.0 / 0.3 | 0.0 / 0.3 |
| store: #call | 1.6 / 0.0 | 0.8 / 0.0 | 0.5 / 0.0 | 4.4 / 0.0 | 1.8 / 0.0 |
| store: other JS | 0.1 / 0.7 | 0.1 / 0.2 | 0.1 / 1.0 | 0.6 / 2.9 | 0.4 / 1.3 |
| message I/O JS | 0.6 / 0.0 | 0.3 / 0.0 | 0.9 / 0.0 | 0.3 / 0.0 | 0.3 / 0.0 |
| JS <-> wasm transitions | 0.0 / 0.1 | 0.0 / 0.3 | 0.0 / 1.6 | 0.0 / 0.8 | 0.0 / 0.9 |
| client (pgrust idle in pq_getbyte + PGlite protocol JS) | 3.1 / 2.5 | 2.8 / 2.7 | 13.5 / 12.6 | 2.1 / 2.6 | 2.2 / 2.6 |
| everything else (V8, guest waits, other) | 0.3 / 1.9 | 0.6 / 0.3 | 2.4 / 0.5 | 1.3 / 0.6 | 1.3 / 1.0 |
| **total** | **31.4 / 19.0** | **29.0 / 19.6** | **130.5 / 80.9** | **99.2 / 54.5** | **107.7 / 65.8** |
| ratio | 1.65× | 1.48× | 1.61× | 1.82× | 1.64× |

The per-row tables with each bucket's share of the window and of the difference are
`tables3.md` ("Buckets side by side"). The difference, and the six buckets that carry most of it
(`verdict3.md`):

| row | Suite | pgrust µs/stmt | PGlite µs/stmt | difference | ratio | buckets carrying the difference, µs/stmt (pgrust vs PGlite) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | cold | 136.9 | 54.1 | +82.7 | 2.53× | executor +15.0 (20.9 vs 5.9); tcop/portal/dest +14.4 (16.6 vs 2.2); planner +11.0 (17.2 vs 6.2); analyzer/rewriter +10.6 (14.3 vs 3.7); catalog/syscache +8.8 (11.2 vs 2.4); store: #call +5.7 (5.7 vs 0.0) |
| 1 | warm | 31.4 | 19.0 | +12.3 | 1.65× | executor +3.8 (5.7 vs 1.9); catalog/syscache +2.9 (3.6 vs 0.7); tcop/portal/dest +2.1 (2.4 vs 0.3); analyzer/rewriter +1.7 (2.8 vs 1.2); store: #call +1.6 (1.6 vs 0.0); planner +1.3 (3.1 vs 1.9) |
| 2 | cold | 41.3 | 22.1 | +19.2 | 1.87× | executor +4.2 (6.4 vs 2.2); planner +3.1 (5.8 vs 2.6); tcop/portal/dest +2.5 (3.4 vs 0.9); analyzer/rewriter +1.6 (3.4 vs 1.8); parser +1.3 (2.4 vs 1.1); catalog/syscache +1.1 (2.3 vs 1.2) |
| 2 | warm | 29.0 | 19.6 | +9.4 | 1.48× | executor +2.7 (4.7 vs 1.9); planner +2.2 (4.3 vs 2.1); tcop/portal/dest +1.3 (2.0 vs 0.8); analyzer/rewriter +1.0 (2.3 vs 1.3); catalog/syscache +0.8 (1.9 vs 1.1); store: #call +0.8 (0.8 vs 0.0) |
| 7 | cold | 157.0 | 88.0 | +69.0 | 1.78× | planner +28.9 (42.3 vs 13.4); executor +11.4 (17.9 vs 6.5); catalog/syscache +7.5 (13.5 vs 6.0); analyzer/rewriter +5.6 (11.4 vs 5.8); tcop/portal/dest +4.5 (7.0 vs 2.5); access/index +3.5 (5.2 vs 1.7) |
| 7 | warm | 130.5 | 80.9 | +49.6 | 1.61× | planner +23.3 (35.3 vs 12.1); executor +8.8 (14.6 vs 5.8); catalog/syscache +5.6 (11.7 vs 6.0); analyzer/rewriter +4.0 (8.9 vs 4.9); tcop/portal/dest +3.4 (5.6 vs 2.2); Rust generics +2.4 (2.4 vs 0.0) |
| 9 | cold | 97.1 | 51.8 | +45.3 | 1.87× | planner +17.9 (25.2 vs 7.3); executor +9.8 (14.3 vs 4.6); access/index +4.2 (8.3 vs 4.0); analyzer/rewriter +3.5 (5.8 vs 2.3); catalog/syscache +3.0 (5.7 vs 2.8); tcop/portal/dest +2.4 (3.6 vs 1.2) |
| 9 | warm | 99.2 | 54.5 | +44.7 | 1.82× | planner +17.8 (24.9 vs 7.0); executor +9.5 (14.3 vs 4.8); store: #call +4.4 (4.4 vs 0.0); access/index +3.6 (7.9 vs 4.3); analyzer/rewriter +3.1 (5.5 vs 2.4); catalog/syscache +2.8 (5.7 vs 2.9) |
| 10 | cold | 109.9 | 63.4 | +46.5 | 1.73× | planner +18.7 (26.0 vs 7.3); executor +9.9 (15.0 vs 5.0); analyzer/rewriter +4.0 (6.3 vs 2.3); access/index +3.9 (9.3 vs 5.4); catalog/syscache +3.8 (6.7 vs 3.0); Rust generics +3.1 (3.1 vs 0.0) |
| 10 | warm | 107.7 | 65.8 | +41.9 | 1.64× | planner +17.4 (25.2 vs 7.8); executor +9.7 (14.8 vs 5.1); analyzer/rewriter +4.4 (6.9 vs 2.5); Rust generics +3.4 (3.4 vs 0.0); access/index +3.3 (9.2 vs 5.9); catalog/syscache +3.2 (6.3 vs 3.1) |

Three cautions on reading buckets across the two languages:

- **Self time is per physical frame.** Code inlined by LLVM, clang or Binaryen, or by V8's own wasm
  inliner (on by default), is billed to its caller, so some functions appear on one side only, or
  only cold. PGlite's `parse_analyze_fixedparams` holds 10.9% and 16.5% of cold rows 1 and 2 and is
  on no stack from row 7 on, cold or warm, while its callee `transformStmt` stays
  (`inlined-frames.log`): a frame that vanishes once the code has tiered up.
- **Rust bills generic code to the caller's crate.** pgrust's tree walkers (`NodeWalker` visitors) and
  memory-context allocation are monomorphised into the crates that use them, which is part of why
  pgrust's nodes and memory-context lines are lower than PGlite's and its planner and executor lines
  higher. Summed, planner + nodes + memory contexts + allocator + Rust generics is still 2.04× PGlite's
  on warm row 9 (34.8 against 17.1 µs) and 1.77× on warm row 7 (50.0 against 28.3; `sums3.log`).
- **pgrust's planner time is spread thin.** On warm row 9 it is 146 functions, the top ten 30% of it
  (`get_relation_info` 1.5 µs per statement, `btcostestimate` 0.8, `build_index_paths` 0.8, ...);
  PGlite's is 101 functions, its top ten 40%. On warm row 7, 162 against 96, 28% against 34%
  (`planner-spread.log`; function by function, `fmatch-warm-total.md`).

## 5. The per-statement path, phase by phase

Inclusive time of the functions that bound each phase, where the function is on the stack in both
engines (`phase-matrix3.ts`; `phases-cold.md` and `phases-warm.md` name the functions). pgrust's
planner is timed at `pg_plan_query`, PGlite's at `planner`, because V8 inlines the frames between.

Cold:

| phase (inclusive µs/stmt, pgrust / PGlite) | row 1 | row 2 | row 7 | row 9 | row 10 |
| --- | --- | --- | --- | --- | --- |
| raw parse (raw_parser, the whole text once, per statement) | 6.5 / 1.7 | 3.2 / 1.5 | 2.5 / 2.6 | 1.1 / 1.2 | 1.3 / 1.3 |
| analyze (transformStmt) | 14.6 / 5.4 | 5.1 / 3.4 | 18.5 / 11.5 | 6.8 / 3.8 | 8.6 / 4.5 |
| rewrite (QueryRewrite) | 3.5 / 1.4 | 1.1 / 0.7 | 1.5 / 0.9 | 1.7 / 0.9 | 1.8 / 0.8 |
| plan (pgrust pg_plan_query; C planner) | 25.5 / 13.4 | 9.7 / 3.6 | 62.6 / 30.1 | 35.9 / 16.9 | 38.5 / 17.6 |
| CreatePortal | 1.1 / 0.4 | 0.5 / 0.3 | 0.7 / 0.3 | 0.6 / 0.3 | 0.6 / 0.2 |
| ExecutorStart (standard) | 11.3 / 3.9 | 4.4 / 1.8 | 20.6 / 9.1 | 10.5 / 3.8 | 10.0 / 4.0 |
| ExecutorRun (standard) | 16.5 / 6.5 | 6.0 / 2.5 | 25.1 / 22.8 | 27.6 / 17.7 | 35.2 / 27.2 |
| ExecutorEnd (standard) | 4.1 / 0.7 | 1.4 / 0.4 | 4.1 / 1.3 | 3.8 / 1.5 | 4.0 / 1.5 |
| ProcessUtility | 29.4 / 2.5 | 0.1 / 0.0 | - / - | - / - | - / - |
| PortalDrop | 0.8 / 0.6 | 0.6 / 0.3 | 6.4 / 2.1 | 0.9 / 0.4 | 1.1 / 0.4 |
| CommandCounterIncrement | 2.5 / 0.1 | 0.2 / 0.1 | 0.0 / 0.0 | 0.1 / 0.0 | 0.1 / 0.0 |
| GetTransactionSnapshot | 0.6 / 0.2 | 0.2 / 0.1 | 0.4 / 0.3 | 0.2 / 0.2 | 0.2 / 0.2 |

Warm:

| phase (inclusive µs/stmt, pgrust / PGlite) | row 1 | row 2 | row 7 | row 9 | row 10 |
| --- | --- | --- | --- | --- | --- |
| raw parse (raw_parser, the whole text once, per statement) | 1.1 / 1.3 | 1.5 / 1.5 | 2.5 / 2.9 | 1.2 / 1.3 | 1.4 / 1.5 |
| analyze (transformStmt) | 5.2 / 1.9 | 3.9 / 2.8 | 15.1 / 9.8 | 6.8 / 4.1 | 9.7 / 4.9 |
| rewrite (QueryRewrite) | 1.1 / 0.8 | 0.9 / 0.6 | 1.2 / 1.0 | 1.6 / 0.9 | 1.8 / 0.9 |
| plan (pgrust pg_plan_query; C planner) | 5.6 / 4.0 | 7.1 / 4.9 | 52.4 / 27.1 | 35.6 / 16.6 | 37.4 / 19.4 |
| CreatePortal | 0.4 / 0.3 | 0.4 / 0.2 | 0.6 / 0.4 | 0.7 / 0.2 | 0.6 / 0.3 |
| ExecutorStart (standard) | 4.7 / 1.9 | 3.7 / 2.0 | 17.9 / 8.4 | 10.8 / 4.1 | 9.8 / 4.1 |
| ExecutorRun (standard) | 4.4 / 2.3 | 4.1 / 2.5 | 16.9 / 20.8 | 30.0 / 17.9 | 33.8 / 27.3 |
| ExecutorEnd (standard) | 0.9 / 0.1 | 0.9 / 0.2 | 2.9 / 1.8 | 3.7 / 1.5 | 4.1 / 1.5 |
| ProcessUtility | 1.0 / 0.3 | 0.0 / 0.0 | - / - | - / 0.0 | - / - |
| PortalDrop | 0.4 / 0.4 | 0.5 / 0.2 | 4.9 / 2.3 | 0.9 / 0.4 | 1.0 / 0.4 |
| CommandCounterIncrement | 0.2 / - | 0.1 / 0.0 | 0.0 / 0.1 | 0.1 / 0.0 | 0.1 / 0.0 |
| GetTransactionSnapshot | 0.1 / - | 0.2 / 0.1 | 0.2 / 0.4 | 0.2 / 0.2 | 0.3 / 0.1 |

Read against the multi-statement path (§11): the raw parse, once for the whole text, is level; warm,
the portal, snapshot and command-counter steps are under 1 µs a statement in both engines except
`PortalDrop` on row 7, which frees a bitmap scan's state (pgrust's `drop_glue::<TIDBitmap>` is 1.5 µs
a statement cold). What costs is **analysis, planning, ExecutorStart and ExecutorEnd**: per statement,
whatever the statement does. On warm row 9 those four are +30.6 µs of the +44.7 µs difference, and
the row's own work, ExecutorRun (the index lookup, the update, its index entries, WAL), is +12.1; on
warm row 10 +31.0 and +6.6; on warm row 7 +41.1 and −3.8 (`fixed3.md`). Row 7's ExecutorRun is not
like for like: PGlite's protocol JS runs inside `pgl_send` as the rows are sent (all of its `bytes`
samples), and 84% of `pgl_send` sits under ExecutorRun on that row (`within-pgl_send.log`), while
pgrust's client parses on another thread.

## 6. Top symbols per row

### 6.1 pgrust

Cold, four profiled Runs merged, backend thread. µs per statement as in §4; "idle: client" is the
backend in `pq_getbyte` (§4); generic arguments are elided (`<…>`), the full names are in
`prof/pgrust-cold-slices.md`. The inclusive tables leave out the thread-entry chain.

**Row 1, 1000 INSERTs**: 4 windows, 730.3 ms sampled; unprofiled median 136.9 ms = 136.9 µs per statement.

| # | function (self) | bucket | % | µs/stmt |
| --- | --- | --- | --- | --- |
| 1 | `waitGate [sab-pipe.js:152]` | idle: client | 5.6 | 7.64 |
| 2 | `#call [pglite-opfs-repacked.js:15922]` | store: #call | 4.2 | 5.69 |
| 3 | `utility::dispatch::standard_ProcessUtility` | tcop/portal/dest | 3.9 | 5.37 |
| 4 | `utility::dispatch::slow_switch` | tcop/portal/dest | 1.8 | 2.51 |
| 5 | `postgres::simple_query::exec_simple_query` | tcop/portal/dest | 1.8 | 2.50 |
| 6 | `nodemodifytable::exec_modify_table::<…>` | executor | 1.7 | 2.26 |
| 7 | `nodemodifytable::exec_insert::<…>` | executor | 1.3 | 1.80 |
| 8 | `rewrite_handler::RewriteQuery` | analyzer/rewriter | 1.3 | 1.74 |
| 9 | `<gram_core::parse::Parser>::reduce_cold` | parser | 1.2 | 1.71 |
| 10 | `parser_analyze::transformInsertStmt` | analyzer/rewriter | 1.2 | 1.64 |
| 11 | `nodemodifytable::exec_init_modify_table` | executor | 1.2 | 1.64 |
| 12 | `tablecmds::DefineRelation` | commands | 1.1 | 1.51 |
| 13 | `planner::createplan::create_plan_recurse` | planner | 1.1 | 1.45 |
| 14 | `<scan_fgram::Scanner>::core_yylex` | parser | 1.0 | 1.35 |
| 15 | `planner::grouping::grouping_planner` | planner | 1.0 | 1.35 |
| 16 | `planner::subselect::finalize_plan` | planner | 1.0 | 1.33 |
| 17 | `stack_depth_core::with_own_frame::<…>` | executor | 0.9 | 1.20 |
| 18 | `execmain::execmain::standard_executor_start` | executor | 0.9 | 1.17 |
| 19 | `parse_utilcmd::transformCreateStmt` | analyzer/rewriter | 0.8 | 1.15 |
| 20 | `relcache::invalidate::RelationCacheInvalidateEntry` | catalog/caches | 0.8 | 1.15 |
| 21 | `planner::subquery::subquery_planner` | planner | 0.8 | 1.11 |
| 22 | `catalog_heap::create::heap_create_with_catalog` | catalog/caches | 0.8 | 1.06 |
| 23 | `<gram_core::parse::Parser>::yyparse` | parser | 0.8 | 1.04 |
| 24 | `parser_analyze::transformStmt` | analyzer/rewriter | 0.7 | 0.96 |
| 25 | `nodemodifytable::init_result_rel` | executor | 0.7 | 0.93 |
| 26 | `pquery::PortalRun` | tcop/portal/dest | 0.7 | 0.91 |
| 27 | `(garbage collector)` | V8 | 0.7 | 0.90 |
| 28 | `stack_depth_core::with_own_frame::<…>` | executor | 0.6 | 0.86 |
| 29 | `clauses::fold::simplify_function` | planner | 0.6 | 0.86 |
| 30 | `planner::setrefs::set_plan_refs` | planner | 0.6 | 0.86 |

| # | function (inclusive) | % | µs/stmt |
| --- | --- | --- | --- |
| 1 | `postgres::main_loop::PostgresMain` | 99.2 | 135.74 |
| 2 | `postgres::main_loop::dispatch_message` | 93.1 | 127.40 |
| 3 | `postgres::simple_query::exec_simple_query` | 92.7 | 126.87 |
| 4 | `pquery::PortalRun` | 48.3 | 66.09 |
| 5 | `pquery::PortalRunMulti` | 47.5 | 65.01 |
| 6 | `pquery::PortalRunUtility` | 21.5 | 29.47 |
| 7 | `utility::dispatch::ProcessUtility` | 21.5 | 29.39 |
| 8 | `utility::dispatch::standard_ProcessUtility` | 21.4 | 29.28 |
| 9 | `execmain::querydesc::with_qd_dyn` | 20.4 | 27.88 |
| 10 | `postgres::simple_query::pg_plan_query` | 18.6 | 25.49 |
| 11 | `<planner::init_seams::{closure#0} as core::ops::function::FnOnce<…>>::call_once` | 18.4 | 25.12 |
| 12 | `utility::dispatch::dispatch_switch` | 17.5 | 23.91 |
| 13 | `utility::dispatch::process_utility_slow` | 17.4 | 23.79 |
| 14 | `utility::dispatch::slow_switch` | 16.0 | 21.88 |
| 15 | `postgres::simple_query::pg_analyze_and_rewrite_fixedparams` | 13.7 | 18.79 |

**Row 2, 25000 INSERTs in a transaction**: 4 windows, 5155.5 ms sampled; unprofiled median 1033.4 ms = 41.3 µs per statement.

| # | function (self) | bucket | % | µs/stmt |
| --- | --- | --- | --- | --- |
| 1 | `waitGate [sab-pipe.js:152]` | idle: client | 7.9 | 3.28 |
| 2 | `#call [pglite-opfs-repacked.js:15922]` | store: #call | 2.6 | 1.08 |
| 3 | `postgres::simple_query::exec_simple_query` | tcop/portal/dest | 2.3 | 0.96 |
| 4 | `<gram_core::parse::Parser>::yyparse` | parser | 2.1 | 0.87 |
| 5 | `<scan_fgram::Scanner>::core_yylex` | parser | 1.9 | 0.77 |
| 6 | `cache_syscache::projections::lookup_pg_type_shape` | catalog/caches | 1.2 | 0.50 |
| 7 | `<mcx::Mcx>::alloc_uninit_bytes` | mcx/palloc | 1.1 | 0.44 |
| 8 | `dlmalloc` | allocator | 1.1 | 0.44 |
| 9 | `<planner::init_seams::{closure#0} as core::ops::function::FnOnce<…>>::call_once` | planner | 1.0 | 0.42 |
| 10 | `execmain::execmain::standard_executor_start` | executor | 1.0 | 0.40 |
| 11 | `planner::subquery::subquery_planner` | planner | 0.9 | 0.39 |
| 12 | `planner::grouping::grouping_planner` | planner | 0.9 | 0.38 |
| 13 | `planner::createplan::create_modifytable_plan` | planner | 0.9 | 0.38 |
| 14 | `parser_analyze::transformInsertStmt` | analyzer/rewriter | 0.8 | 0.35 |
| 15 | `<gram_core::parse::Parser>::reduce_cold` | parser | 0.8 | 0.34 |
| 16 | `relcache::store::RelationIdGetRelation` | catalog/caches | 0.8 | 0.34 |
| 17 | `nodemodifytable::exec_modify_table::<…>` | executor | 0.8 | 0.33 |
| 18 | `execmain::execmain::init_plan` | executor | 0.8 | 0.33 |
| 19 | `nodemodifytable::exec_init_modify_table` | executor | 0.8 | 0.32 |
| 20 | `pquery::PortalRunMulti` | tcop/portal/dest | 0.8 | 0.32 |
| 21 | `nodemodifytable::exec_insert::<…>` | executor | 0.7 | 0.29 |
| 22 | `dlfree` | allocator | 0.7 | 0.28 |
| 23 | `nodemodifytable::init_result_rel` | executor | 0.7 | 0.28 |
| 24 | `crc32c::sb8::pg_comp_crc32c_sb8` | xact/WAL | 0.7 | 0.28 |
| 25 | `<gram_core::parse::Parser>::reduce` | parser | 0.7 | 0.28 |
| 26 | `<types_nodes::list::List<…>>::first_cell_alloc` | nodes | 0.7 | 0.28 |
| 27 | `rewrite_handler::RewriteQuery` | analyzer/rewriter | 0.7 | 0.27 |
| 28 | `planner::subselect::finalize_plan` | planner | 0.7 | 0.27 |
| 29 | `portalmem::CreatePortal` | tcop/portal/dest | 0.6 | 0.26 |
| 30 | `stack_depth_core::with_own_frame::<…>` | executor | 0.6 | 0.26 |

| # | function (inclusive) | % | µs/stmt |
| --- | --- | --- | --- |
| 1 | `postgres::main_loop::PostgresMain` | 99.7 | 41.20 |
| 2 | `postgres::main_loop::dispatch_message` | 91.2 | 37.69 |
| 3 | `postgres::simple_query::exec_simple_query` | 89.6 | 37.04 |
| 4 | `pquery::PortalRun` | 32.7 | 13.53 |
| 5 | `pquery::PortalRunMulti` | 32.1 | 13.27 |
| 6 | `execmain::querydesc::with_qd_dyn` | 25.4 | 10.50 |
| 7 | `postgres::simple_query::pg_plan_query` | 23.5 | 9.73 |
| 8 | `<planner::init_seams::{closure#0} as core::ops::function::FnOnce<…>>::call_once` | 23.1 | 9.54 |
| 9 | `planner::subquery::subquery_planner` | 16.5 | 6.81 |
| 10 | `postgres::simple_query::pg_analyze_and_rewrite_fixedparams` | 16.0 | 6.63 |
| 11 | `execmain::execmain::executor_run_seam` | 14.5 | 6.01 |
| 12 | `execmain::querydesc::with_qd::<…>::{closure#0}` | 14.3 | 5.90 |
| 13 | `execmain::execmain::execute_plan` | 14.1 | 5.81 |
| 14 | `execmain::procnode::exec_proc_node` | 13.7 | 5.65 |
| 15 | `nodemodifytable::exec_modify_table::<…>` | 13.5 | 5.57 |

**Row 7, 5000 SELECTs with an index**: 4 windows, 4085.4 ms sampled; unprofiled median 784.8 ms = 157.0 µs per statement.

| # | function (self) | bucket | % | µs/stmt |
| --- | --- | --- | --- | --- |
| 1 | `waitGate [sab-pipe.js:152]` | idle: client | 7.6 | 11.88 |
| 2 | `nodeagg::exec_init_agg` | executor | 1.5 | 2.34 |
| 3 | `planner::plancat::get_relation_info` | planner | 1.2 | 1.93 |
| 4 | `cache_syscache::projections::lookup_pg_type_shape` | catalog/caches | 1.0 | 1.49 |
| 5 | `nbtree::search::bt_first` | nbtree/indexam | 0.8 | 1.33 |
| 6 | `planner::selfuncs::btcostestimate` | planner | 0.8 | 1.29 |
| 7 | `planner::createplan::create_scan_plan` | planner | 0.8 | 1.21 |
| 8 | `<gram_core::parse::Parser>::yyparse` | parser | 0.8 | 1.20 |
| 9 | `planner::prepagg::preprocess_aggref` | planner | 0.8 | 1.19 |
| 10 | `indxpath::build_index_paths` | planner | 0.7 | 1.17 |
| 11 | `parse_func::ParseFuncOrColumn` | analyzer/rewriter | 0.7 | 1.14 |
| 12 | `cache_syscache::SearchSysCache1` | catalog/caches | 0.7 | 1.11 |
| 13 | `dlmalloc` | allocator | 0.7 | 1.08 |
| 14 | `<mcx::Mcx as allocator_api2::stable::alloc::Allocator>::deallocate` | mcx/palloc | 0.7 | 1.06 |
| 15 | `arrayfuncs::io::array_in` | fmgr/adt | 0.7 | 1.06 |
| 16 | `catalog_namespace::lookup::FuncnameGetCandidatesExtended` | catalog/caches | 0.7 | 1.03 |
| 17 | `postgres::simple_query::exec_simple_query` | tcop/portal/dest | 0.7 | 1.02 |
| 18 | `planner::grouping::create_ordinary_grouping_paths` | planner | 0.6 | 1.01 |
| 19 | `parse_expr::transformExprRecurse` | analyzer/rewriter | 0.6 | 0.99 |
| 20 | `costsize::cost_index` | planner | 0.6 | 0.96 |
| 21 | `bufmgr::read::BufferAlloc` | bufmgr | 0.6 | 0.95 |
| 22 | `cache_syscache::projections::lookup_pg_proc_shape` | catalog/caches | 0.6 | 0.94 |
| 23 | `planner::subquery::subquery_planner` | planner | 0.6 | 0.93 |
| 24 | `<mcx::Mcx>::alloc_uninit_bytes` | mcx/palloc | 0.6 | 0.92 |
| 25 | `relcache::store::RelationIdGetRelation` | catalog/caches | 0.6 | 0.90 |
| 26 | `heapam::bitmap::bitmap_next_block` | heap | 0.6 | 0.89 |
| 27 | `heapam::fetch::heap_hot_search_buffer` | heap | 0.6 | 0.88 |
| 28 | `cache_syscache::projections::lookup_pg_proc_name_candidates` | catalog/caches | 0.5 | 0.84 |
| 29 | `planner::initsplan::deconstruct_jointree` | planner | 0.5 | 0.77 |
| 30 | `cache_syscache::projections::lookup_pg_aggregate_shape` | catalog/caches | 0.5 | 0.75 |

| # | function (inclusive) | % | µs/stmt |
| --- | --- | --- | --- |
| 1 | `postgres::main_loop::PostgresMain` | 99.8 | 156.65 |
| 2 | `postgres::main_loop::dispatch_message` | 92.2 | 144.66 |
| 3 | `postgres::simple_query::exec_simple_query` | 91.9 | 144.22 |
| 4 | `postgres::simple_query::pg_plan_query` | 39.9 | 62.61 |
| 5 | `<planner::init_seams::{closure#0} as core::ops::function::FnOnce<…>>::call_once` | 39.7 | 62.36 |
| 6 | `planner::subquery::subquery_planner` | 34.3 | 53.78 |
| 7 | `planner::grouping::grouping_planner` | 30.6 | 48.00 |
| 8 | `execmain::querydesc::with_qd_dyn` | 29.2 | 45.78 |
| 9 | `planner::planmain::query_planner` | 20.7 | 32.49 |
| 10 | `pquery::PortalRun` | 16.5 | 25.92 |
| 11 | `pquery::PortalRunSelect` | 16.2 | 25.42 |
| 12 | `execmain::execmain::executor_run_seam` | 16.0 | 25.09 |
| 13 | `execmain::querydesc::with_qd::<…>::{closure#0}` | 15.8 | 24.86 |
| 14 | `pquery::PortalStart` | 13.9 | 21.82 |
| 15 | `execmain::execmain::execute_plan` | 13.7 | 21.47 |

**Row 9, 25000 UPDATEs with an index**: 4 windows, 12278.0 ms sampled; unprofiled median 2427.8 ms = 97.1 µs per statement.

| # | function (self) | bucket | % | µs/stmt |
| --- | --- | --- | --- | --- |
| 1 | `waitGate [sab-pipe.js:152]` | idle: client | 2.2 | 2.18 |
| 2 | `#call [pglite-opfs-repacked.js:15922]` | store: #call | 1.9 | 1.83 |
| 3 | `nbtree::search::bt_compare` | nbtree/indexam | 1.8 | 1.75 |
| 4 | `planner::plancat::get_relation_info` | planner | 1.6 | 1.59 |
| 5 | `indxpath::build_index_paths` | planner | 0.9 | 0.91 |
| 6 | `nbtree::search::bt_first` | nbtree/indexam | 0.9 | 0.90 |
| 7 | `heapam::dml::heap_update` | heap | 0.9 | 0.89 |
| 8 | `indexam::index_insert` | nbtree/indexam | 0.8 | 0.78 |
| 9 | `relcache::store::RelationIdGetRelation` | catalog/caches | 0.8 | 0.77 |
| 10 | `planner::grouping::grouping_planner` | planner | 0.8 | 0.74 |
| 11 | `planner::selfuncs::btcostestimate` | planner | 0.7 | 0.71 |
| 12 | `xloginsert::insert_record` | xact/WAL | 0.7 | 0.70 |
| 13 | `transam_xlog::insert::XLogInsertRecord` | xact/WAL | 0.7 | 0.69 |
| 14 | `postgres::simple_query::exec_simple_query` | tcop/portal/dest | 0.7 | 0.68 |
| 15 | `planner::subquery::subquery_planner` | planner | 0.7 | 0.68 |
| 16 | `planner::initsplan::deconstruct_jointree` | planner | 0.7 | 0.67 |
| 17 | `bufmgr::read::BufferAlloc` | bufmgr | 0.7 | 0.67 |
| 18 | `crc32c::sb8::pg_comp_crc32c_sb8` | xact/WAL | 0.7 | 0.65 |
| 19 | `execmain::execmain::standard_executor_start` | executor | 0.7 | 0.64 |
| 20 | `nodemodifytable::exec_init_modify_table` | executor | 0.6 | 0.62 |
| 21 | `costsize::cost_index` | planner | 0.6 | 0.61 |
| 22 | `dlmalloc` | allocator | 0.6 | 0.58 |
| 23 | `planner::grouping::grouping_planner_tail` | planner | 0.6 | 0.58 |
| 24 | `nodemodifytable::init_result_rel` | executor | 0.6 | 0.56 |
| 25 | `<planner::init_seams::{closure#0} as core::ops::function::FnOnce<…>>::call_once` | planner | 0.6 | 0.55 |
| 26 | `<mcx::Mcx as allocator_api2::stable::alloc::Allocator>::deallocate` | mcx/palloc | 0.6 | 0.55 |
| 27 | `planner::createplan::create_scan_plan` | planner | 0.5 | 0.53 |
| 28 | `rewrite_handler::RewriteQuery` | analyzer/rewriter | 0.5 | 0.52 |
| 29 | `cache_syscache::projections::lookup_pg_type_shape` | catalog/caches | 0.5 | 0.51 |
| 30 | `planner::createplan::create_modifytable_plan` | planner | 0.5 | 0.51 |

| # | function (inclusive) | % | µs/stmt |
| --- | --- | --- | --- |
| 1 | `postgres::main_loop::PostgresMain` | 99.8 | 96.89 |
| 2 | `postgres::main_loop::dispatch_message` | 97.5 | 94.67 |
| 3 | `postgres::simple_query::exec_simple_query` | 97.1 | 94.33 |
| 4 | `pquery::PortalRun` | 45.2 | 43.90 |
| 5 | `pquery::PortalRunMulti` | 44.8 | 43.52 |
| 6 | `execmain::querydesc::with_qd_dyn` | 39.3 | 38.18 |
| 7 | `postgres::simple_query::pg_plan_query` | 37.0 | 35.95 |
| 8 | `<planner::init_seams::{closure#0} as core::ops::function::FnOnce<…>>::call_once` | 36.7 | 35.68 |
| 9 | `planner::subquery::subquery_planner` | 30.2 | 29.31 |
| 10 | `execmain::execmain::executor_run_seam` | 28.4 | 27.62 |
| 11 | `execmain::querydesc::with_qd::<…>::{closure#0}` | 28.3 | 27.49 |
| 12 | `execmain::execmain::execute_plan` | 28.2 | 27.41 |
| 13 | `execmain::procnode::exec_proc_node` | 27.8 | 27.02 |
| 14 | `nodemodifytable::exec_modify_table::<…>` | 27.6 | 26.84 |
| 15 | `planner::grouping::grouping_planner` | 27.3 | 26.56 |

**Row 10, 25000 text UPDATEs with an index**: 4 windows, 13952.5 ms sampled; unprofiled median 2747.4 ms = 109.9 µs per statement.

| # | function (self) | bucket | % | µs/stmt |
| --- | --- | --- | --- | --- |
| 1 | `#call [pglite-opfs-repacked.js:15922]` | store: #call | 2.8 | 3.03 |
| 2 | `tableam::table_index_delete_tuples` | heap | 2.6 | 2.89 |
| 3 | `waitGate [sab-pipe.js:152]` | idle: client | 2.2 | 2.42 |
| 4 | `nbtree::search::bt_compare` | nbtree/indexam | 1.6 | 1.79 |
| 5 | `planner::plancat::get_relation_info` | planner | 1.5 | 1.64 |
| 6 | `relcache::store::RelationIdGetRelation` | catalog/caches | 0.7 | 0.81 |
| 7 | `heapam::dml::heap_update` | heap | 0.7 | 0.80 |
| 8 | `indexam::index_insert` | nbtree/indexam | 0.7 | 0.80 |
| 9 | `indxpath::build_index_paths` | planner | 0.7 | 0.77 |
| 10 | `planner::selfuncs::btcostestimate` | planner | 0.7 | 0.77 |
| 11 | `xloginsert::insert_record` | xact/WAL | 0.7 | 0.76 |
| 12 | `nbtree::search::bt_first` | nbtree/indexam | 0.7 | 0.76 |
| 13 | `postgres::simple_query::exec_simple_query` | tcop/portal/dest | 0.7 | 0.75 |
| 14 | `transam_xlog::insert::XLogInsertRecord` | xact/WAL | 0.7 | 0.73 |
| 15 | `dlmalloc` | allocator | 0.7 | 0.73 |
| 16 | `bufmgr::read::BufferAlloc` | bufmgr | 0.6 | 0.71 |
| 17 | `planner::grouping::grouping_planner` | planner | 0.6 | 0.71 |
| 18 | `core::slice::sort::unstable::quicksort::quicksort::<…>` | Rust generics | 0.6 | 0.65 |
| 19 | `cache_syscache::projections::lookup_pg_type_shape` | catalog/caches | 0.6 | 0.65 |
| 20 | `crc32c::sb8::pg_comp_crc32c_sb8` | xact/WAL | 0.6 | 0.64 |
| 21 | `planner::subquery::subquery_planner` | planner | 0.6 | 0.64 |
| 22 | `planner::createplan::create_modifytable_plan` | planner | 0.6 | 0.64 |
| 23 | `nodemodifytable::exec_init_modify_table` | executor | 0.6 | 0.63 |
| 24 | `execmain::execmain::standard_executor_start` | executor | 0.6 | 0.63 |
| 25 | `planner::initsplan::deconstruct_jointree` | planner | 0.6 | 0.62 |
| 26 | `<mcx::Mcx as allocator_api2::stable::alloc::Allocator>::deallocate` | mcx/palloc | 0.6 | 0.61 |
| 27 | `planner::grouping::grouping_planner_tail` | planner | 0.5 | 0.59 |
| 28 | `rewrite_handler::RewriteQuery` | analyzer/rewriter | 0.5 | 0.57 |
| 29 | `nodemodifytable::init_result_rel` | executor | 0.5 | 0.56 |
| 30 | `planner::createplan::create_scan_plan` | planner | 0.5 | 0.56 |

| # | function (inclusive) | % | µs/stmt |
| --- | --- | --- | --- |
| 1 | `postgres::main_loop::PostgresMain` | 99.8 | 109.71 |
| 2 | `postgres::main_loop::dispatch_message` | 97.5 | 107.18 |
| 3 | `postgres::simple_query::exec_simple_query` | 97.2 | 106.82 |
| 4 | `pquery::PortalRun` | 46.7 | 51.28 |
| 5 | `pquery::PortalRunMulti` | 46.2 | 50.83 |
| 6 | `execmain::querydesc::with_qd_dyn` | 41.1 | 45.20 |
| 7 | `postgres::simple_query::pg_plan_query` | 35.1 | 38.52 |
| 8 | `<planner::init_seams::{closure#0} as core::ops::function::FnOnce<…>>::call_once` | 34.8 | 38.27 |
| 9 | `execmain::execmain::executor_run_seam` | 32.0 | 35.16 |
| 10 | `execmain::querydesc::with_qd::<…>::{closure#0}` | 31.9 | 35.01 |
| 11 | `execmain::execmain::execute_plan` | 31.8 | 34.90 |
| 12 | `execmain::procnode::exec_proc_node` | 31.5 | 34.63 |
| 13 | `nodemodifytable::exec_modify_table::<…>` | 31.3 | 34.38 |
| 14 | `planner::subquery::subquery_planner` | 28.8 | 31.66 |
| 15 | `planner::grouping::grouping_planner` | 24.5 | 26.90 |

### 6.2 PGlite, the same rows

Cold, four profiled Runs merged, node's main thread. `client JS` is PGlite's protocol code
(`chunk-*.js` of the installed package); `bsearch` is called from the expression interpreter
(`ExecInterpExprStillValid` in 96% of its samples, `callers-bsearch.log`). The `invoke_*` frames in the
inclusive tables are emscripten's setjmp trampolines: PostgreSQL code called inside a `PG_TRY` runs
under them; their own self time is the unwind/setjmp line of §4, 0.0–0.4 µs a statement.

**Row 1, 1000 INSERTs**: 4 windows, 211.5 ms sampled; unprofiled median 54.1 ms = 54.1 µs per statement.

| # | function (self) | bucket | % | µs/stmt |
| --- | --- | --- | --- | --- |
| 1 | `(program)` | V8 | 4.8 | 2.60 |
| 2 | `AllocSetAlloc` | mcx/palloc | 3.5 | 1.90 |
| 3 | `subquery_planner` | planner | 3.0 | 1.62 |
| 4 | `palloc0` | mcx/palloc | 2.9 | 1.57 |
| 5 | `js-to-wasm` | JS<->wasm | 2.3 | 1.22 |
| 6 | `bytes [chunk-2BOC2OMW.js:1]` | client JS | 1.9 | 1.02 |
| 7 | `parse [chunk-2BOC2OMW.js:1]` | client JS | 1.9 | 1.01 |
| 8 | `pfree` | mcx/palloc | 1.6 | 0.87 |
| 9 | `bsearch` | other | 1.4 | 0.78 |
| 10 | `raw_parser` | parser | 1.3 | 0.73 |
| 11 | `(anonymous) [chunk-2BOC2OMW.js:1]` | client JS | 1.2 | 0.64 |
| 12 | `ExecInterpExprStillValid` | executor | 1.2 | 0.64 |
| 13 | `ExecInitNode` | executor | 1.2 | 0.64 |
| 14 | `pg_comp_crc32c_sb8` | xact/WAL | 1.2 | 0.64 |
| 15 | `h [chunk-QY3QWFKW.js:1]` | client JS | 1.2 | 0.63 |
| 16 | `palloc` | mcx/palloc | 1.1 | 0.58 |
| 17 | `core_yylex` | parser | 1.1 | 0.57 |
| 18 | `SearchCatCacheInternal` | catalog/caches | 1.0 | 0.56 |
| 19 | `expression_tree_mutator_impl` | nodes | 1.0 | 0.56 |
| 20 | `rt [chunk-2BOC2OMW.js:1]` | client JS | 1.0 | 0.55 |

| # | function (inclusive) | % | µs/stmt |
| --- | --- | --- | --- |
| 1 | `PostgresMainLoopOnce` | 85.8 | 46.43 |
| 2 | `PortalRun` | 31.1 | 16.84 |
| 3 | `wasm-to-js` | 28.4 | 15.37 |
| 4 | `invoke_viiiiii [index.js:3]` | 28.1 | 15.21 |
| 5 | `PortalRunMulti` | 27.0 | 14.62 |
| 6 | `pg_plan_queries` | 25.1 | 13.58 |
| 7 | `standard_planner` | 24.8 | 13.42 |
| 8 | `planner` | 24.8 | 13.42 |
| 9 | `ProcessQuery` | 21.7 | 11.73 |
| 10 | `subquery_planner` | 18.4 | 9.94 |

**Row 2, 25000 INSERTs in a transaction**: 4 windows, 2354.9 ms sampled; unprofiled median 552.5 ms = 22.1 µs per statement.

| # | function (self) | bucket | % | µs/stmt |
| --- | --- | --- | --- | --- |
| 1 | `AllocSetAlloc` | mcx/palloc | 5.4 | 1.20 |
| 2 | `bytes [chunk-2BOC2OMW.js:1]` | client JS | 3.3 | 0.73 |
| 3 | `palloc0` | mcx/palloc | 3.2 | 0.71 |
| 4 | `raw_parser` | parser | 2.7 | 0.60 |
| 5 | `subquery_planner` | planner | 2.4 | 0.54 |
| 6 | `SearchCatCacheInternal` | catalog/caches | 2.4 | 0.53 |
| 7 | `core_yylex` | parser | 2.3 | 0.50 |
| 8 | `expression_tree_walker_impl` | nodes | 2.3 | 0.50 |
| 9 | `(anonymous) [chunk-2BOC2OMW.js:1]` | client JS | 1.6 | 0.36 |
| 10 | `hash_search_with_hash_value` | utils | 1.5 | 0.33 |
| 11 | `PostgresMainLoopOnce` | tcop/portal/dest | 1.3 | 0.30 |
| 12 | `P [chunk-2BOC2OMW.js:1]` | client JS | 1.3 | 0.29 |
| 13 | `n [chunk-QY3QWFKW.js:1]` | client JS | 1.2 | 0.27 |
| 14 | `pg_comp_crc32c_sb8` | xact/WAL | 1.1 | 0.24 |
| 15 | `ExecInitNode` | executor | 1.1 | 0.23 |
| 16 | `ResourceOwnerForget` | utils | 1.0 | 0.23 |
| 17 | `lappend` | nodes | 1.0 | 0.22 |
| 18 | `AllocSetFree` | mcx/palloc | 1.0 | 0.21 |
| 19 | `wasm-to-js` | JS<->wasm | 0.9 | 0.20 |
| 20 | `bsearch` | other | 0.9 | 0.20 |

| # | function (inclusive) | % | µs/stmt |
| --- | --- | --- | --- |
| 1 | `PostgresMainLoopOnce` | 94.7 | 20.93 |
| 2 | `wasm-to-js` | 36.7 | 8.10 |
| 3 | `PortalRun` | 26.3 | 5.82 |
| 4 | `invoke_viiiiii [index.js:3]` | 24.8 | 5.49 |
| 5 | `PortalRunMulti` | 24.5 | 5.41 |
| 6 | `pg_plan_queries` | 24.4 | 5.39 |
| 7 | `standard_planner` | 24.0 | 5.31 |
| 8 | `ProcessQuery` | 22.9 | 5.07 |
| 9 | `subquery_planner` | 17.2 | 3.81 |
| 10 | `parse_analyze_fixedparams` | 16.5 | 3.65 |

**Row 7, 5000 SELECTs with an index**: 4 windows, 1822.2 ms sampled; unprofiled median 439.9 ms = 88.0 µs per statement.

| # | function (self) | bucket | % | µs/stmt |
| --- | --- | --- | --- | --- |
| 1 | `AllocSetAlloc` | mcx/palloc | 4.0 | 3.52 |
| 2 | `bytes [chunk-2BOC2OMW.js:1]` | client JS | 3.6 | 3.15 |
| 3 | `SearchCatCacheInternal` | catalog/caches | 3.2 | 2.85 |
| 4 | `expression_tree_walker_impl` | nodes | 3.1 | 2.72 |
| 5 | `n [chunk-QY3QWFKW.js:1]` | client JS | 2.1 | 1.87 |
| 6 | `palloc0` | mcx/palloc | 2.0 | 1.74 |
| 7 | `raw_parser` | parser | 1.7 | 1.45 |
| 8 | `h [chunk-QY3QWFKW.js:1]` | client JS | 1.5 | 1.29 |
| 9 | `_fd_seek [index.js:3]` | store: JS | 1.2 | 1.07 |
| 10 | `subquery_planner` | planner | 1.0 | 0.92 |
| 11 | `ExecInitNode` | executor | 1.0 | 0.92 |
| 12 | `transformExprRecurse` | analyzer/rewriter | 1.0 | 0.90 |
| 13 | `hash_search_with_hash_value` | utils | 1.0 | 0.88 |
| 14 | `PostgresMainLoopOnce` | tcop/portal/dest | 1.0 | 0.85 |
| 15 | `(garbage collector)` | V8 | 0.9 | 0.83 |
| 16 | `palloc` | mcx/palloc | 0.8 | 0.74 |
| 17 | `lappend` | nodes | 0.8 | 0.74 |
| 18 | `AllocSetFree` | mcx/palloc | 0.8 | 0.73 |
| 19 | `query_planner` | planner | 0.8 | 0.71 |
| 20 | `core_yylex` | parser | 0.7 | 0.65 |

| # | function (inclusive) | % | µs/stmt |
| --- | --- | --- | --- |
| 1 | `PostgresMainLoopOnce` | 96.7 | 85.08 |
| 2 | `wasm-to-js` | 36.6 | 32.19 |
| 3 | `planner` | 34.2 | 30.09 |
| 4 | `standard_planner` | 34.1 | 29.99 |
| 5 | `subquery_planner` | 29.1 | 25.63 |
| 6 | `PortalRun` | 26.9 | 23.68 |
| 7 | `invoke_jiiii [index.js:3]` | 26.4 | 23.24 |
| 8 | `PortalRunSelect` | 26.1 | 22.97 |
| 9 | `ExecutorRun` | 26.0 | 22.88 |
| 10 | `standard_ExecutorRun` | 25.9 | 22.80 |

**Row 9, 25000 UPDATEs with an index**: 4 windows, 5346.3 ms sampled; unprofiled median 1295.8 ms = 51.8 µs per statement.

| # | function (self) | bucket | % | µs/stmt |
| --- | --- | --- | --- | --- |
| 1 | `AllocSetAlloc` | mcx/palloc | 3.8 | 1.98 |
| 2 | `expression_tree_walker_impl` | nodes | 2.4 | 1.22 |
| 3 | `_bt_compare` | nbtree/indexam | 2.3 | 1.19 |
| 4 | `hash_search_with_hash_value` | utils | 2.3 | 1.17 |
| 5 | `palloc0` | mcx/palloc | 1.8 | 0.94 |
| 6 | `SearchCatCacheInternal` | catalog/caches | 1.7 | 0.89 |
| 7 | `subquery_planner` | planner | 1.6 | 0.84 |
| 8 | `bytes [chunk-2BOC2OMW.js:1]` | client JS | 1.2 | 0.64 |
| 9 | `AllocSetFree` | mcx/palloc | 1.2 | 0.61 |
| 10 | `wasm-to-js` | JS<->wasm | 1.2 | 0.60 |
| 11 | `pg_comp_crc32c_sb8` | xact/WAL | 1.2 | 0.60 |
| 12 | `raw_parser` | parser | 1.1 | 0.59 |
| 13 | `XLogInsert` | xact/WAL | 1.1 | 0.55 |
| 14 | `PostgresMainLoopOnce` | tcop/portal/dest | 1.0 | 0.50 |
| 15 | `ExecInitNode` | executor | 0.9 | 0.49 |
| 16 | `query_planner` | planner | 0.9 | 0.45 |
| 17 | `bms_add_member` | nodes | 0.9 | 0.44 |
| 18 | `ResourceOwnerForget` | utils | 0.8 | 0.42 |
| 19 | `lappend` | nodes | 0.8 | 0.41 |
| 20 | `core_yylex` | parser | 0.8 | 0.40 |

| # | function (inclusive) | % | µs/stmt |
| --- | --- | --- | --- |
| 1 | `PostgresMainLoopOnce` | 98.2 | 50.92 |
| 2 | `wasm-to-js` | 52.9 | 27.42 |
| 3 | `PortalRun` | 47.1 | 24.41 |
| 4 | `invoke_viiiiii [index.js:3]` | 46.2 | 23.93 |
| 5 | `PortalRunMulti` | 45.9 | 23.80 |
| 6 | `ProcessQuery` | 45.1 | 23.40 |
| 7 | `ExecutorRun` | 34.1 | 17.70 |
| 8 | `standard_ExecutorRun` | 34.1 | 17.65 |
| 9 | `ExecModifyTable` | 33.5 | 17.37 |
| 10 | `planner` | 32.6 | 16.89 |

**Row 10, 25000 text UPDATEs with an index**: 4 windows, 6604.6 ms sampled; unprofiled median 1584.7 ms = 63.4 µs per statement.

| # | function (self) | bucket | % | µs/stmt |
| --- | --- | --- | --- | --- |
| 1 | `heap_index_delete_tuples` | heap | 5.0 | 3.16 |
| 2 | `AllocSetAlloc` | mcx/palloc | 3.2 | 2.05 |
| 3 | `_bt_compare` | nbtree/indexam | 2.3 | 1.47 |
| 4 | `expression_tree_walker_impl` | nodes | 2.3 | 1.46 |
| 5 | `expandFileStorage [index.js:2]` | store: JS | 2.1 | 1.34 |
| 6 | `hash_search_with_hash_value` | utils | 1.9 | 1.19 |
| 7 | `palloc0` | mcx/palloc | 1.8 | 1.14 |
| 8 | `pg_qsort` | utils | 1.7 | 1.09 |
| 9 | `SearchCatCacheInternal` | catalog/caches | 1.7 | 1.08 |
| 10 | `subquery_planner` | planner | 1.2 | 0.75 |
| 11 | `_bt_delete_or_dedup_one_page` | nbtree/indexam | 1.1 | 0.72 |
| 12 | `bytes [chunk-2BOC2OMW.js:1]` | client JS | 1.1 | 0.71 |
| 13 | `bottomup_sort_and_shrink_cmp` | heap | 1.0 | 0.65 |
| 14 | `memmove` | mem*/str* | 1.0 | 0.63 |
| 15 | `pg_comp_crc32c_sb8` | xact/WAL | 1.0 | 0.61 |
| 16 | `AllocSetFree` | mcx/palloc | 0.9 | 0.59 |
| 17 | `ExecInitNode` | executor | 0.9 | 0.58 |
| 18 | `wasm-to-js` | JS<->wasm | 0.9 | 0.57 |
| 19 | `raw_parser` | parser | 0.9 | 0.56 |
| 20 | `XLogInsert` | xact/WAL | 0.9 | 0.54 |

| # | function (inclusive) | % | µs/stmt |
| --- | --- | --- | --- |
| 1 | `PostgresMainLoopOnce` | 98.2 | 62.23 |
| 2 | `wasm-to-js` | 58.6 | 37.15 |
| 3 | `PortalRun` | 53.7 | 34.03 |
| 4 | `invoke_viiiiii [index.js:3]` | 53.1 | 33.63 |
| 5 | `PortalRunMulti` | 52.8 | 33.48 |
| 6 | `ProcessQuery` | 52.3 | 33.13 |
| 7 | `ExecutorRun` | 43.0 | 27.24 |
| 8 | `standard_ExecutorRun` | 42.9 | 27.20 |
| 9 | `ExecModifyTable` | 42.4 | 26.86 |
| 10 | `ExecUpdate` | 29.9 | 18.92 |

## 7. Runtime taxes, and the store

The groups bite 1 named, pgrust only, share of the backend's sampled time and µs per statement
(`groups3.md`):

| group | row 1 cold | row 2 cold | row 7 cold | row 9 cold | row 10 cold | row 1 warm | row 2 warm | row 7 warm | row 9 warm | row 10 warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| allocator (dlmalloc, __rust_alloc) | 0.7% (0.91 µs) | 1.8% (0.73 µs) | 1.0% (1.52 µs) | 0.9% (0.90 µs) | 1.1% (1.20 µs) | 1.1% (0.35 µs) | 2.3% (0.68 µs) | 1.1% (1.44 µs) | 0.9% (0.89 µs) | 1.0% (1.08 µs) |
| mcx (memory contexts) | 2.2% (3.01 µs) | 5.3% (2.19 µs) | 4.4% (6.86 µs) | 3.5% (3.37 µs) | 3.5% (3.85 µs) | 6.2% (1.93 µs) | 5.1% (1.49 µs) | 4.7% (6.09 µs) | 3.9% (3.85 µs) | 3.7% (3.96 µs) |
| unwind (_Unwind_*) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) |
| seams (*_seams, seam_core) | 0.0% (0.05 µs) | 0.1% (0.03 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.1% (0.04 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) |
| thread-local | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.1% (0.18 µs) | 0.2% (0.15 µs) | 0.2% (0.18 µs) | 0.0% (0.00 µs) | 0.0% (0.01 µs) | 0.3% (0.39 µs) | 0.1% (0.13 µs) | 0.1% (0.13 µs) |
| memcpy/memmove/memset/memcmp | 0.2% (0.25 µs) | 0.2% (0.07 µs) | 0.1% (0.19 µs) | 0.0% (0.01 µs) | 0.0% (0.03 µs) | 0.0% (0.00 µs) | 0.1% (0.02 µs) | 0.0% (0.00 µs) | 0.0% (0.00 µs) | 0.0% (0.02 µs) |
| Rust generics (core, alloc, std, hashbrown) | 1.5% (2.05 µs) | 2.3% (0.96 µs) | 2.2% (3.41 µs) | 2.1% (2.02 µs) | 2.8% (3.13 µs) | 2.0% (0.61 µs) | 1.6% (0.47 µs) | 1.8% (2.37 µs) | 2.1% (2.10 µs) | 3.2% (3.42 µs) |
| store: #call | 4.2% (5.69 µs) | 2.6% (1.08 µs) | 0.4% (0.70 µs) | 1.9% (1.83 µs) | 2.8% (3.03 µs) | 5.2% (1.63 µs) | 2.7% (0.78 µs) | 0.4% (0.46 µs) | 4.4% (4.41 µs) | 1.6% (1.76 µs) |

- **Seams, thread-local access, unwinding and `mem*` stay negligible where per-statement fixed cost
  dominates**, as they were on the bulk rows. By symbol, seams are at most 0.1% (0.05 µs a statement)
  and thread-local access at most 0.3% (0.39 µs); calls through a seam that the callee's code absorbs
  are not separable this way.
- **Rust generics**, 0.5–3.4 µs a statement, are spread over sorting, `hashbrown` lookups (the
  operator cache, the smgr table, portal names), `from_utf8` and drop glue; no single one is above
  0.25 µs (`rust-generics-warm.log`).
- **The store** (`#call`, the backend blocked on the broker) is 0.5–5.7 µs a statement. On rows 2, 9
  and 10, cold, 81% of it is relation extension zero-fill (`pg_pwrite_zeros` from `smgrzeroextend`
  under `ExtendBufferedRelCommon`, `file_extend_method=write_zeros`) and 17% `mdopenfork` opening fork
  files (`callers3.log`); on row 7 it is reads (`AsyncReadBuffers`). PGlite's own store is its emscripten
  MEMFS in JS (the "store: other JS" line, up to 2.9 µs). On disk in the browser both stores cost
  little (persistent-context §5, store-levers §8).

## 8. Warm-up: cold against warm

The same modules unprofiled, the Suite as it runs (four Runs) and the second time through the same
engine (two Runs), milliseconds:

| Benchmark | shipped cold median (4) | shipped warm (2) | warm ÷ cold | PGlite cold median (4) | PGlite warm (2) | warm ÷ cold | shipped ÷ PGlite, cold | shipped ÷ PGlite, warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 158.6 | 30.8 / 40.3 | 0.22× | 54.1 | 19.3 / 18.7 | 0.35× | 2.93× | 1.87× |
| 2: 25000 INSERTs in a transaction | 1071.6 | 701.0 / 752.1 | 0.68× | 552.5 | 546.9 / 435.3 | 0.89× | 1.94× | 1.48× |
| 7: 5000 SELECTs with an index | 795.0 | 651.8 / 670.6 | 0.83× | 439.9 | 449.0 / 360.2 | 0.92× | 1.81× | 1.63× |
| 9: 25000 UPDATEs with an index | 2445.4 | 2404.4 / 2672.1 | 1.04× | 1295.8 | 1476.6 / 1247.9 | 1.05× | 1.89× | 1.86× |
| 10: 25000 text UPDATEs with an index | 2860.9 | 2662.5 / 2973.2 | 0.98× | 1584.7 | 1766.9 / 1522.7 | 1.04× | 1.81× | 1.71× |
| Suite total | 11398.7 | 10214.7 / 11215.6 | 0.94× | 6774.4 | 7570.3 / 6329.1 | 1.03× | 1.68× | 1.54× |

One PGlite cold Run, `pglite-s2-r1`, is slower than the other three on every row (8 128 ms Suite
against 6 682–6 861); the medians keep it.

- **Row 1 goes to 0.22× of itself on pgrust and 0.35× on PGlite**; rows 2 and 7 to 0.68× and 0.83× on
  pgrust against 0.89× and 0.92×; rows 9 and 10 do not move. The rows that warm up are the ones that
  first run their code: row 1 the first INSERT after boot, row 2 the first long INSERT text, row 7
  the first bitmap index scan; rows 9 and 10 run what rows 7 and 8 (1 000 UPDATEs) have already run.
- **Where row 1's cold excess goes.** The same 1 000-statement text as the first after boot and warm,
  profiled (`coldwarm3.md`, one profiled sweep Run per engine): pgrust's +113.6 µs per statement is
  spread over every subsystem at once: the executor +14.2, tcop/portal +13.3, the planner +12.7, the
  catalog caches +11.2, analysis +9.3, the client +16.1 (the main thread's own protocol code is
  cold too), the store +6.0. PGlite's +25.2 is spread the same way, smaller. Nothing in one subsystem
  stands out; that is the signature of code running for the first time, not of a slow path.
- **The first `CREATE TABLE` is a single statement worth 29.4 ms cold and 1.0 ms warm** in pgrust
  (`ProcessUtility`, §5; PGlite 2.5 and 0.3 ms). pgrust's module is 33 568 functions and 33.9 MB of
  code against PGlite's 14 192 and 7.0 MB, and V8 compiles each wasm function at its first call and
  runs baseline code until it tiers up (V8's defaults, `node --v8-options`). This note infers that
  mechanism from the cold and warm times; it did not trace V8's compiler (`module-sizes.log`,
  `v8-flags.log`).
- **pgrust keeps warming long after row 1.** In the sweep (§9), the 10 000-statement text of round 1,
  which starts after about 2 100 statements, runs 48.8 µs a statement against 32.2 warm; PGlite's 27.1
  against 20.6.

A lane that would compile every function before row 1 was tried and dropped
(`tiering-smoke.log`): under `--no-liftoff --no-wasm-lazy-compilation` neither engine's boot promise
settled in node 26 (the process exits on an unsettled top-level await), and under
`--no-wasm-dynamic-tiering` V8 compiles the whole module in the background while the rows run (a
smoke Run put row 1 at 180.3 ms).

## 9. The statement-count sweep

Row 1's shape (one `CREATE TABLE t1`, then N single-row INSERTs, one statement a line) at 100, 1 000
and 10 000 statements: `sweep-1000.sql` is `benchmark1.sql` byte for byte, `sweep-100.sql` its first
100 INSERTs, `sweep-10000.sql` the first 10 000 INSERT lines of `benchmark2.sql` renamed to t1
(`make-sweep-sql.ts`). Unprofiled, the shipped module and the published PGlite, two processes each
(`tables3.md`). Each process boots, runs the preamble, then `cold-1000` (the first text after boot,
as row 1 runs), then three rounds of the 100-, 1 000- and 10 000-statement texts, the order rotated
each round (100/1000/10000, 1000/10000/100, 10000/100/1000), each after an untimed `DROP TABLE`.
Round 1 is still warming up (§8), so "warm" is rounds 2 and 3, four values per cell:

| text | engine | process 1: cold / r1 / r2 / r3 (ms) | process 2: cold / r1 / r2 / r3 (ms) | warm median (r2, r3) ms | warm µs per statement | round-1 µs per statement |
| --- | --- | --- | --- | --- | --- | --- |
| cold-1000 | pgrust | 162.2 | 135.0 | - | - | 148.6 (median, cold) |
| 100 | pgrust | 13.9 / 6.3 / 4.9 | 12.1 / 7.0 / 6.0 | 6.2 | 61.6 | 129.9 |
| 1000 | pgrust | 104.5 / 37.2 / 33.4 | 82.1 / 35.6 / 34.5 | 35.0 | 35.0 | 93.3 |
| 10000 | pgrust | 512.1 / 333.4 / 308.1 | 464.2 / 310.6 / 341.9 | 322.0 | 32.2 | 48.8 |
| cold-1000 | pglite | 53.7 | 41.0 | - | - | 47.3 (median, cold) |
| 100 | pglite | 3.7 / 2.7 / 2.6 | 4.5 / 3.0 / 2.8 | 2.8 | 27.6 | 41.0 |
| 1000 | pglite | 31.8 / 23.8 / 19.4 | 29.0 / 25.3 / 20.5 | 22.1 | 22.1 | 30.4 |
| 10000 | pglite | 255.2 / 213.2 / 183.3 | 285.9 / 201.9 / 209.6 | 205.7 | 20.6 | 27.1 |

| engine | fit ms = a + b·N over the warm medians: a (ms per text) | b (µs per statement) | marginal µs/stmt 100→1000 | marginal µs/stmt 1000→10 000 | cold-1000 − warm-1000 (ms) | cold-1000 ÷ warm-1000 |
| --- | --- | --- | --- | --- | --- | --- |
| pgrust | 3.05 | 31.9 | 32.1 | 31.9 | 113.6 | 4.24× |
| pglite | 1.15 | 20.5 | 21.5 | 20.4 | 25.2 | 2.14× |

| text | pgrust ÷ PGlite (medians) |
| --- | --- |
| cold-1000 | 3.14× |
| warm 100 | 2.24× |
| warm 1000 | 1.58× |
| warm 10000 | 1.57× |

- **Per statement or per text.** Warm, the fit is 3.05 ms a text plus 31.9 µs a statement for pgrust,
  1.15 ms plus 20.5 µs for PGlite: per statement 1.56×, per text 2.7× (the text's `CREATE TABLE`, its
  commit and the message's round trip). At row 1's size the per-text part is 9% of pgrust's warm
  time.
- **Nothing grows faster than the statement count.** The marginal cost from 1 000 to 10 000 is the
  same as from 100 to 1 000 in both engines. The query text is copied twice per message on arrival
  (`pq_getmsgstring`, then `leak_str_in` into `MessageContext`, `main_loop.rs`) and shared by every
  statement's portal after [malisper's change](2026-09-18-portal-source-text-share.md). In the
  profiled sweep (`superlinear-pgrust.log`, `superlinear-pglite.log`, warm rounds merged) one pgrust
  function's self time per statement grows with the text: `exec_simple_query`'s own frame, 0.15 µs a
  statement at 1 000 and 0.75 at 10 000 (about 1 and 60 samples), 15 ms of the two 10 000-statement
  windows, 2% of them. What in that frame grows was not found (§12). Every other function flagged there
  is at the level of one or two samples at 1 000 statements. `core::str::from_utf8` appears at 10 000
  with 0.31 µs a statement, 3.1 ms per 800 KB text, which fits the whole-text UTF-8 check in
  `leak_str_in`, once per message.

## 10. Settings and plans

`SELECT name, setting, unit, source FROM pg_settings` in both engines (`results/node-*-r1.settings.json`):
490 rows in pgrust, 398 in PGlite, 92 in one only (mostly `pgrust.*` and `idle_passivate_*`). Every
setting that costs per statement is the same:

| setting | pgrust | PGlite |
| --- | --- | --- |
| track_activities | on | on |
| track_counts | on | on |
| track_io_timing | off | off |
| track_wal_io_timing | off | off |
| track_functions | none | none |
| track_cost_delay_timing | off | off |
| compute_query_id | auto | auto |
| log_statement | none | none |
| log_duration | off | off |
| log_min_duration_statement | -1 | -1 |
| log_min_duration_sample | -1 | -1 |
| log_statement_stats | off | off |
| log_parser_stats | off | off |
| log_planner_stats | off | off |
| log_executor_stats | off | off |
| debug_print_parse | off | off |
| debug_print_rewritten | off | off |
| debug_print_plan | off | off |
| debug_assertions | off | off |
| log_lock_waits | off | off |
| jit | on | on |
| stats_fetch_consistency | cache | cache |
| update_process_title | on | on |
| statement_timeout | 0 | 0 |
| idle_session_timeout | 0 | 0 |
| idle_in_transaction_session_timeout | 0 | 0 |
| transaction_timeout | 0 | 0 |
| client_connection_check_interval | 0 | 0 |

What differs and could matter elsewhere: `jit_above_cost`, `jit_inline_above_cost` and
`jit_optimize_above_cost` are 200 in pgrust (its copy-and-patch defaults) against 100 000 and 500 000;
no plan on these rows costs more than 113 in pgrust (`explain3.log`), so no JIT flag is set.
`autovacuum` is off in pgrust (command line), `shared_buffers` 32 MB against 128 MB,
`file_extend_method` and `wal_init_zero` as bite 1 and the store-levers note recorded, and the
parallel settings (PGlite runs none).

The plans (`explain3.ts`, after rows 1 to 6): rows 7, 9 and 10 are an Aggregate or Update over a
Bitmap Heap Scan of `i2b` or `i2a` in both engines, and the INSERTs a Result under Insert. The
estimates differ: after row 6's `CREATE INDEX`, PGlite's `pg_class` has t2 at 247 pages and 25 000
tuples and pgrust's at 0 and −1, so pgrust estimates 40 rows where PGlite estimates 125. The plan shape
does not change; why pgrust's index build leaves the heap's statistics unset was not looked at.

## 11. The multi-statement path in pgrust

`exec_simple_query` is `crates/backend/tcop/postgres/src/simple_query.rs:404`, a port of
`src/backend/tcop/postgres.c:1110` (read in the PGlite source, PostgreSQL 18.3). Per message:

- `dispatch_message` (`main_loop.rs:501`) sets the statement start timestamp, copies the text out of
  the input buffer (`pq_getmsgstring`) and again into `MessageContext` (`leak_str_in`,
  `main_loop.rs:728`, which also validates it as UTF-8). `MessageContext` is a bump context
  (`main_loop.rs:885`), reset at the top of each main-loop iteration (`:908`), as C resets its
  `MessageContext`.
- Once per message: `pgstat_report_activity(STATE_RUNNING)` (`:460`), the `max_active_queries`
  admission guard (`:471`), `start_xact_command` (`:477`), `drop_unnamed_stmt` (`:480`), then
  **`pg_parse_query` parses the whole text into a list of raw statements** (`:483`) before any of
  them runs, as C does (`postgres.c:1163`). `use_implicit_block` is set when the list has more than
  one statement (`:497`).
- **Per statement** (the loop at `:500`): `pgstat_report_query_id` and `_plan_id`, the command tag,
  `set_ps_display`, `BeginCommand` (`:504`–`:514`); `start_xact_command` again, which is a no-op
  inside the transaction but for the statement timeout (`:520`); `BeginImplicitTransactionBlock`
  when the text has more than one statement (`:523`); **a snapshot pushed per statement** when the
  statement needs one (`analyze_requires_snapshot`, `:528`); for every statement but the last, a
  **per-statement child context** of `MessageContext`, a bump context in pgrust
  (`new_child_bump`, `:541`) where C creates an `AllocSet` (`postgres.c:1279`), holding analysis
  and planning and dropped after the statement; `pg_analyze_and_rewrite_fixedparams` (`:544`) and
  `pg_plan_queries` (`:553`); the snapshot popped (`:563`); **an unnamed portal created**
  (`CreatePortal`, `:568`, which reuses a parked `PortalContext`), its statements registered in an
  O(1) slot registry (`pquery::stmt_list::register`, `:573`, `crates/backend/tcop/pquery/src/stmt_list.rs`),
  **the text shared, not copied** (`PortalDefineQuerySharedText`, `:581`), `PortalStart`,
  `PortalSetResultFormat`, a destination receiver, the `stmt_task_arm` guard (one memoized flag,
  `:620`), `PortalRun` (`:628`), then **`PortalDrop`** and the registry slot freed (`:640`–`:641`);
  between statements **`CommandCounterIncrement`** (`:655`) and `disable_statement_timeout`; after
  the last statement `EndImplicitTransactionBlock` and `finish_xact_command` (`:645`–`:647`), and
  for a `BEGIN` or `COMMIT` statement `finish_xact_command` at once (`:649`); `EndCommand` (`:660`).
- After the loop, one `finish_xact_command` (`:673`): **row 1's 1 000 INSERTs commit once**, as
  C's do. The `stmt_trace::probe` calls between phases cost one relaxed atomic load each unless
  `PGRUST_STMT_TRACE` is set (`stmt_trace.rs`).

That is C's sequence step for step; the per-statement additions are the registry slot, the
shared-text define and the task-arm flag, none of which is visible in the profile (§5:
`CreatePortal` plus `PortalDrop` is 0.9–1.6 µs a statement warm on rows 2, 9 and 10, 0.4–0.7 in
PGlite). `CommandCounterIncrement` is at most 0.2 µs warm (2.5 cold on row 1), `GetTransactionSnapshot`
0.1–0.3. The per-statement cost is inside the phases every statement goes through, analysis, planning
and executor setup and teardown (§5), not in the multi-statement machinery around them.

## Verdict

| Row | Multiple here, cold / warm (µs per statement, pgrust against PGlite) | Warm-up's part of the cold difference | Named subsystem(s) carrying the extra time (warm, µs per statement) | Per-statement fixed cost or the row's own work (warm phases, §5) | Confidence |
| --- | --- | --- | --- | --- | --- |
| **1: 1000 INSERTs** | 2.53× (136.9 against 54.1) / 1.65× (31.4 against 19.0) | **85%** (+70.4 of +82.7 µs): every subsystem at once, and the first `CREATE TABLE`, 29.4 ms of the row cold against 1.0 warm | warm: the executor +3.8 (5.7 against 1.9), catalog caches +2.9, tcop/portal +2.1, analysis +1.7, the store +1.6, the planner +1.3 | fixed: analysis, planning, ExecutorStart and ExecutorEnd +8.4 µs against the INSERT's own work (ExecutorRun) +2.1 | high for the warm-up share (both modules, both engines, sweep and Suite agree); low for the warm split (one 31 ms row, about 310 samples) |
| **2: 25000 INSERTs in a transaction** | 1.87× (41.3 against 22.1) / 1.48× (29.0 against 19.6) | 51% (+9.8 of +19.2) | the executor +2.7 (4.7 against 1.9), the planner +2.2 (4.3 against 2.1), tcop/portal +1.3, analysis +1.0, catalog caches +0.8, the store +0.8 | fixed +5.8, the row's own work +1.5 | medium-high: 25 000 statements, but the warm Runs moved PGlite 435–547 ms |
| **7: 5000 SELECTs with an index** | 1.78× (157.0 against 88.0) / 1.61× (130.5 against 80.9) | 28% (+19.4 of +69.0) | **the planner +23.3 (35.3 against 12.1, 47% of the difference)**, the executor +8.8 (ExecutorStart +9.5), catalog caches +5.6, analysis +4.0, tcop/portal +3.4; the index scan itself (B-tree, heap, buffers) +4.0 | fixed +41.1; the row's own work (ExecutorRun, a bitmap scan and an aggregate over a few dozen rows) −3.8 | high: planner first in every Run, cold and warm |
| **9: 25000 UPDATEs with an index** | 1.87× (97.1 against 51.8) / 1.82× (99.2 against 54.5) | none (+0.6 of +45.3) | **the planner +17.8 (24.9 against 7.0, 40%)**, the executor +9.5 (14.3 against 4.8), the store +4.4 (mostly relation extension zero-fill, §7), the B-tree +3.6 (7.9 against 4.3), analysis +3.1, catalog caches +2.8; WAL +0.7 | fixed +30.6; the row's own work +12.1 (which holds the B-tree, heap, WAL and store lines) | high |
| **10: 25000 text UPDATEs with an index** | 1.73× (109.9 against 63.4) / 1.64× (107.7 against 65.8) | 10% (+4.6 of +46.5) | **the planner +17.4 (25.2 against 7.8, 42%)**, the executor +9.7 (14.8 against 5.1), analysis +4.4, Rust generics +3.4, the B-tree +3.3 (9.2 against 5.9), catalog caches +3.2; WAL +0.8 | fixed +31.0; the row's own work +6.6 | high |

On rows 2, 7, 9 and 10 the multiple is **per-statement fixed cost**: the phases every statement goes
through before and after its own row, with the planner the largest single subsystem (2.9–3.6× PGlite's
planner self time on the index rows) and the executor's setup and teardown second. It is not the
B-tree, not WAL, not the store, not the multi-statement machinery and not a runtime tax. On row 1 it
is mostly the engine running its code for the first time.

## 12. What this does not show

- **The browser.** Everything here is node's V8 with the store on the heap. The lane reproduces the
  disk lane's cold ratios on rows 2, 7, 9 and 10 (§3) but not row 1's: 2.93× here against 4.00× PGlite
  OPFS in Chromium. Warm-up in Chromium (its compile threads, its tiering, the page's own JS) was not
  measured; [finding 0002](../findings/0002-pgrust-autocommit-insert-regression.md) found row 1
  sensitive to exactly that.
- **Why the planner is two to three times PGlite's.** The profile says where, not why. The time is
  spread over 146 planner functions (§4) with no source lines (the Arm has names, no DWARF).
  Natively, bite 1 measured pgrust at 1.44–2.04× C on these rows (where the multiple lives, §2.2),
  about the multiples here, which suggests the per-statement cost is the port's rather than wasm's;
  no native profile was taken.
- **The warm-up mechanism, directly.** Lazy compilation and tier-up are inferred from cold against
  warm times and V8's default flags. A TurboFan-from-start lane did not boot (§8), and the profiler
  does not mark a frame's tier.
- **Frames V8 inlined.** Self time is per physical frame (§4); a function missing from one engine's
  tables may simply have been inlined there.
- **`exec_simple_query`'s growing self time** (§9), 2% of a 10 000-statement text, is unexplained.
- **pgrust's t2 statistics after `CREATE INDEX`** (relpages 0, reltuples −1, §10): a behaviour
  difference from PostgreSQL that this note records and did not chase.
- **Short windows.** Row 1 warm is about 310 samples for pgrust and 170 for PGlite; bucket values
  under about 0.5 µs a statement there are a sample or two. Rows 2 to 10 hold thousands.
- **The OPFS store, and other browsers.** Not measured here; the store-levers and persistent-context
  notes cover the store.

## Reproduction

In this repo, from the root. Scratch under `tmp/agents/profile3/`; it reuses bite 1's
`tmp/agents/anchors/` (`node-ts-hooks.ts`, `load.ts`, `suite.ts`, `wasm-sections.ts`,
`wasm-names.ts`, the Arm).

```
# the maps
tmp/agents/profile3/crate-map.sh > tmp/agents/profile3/crate-map.tsv   # pgrust crate -> directory
tmp/agents/profile3/pglite-build/build.sh                            # named PGlite + pglite-symbols.tsv
bun tmp/agents/profile3/make-sweep-sql.ts                            # sweep-{100,1000,10000}.sql

# the lanes (each Run its own node process behind the load gate; modules and dist/ sha-verified)
bun tmp/agents/profile3/lanes.ts --set parity       # shipped, arm, PGlite x2, the Suite; SHOW + pg_settings
bun tmp/agents/profile3/lanes.ts --set prof         # arm x2 under --cpu-prof
bun tmp/agents/profile3/lanes.ts --set pgl-prof     # named PGlite under --cpu-prof
bun tmp/agents/profile3/lanes.ts --set sweep        # shipped, PGlite x2, the sweep
bun tmp/agents/profile3/lanes.ts --set pgl-prof2    # named PGlite under --cpu-prof, again
bun tmp/agents/profile3/lanes.ts --set sweep-prof   # arm, named PGlite, the sweep under --cpu-prof
bun tmp/agents/profile3/lanes.ts --set suite2       # shipped, arm, PGlite x2, the Suite twice
bun tmp/agents/profile3/lanes.ts --set suite2-prof  # arm, named PGlite x2, the Suite twice under --cpu-prof
node --import ./tmp/agents/anchors/node-ts-hooks.ts tmp/agents/profile3/explain3.ts --engine pgrust   # and pglite

# slices and every table
tmp/agents/profile3/slices.sh
tmp/agents/profile3/tables-all.sh
bun tmp/agents/profile3/callers3.ts --runs <dir>:<result.json>,... --rows 2 --leaf '^waitGate$' --depth 8
bun tmp/agents/profile3/thread-summary.ts tmp/agents/profile3/prof/arm-prof1 tmp/agents/profile3/results/node-arm-prof1.json 2
```
