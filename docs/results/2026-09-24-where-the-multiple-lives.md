# Where the multiple lives: rows 11, 6 and 14 pay it in the OPFS store, not in pgrust or its wasm

> **2026-09-24 (later): the OPFS rung here is the old lane's per-call bill.** Every browser Run here
> went through `bun run bench` in its old, off-the-record context, where Chromium keeps OPFS in
> memory in the browser process and every access-handle call is a round trip to it. On the on-disk
> profile the lane now uses, rows 11, 6 and 14 cost PGlite OPFS 0.99×, 1.14× and 1.18× PGlite
> Memory, and pgrust 1.74×, 1.39× and 1.37× PGlite OPFS; the rung itself was not re-measured — see
> [2026-09-24, the persistent context](2026-09-24-persistent-context.md). No number here was
> changed.

- Date: 2026-09-24
- Machine: i7-1165G7 (8 logical cores, `lscpu` max 2800 MHz), 30 GiB, Linux 7.0.0-34-generic. A
  qemu VM and a desktop Chrome took about one core throughout, and other agents' `tsc`, `bun test`
  and WebKit runs came and went; every timed lane waited for a 1-minute load under 2.5 (§1).
- Browser: headless **Chromium 149.0.7827.55** (Playwright 1.61.1), `bun run bench --no-build`.
- Outside the browser: **node v26.10.0** (V8) for the wasm lanes, bun 1.4.2 for the native driver.
- Engines:
  - **C PostgreSQL 18.6** (`18.6-1.pgdg26.04+2`), `/usr/lib/postgresql/18/bin`.
  - **pgrust native**, `spike/wasip1-threads@569d16128c` (upstream v0.3, PostgreSQL 18.6), built
    here with `[profile.dist]`'s codegen (§2.1 says why it is not literally `--profile dist`).
  - **pgrust wasm**, the published modules: threads `df17f7e24a33…`, single-session `0d772984de72…`,
    verified before and after every browser Run; plus one profile **Arm** (§4.1).
  - **PGlite** `@pgxsinkit/pglite 0.5.5-pgx.3` (PostgreSQL 18.3), in Chromium and under node.
- Drivers and raw artefacts: `tmp/agents/anchors/` (untracked). Every number below is printed by
  `tables.ts`, `verdict.ts` or `slice-cpuprofile.ts` there from the per-lane JSON in `results/`.
- Nothing was adopted. No pgrust file was edited and no pgrust commit was made; `dist/` was never
  modified.

## What this answers

The Speedtest Suite ran about 2.7× slower on pgrust than on PGlite in Chromium (3.1× in the Runs
below), and the worst rows
are single statements doing bulk work inside the guest: row 11 (INSERTs from a SELECT), row 6
(CREATE INDEX), row 14 (a big INSERT after a big DELETE). The multiple could live in four places:
**the port** (pgrust is a slower program), **wasm codegen** (pgrust compiles to worse wasm than C
does), **threads and transport** (the threads target, the SAB broker, the postmaster), or **the
host** (what the browser does around the guest). This note locates it for those three rows, by
measurement only.

**It lives in the host: the OPFS store.** Natively pgrust is within 0.75–1.35× of C on all three
rows. As a single-thread wasm module in Chromium it is 0.75–1.08× PGlite. The threads target, the
broker seam and the postmaster together cost 1.61–1.83×. Moving the same postmaster's store from the
heap to OPFS costs **6.72× on row 11, 3.05× on row 6 and 3.53× on row 14**, and that one step is
68–86% of each row's multiple. PGlite pays the same store 2.99–4.53× on the same rows, so pgrust asks
more of OPFS than PGlite does (1.46–2.02×), but OPFS is where both pay.

## Method

Three anchors and three supplementary lanes, measured after every build finished, one timed lane at a
time, each started only when the 1-minute load was under 2.5 (checked every 15 s, at most 10 minutes,
then started anyway and logged as such).

- **Anchor A, native A/B.** C 18.6 against native pgrust on the same machine: fresh `initdb` (C's,
  `--no-locale --encoding=UTF8 -U postgres -A trust`) for both, `-c fsync=off -c
  synchronous_commit=off -c listen_addresses=''`, a unix socket under the scratch dir, defaults
  otherwise, one postgres.js 3.4.9 connection. Each of the 18 scripts goes as ONE query text over the
  simple protocol, timed with `performance.now()` around the round trip. Two rounds, C first then
  pgrust first. pgrust native listens on a unix socket exactly like Postgres (`listening on Unix
  socket …/.s.PGSQL.55434` in its log), so no host-pipe transport was needed.
- **Anchor B, the Chromium ladder.** Six Configurations, each one rung up from the last, **one
  Configuration per Run**, round 2 in the reverse order: `pglite-memory`, `pgrust-memory`
  (single-session wasm32-wasip1 module, JSPI, no threads), `pgrust-threads-memory` (threads module,
  one session, private copy of the image), `pgrust-threads-memory-broker` (the same session, store
  behind the SAB broker), `pgrust-postmaster-memory-broker` (`PostmasterMain`, backends and aux
  processes as threads, same broker on the heap), `pgrust-postmaster-opfs-repacked-relaxed` (the
  same, store on OPFS). Each adjacent pair differs in one thing.
- **Anchor C, a V8 CPU profile.** The bench's own engine (`createPgrustPglite`: the postmaster as
  `node:worker_threads`, broker store on the coordinator's heap) run under node with `--cpu-prof
  --cpu-prof-interval 250`, which writes one `.cpuprofile` per thread. The runner records each row's
  window on CLOCK_MONOTONIC, the clock the profiler stamps samples with; the slicer weights each sample
  by the time to the next and reports the backend thread (the one with the most distinct leaf
  functions in the window; every parked thread shows one).
- **Supplementary:** PGlite on the repacked OPFS store (`pglite-opfs-repacked-relaxed`, two Runs);
  two more shipped/arm parity rounds in the node lane; and Anchor A again with every parallel path
  off on both engines.

## 1. Environment and load

The load gate held for every lane but one: `b133-r2` (a control in §4.1) started after the 10-minute
cap at 2.77. The 1-minute load before → after each lane:

| lane | load before → after |
| --- | --- |
| native C r1 / pgrust r1 / pgrust r2 / C r2 | 2.30 → 2.43 / 2.43 → 2.36 / 2.36 → 2.25 / 2.25 → 2.23 |
| native, parallel off: C r1 / pgrust r1 / pgrust r2 / C r2 | 2.03 → 1.95 / 1.95 → 1.87 / 1.87 → 1.88 / 1.88 → 1.81 |
| Chromium r1: PGlite / pgrust-memory / threads / threads-broker / postmaster-memory / postmaster-opfs | 2.22 → 1.95 / 1.95 → 1.89 / 1.89 → 1.75 / 1.75 → 1.67 / 1.67 → 1.74 / 1.74 → 3.87 |
| Chromium r2: postmaster-opfs / postmaster-memory / threads-broker / threads / pgrust-memory / PGlite | 2.38 → 3.08 / 2.23 → 2.41 / 2.41 → 2.47 / 2.47 → 2.43 / 2.43 → 2.91 / 2.26 → 2.88 |
| Chromium, PGlite OPFS r3 / r4 | 2.39 → 2.52 / 2.04 → 2.15 |
| node: PGlite r1 / shipped r1 / arm r1 / b133 r1 | 1.91 → 2.23 / 2.22 → 2.23 / 2.23 → 2.23 / 2.23 → 2.11 |
| node: PGlite r2 / shipped r2 / arm r2 / b133 r2 | 2.11 → 2.09 / 2.09 → 2.41 / 2.41 → 3.35 / **2.77 (started anyway)** → 2.57 |
| node: shipped r3 / arm r3 / shipped r4 / arm r4 / profiled arm | 2.15 → 2.16 / 2.16 → 2.50 / 2.38 → 2.16 / 2.07 → 2.03 / 2.44 → 2.75 |

## 2. Anchor A: natively, pgrust is at parity with C on rows 11, 6 and 14

### 2.1 The binary

`cargo build --profile dist -p main_main --bin postgres` fails on this machine: `libre2-dev` is not
installed, and pgrust's `regexp_alt` build script refuses a Spencer-only regex engine on every
release-rooted profile, `PGRUST_FORCE_NO_RE2=1` included (`native-dist-build-attempt1-no-libre2.log`).
So the binary was built with `[profile.dist]`'s codegen under a profile defined on the command line
and rooted at `dev` (`build-native.sh`): opt-level 3, `lto = "fat"`, `codegen-units = 1`, debug 0,
`strip = "symbols"`, no debug assertions, no overflow checks, panic unwind. It links mimalloc (the
release allocator; the debug-assertions tracker is compiled out) and uses the Spencer regex engine,
which is also what every wasm module carries by construction. No Suite script uses a
regular-expression operator (rows 5 and 12 use `LIKE`). Toolchain: rustc 1.98.1 (the shell's
`RUSTUP_TOOLCHAIN`; the repo pins 1.96.0). 14 m 18 s, 59 591 632 bytes, `postgres (PostgreSQL) 18.6`.

`SELECT version()`:

- C: `PostgreSQL 18.6 (Ubuntu 18.6-1.pgdg26.04+2) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 15.2.0-16ubuntu1) 15.2.0, 64-bit`
- pgrust: `PostgreSQL 18.6 (pgrust 0.3) on x86_64-unknown-linux-gnu, 64-bit`

Both engines left the same state behind before row 16 (`{"t1":"12000","t2":"34898","t3":"25000",
"t2sum":"2324290853"}` in all eight lanes), and no autovacuum ran in any lane
(`log_autovacuum_min_duration=0`, zero `automatic vacuum` lines).

### 2.2 All 18 rows

Milliseconds, lower is better. The last column group is PGlite under node (V8, in memory, one `exec`
per script): the same two Runs as the Anchor C lane's PGlite column, on PGlite's own settings rather
than the native lanes' `fsync=off, synchronous_commit=off`, so its ratio to C is indicative only.

| Benchmark | C r1 | C r2 | pgrust r1 | pgrust r2 | pgrust ÷ C r1 | r2 | PGlite/node r1 | r2 | PGlite/node ÷ C (better rounds) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 13.3 | 11.3 | 21.6 | 20.3 | 1.63× | 1.80× | 57.8 | 57.1 | 5.06× |
| 2: 25000 INSERTs in a transaction | 262.9 | 257.5 | 535.5 | 507.2 | 2.04× | 1.97× | 651.3 | 713.4 | 2.53× |
| 2.1: 25000 INSERTs in single statement | 106.0 | 108.4 | 159.7 | 90.6 | 1.51× | 0.84× | 138.3 | 167.2 | 1.30× |
| 3: 25000 INSERTs into an indexed table | 360.9 | 351.1 | 656.8 | 593.4 | 1.82× | 1.69× | 848.9 | 807.6 | 2.30× |
| 3.1: 25000 INSERTs into an indexed table in single statement | 129.8 | 113.5 | 123.5 | 115.5 | 0.95× | 1.02× | 201.7 | 155.3 | 1.37× |
| 4: 100 SELECTs without an index | 250.2 | 208.2 | 261.9 | 262.7 | 1.05× | 1.26× | 328.6 | 311.6 | 1.50× |
| 5: 100 SELECTs on a string comparison | 569.0 | 572.4 | 611.2 | 529.3 | 1.07× | 0.92× | 836.2 | 897.0 | 1.47× |
| **6: Creating an index** | 17.0 | 17.9 | 17.9 | 16.6 | **1.05×** | **0.93×** | 30.9 | 30.7 | 1.81× |
| 7: 5000 SELECTs with an index | 201.4 | 209.0 | 402.3 | 396.1 | 2.00× | 1.90× | 484.4 | 497.7 | 2.41× |
| 8: 1000 UPDATEs without an index | 88.2 | 95.1 | 134.8 | 112.3 | 1.53× | 1.18× | 163.3 | 169.7 | 1.85× |
| 9: 25000 UPDATEs with an index | 847.9 | 726.3 | 1503.5 | 1473.0 | 1.77× | 2.03× | 1438.3 | 1616.0 | 1.98× |
| 10: 25000 text UPDATEs with an index | 1248.8 | 978.6 | 1793.6 | 1739.2 | 1.44× | 1.78× | 1825.9 | 1785.6 | 1.82× |
| **11: INSERTs from a SELECT** | 183.5 | 112.7 | 137.0 | 142.4 | **0.75×** | **1.26×** | 276.8 | 254.3 | 2.26× |
| 12: DELETE without an index | 22.5 | 13.3 | 16.9 | 27.5 | 0.75× | 2.07× | 24.8 | 29.0 | 1.86× |
| 13: DELETE with an index | 32.9 | 19.0 | 32.8 | 43.0 | 1.00× | 2.27× | 31.3 | 31.4 | 1.65× |
| **14: A big INSERT after a big DELETE** | 114.2 | 91.4 | 116.3 | 111.8 | **1.02×** | **1.22×** | 161.9 | 167.0 | 1.77× |
| 15: A big DELETE followed by many small INSERTs | 182.6 | 138.0 | 237.0 | 232.7 | 1.30× | 1.69× | 238.5 | 250.9 | 1.73× |
| 16: DROP TABLE | 6.3 | 6.3 | 5.0 | 5.4 | 0.80× | 0.86× | 9.8 | 10.6 | 1.55× |
| **Suite total** | 4637.3 | 4029.9 | 6767.3 | 6419.0 | 1.46× | 1.59× | 7748.6 | 7952.1 | 1.92× |

Row 11's C time moved 183.5 → 112.7 between rounds; that is the resolution two rounds have on a
100 ms row. Both rounds put pgrust within 0.75–1.26× of C on row 11, 0.93–1.05× on row 6 and
1.02–1.22× on row 14. The Suite-level 1.5× is real natively and lives elsewhere (rows 2, 3, 7, 9, 10,
1.4–2.0×), which this note does not examine.

### 2.3 The defaults are not the same; the parallel ones were switched off

pgrust's defaults differ from C's in 15 settings that both report, leaving out paths, ports, the
version string, the keytab and sizes derived from them, and 91 more settings exist in only one of the
two (`settings-diff.log`, `settings-count.log`). The 15: `io_method` (`sync` against C's `worker`),
`file_extend_method` (`write_zeros` against `posix_fallocate`), `wal_buffers`,
`bgwriter_flush_after` and `checkpoint_flush_after` (0 against 64 and 32), the three JIT cost
thresholds, and a more parallel-friendly set (`max_parallel_workers_per_gather` 4 against 2,
`max_parallel_workers` and `max_worker_processes` 16 against 8, `parallel_setup_cost` 100 against
1000, `parallel_tuple_cost` 0.01 against 0.1, `min_parallel_table_scan_size` 1 MB against 8 MB,
`min_parallel_index_scan_size` 64 kB against 512 kB). Row 6 is a CREATE INDEX, so both engines were run
again with `max_parallel_workers_per_gather=0,max_parallel_maintenance_workers=0`:

| Benchmark | C r1 | C r2 | pgrust r1 | pgrust r2 | pgrust ÷ C r1 | r2 |
| --- | --- | --- | --- | --- | --- | --- |
| **6: Creating an index** | 16.4 | 18.1 | 17.4 | 24.3 | 1.06× | 1.35× |
| **11: INSERTs from a SELECT** | 118.2 | 120.3 | 149.5 | 136.4 | 1.26× | 1.13× |
| **14: A big INSERT after a big DELETE** | 86.7 | 89.4 | 113.1 | 114.8 | 1.30× | 1.28× |
| **Suite total** | 3989.3 | 3917.3 | 6438.6 | 6737.0 | 1.61× | 1.72× |

With parallelism off, pgrust is 1.13–1.26× C on row 11, 1.06–1.35× on row 6 and 1.28–1.30× on row
14. **Across all four pairs the port accounts for at most 1.35× on these rows**, against browser
multiples of 4.4–9.2× (§3).

## 3. Anchor B: in Chromium, the multiple appears at one rung, the OPFS store

### 3.1 All 18 rows, both rounds

Milliseconds, r1 / r2. Round 1 ran the columns left to right, round 2 right to left.

| Benchmark | pglite-memory | pgrust-memory | pgrust-threads-memory | pgrust-threads-memory-broker | pgrust-postmaster-memory-broker | pgrust-postmaster-opfs-repacked-relaxed |
| --- | --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 58.8 / 59.0 | 244.2 / 311.8 | 267.1 / 268.0 | 266.6 / 292.1 | 353.8 / 289.5 | 635.4 / 608.4 |
| 2: 25000 INSERTs in a transaction | 648.2 / 634.8 | 1128.8 / 1205.7 | 1091.3 / 1063.8 | 1191.7 / 1217.0 | 1204.6 / 1155.0 | 1327.6 / 1234.7 |
| 2.1: 25000 INSERTs in single statement | 159.8 / 141.8 | 207.1 / 210.0 | 237.4 / 228.5 | 254.1 / 226.4 | 243.0 / 299.6 | 548.3 / 489.6 |
| 3: 25000 INSERTs into an indexed table | 807.4 / 806.2 | 1106.1 / 1154.5 | 1112.8 / 1112.2 | 1489.9 / 1430.0 | 1394.1 / 1411.0 | 3304.4 / 3184.2 |
| 3.1: 25000 INSERTs into an indexed table in single statement | 169.1 / 174.8 | 202.2 / 233.2 | 197.1 / 249.6 | 260.7 / 258.6 | 232.1 / 239.9 | 701.7 / 664.9 |
| 4: 100 SELECTs without an index | 342.7 / 372.0 | 431.4 / 448.8 | 500.3 / 484.3 | 521.6 / 430.3 | 412.5 / 417.3 | 492.2 / 445.4 |
| 5: 100 SELECTs on a string comparison | 843.3 / 915.7 | 830.8 / 927.9 | 832.4 / 889.7 | 1013.0 / 914.2 | 907.9 / 859.8 | 856.6 / 811.2 |
| **6: Creating an index** | 37.0 / 29.5 | 24.3 / 34.6 | 32.3 / 43.6 | 36.1 / 47.4 | 48.5 / 46.6 | 150.9 / 139.1 |
| 7: 5000 SELECTs with an index | 497.2 / 525.4 | 797.7 / 905.4 | 883.7 / 850.0 | 905.0 / 857.4 | 1013.5 / 946.3 | 1354.0 / 1065.1 |
| 8: 1000 UPDATEs without an index | 188.7 / 197.1 | 212.2 / 235.7 | 229.2 / 232.2 | 267.6 / 223.9 | 249.8 / 216.5 | 445.4 / 303.6 |
| 9: 25000 UPDATEs with an index | 1531.2 / 1530.1 | 2567.8 / 2554.7 | 2665.9 / 2688.1 | 3143.2 / 2888.2 | 2710.5 / 3033.4 | 4240.2 / 4045.1 |
| 10: 25000 text UPDATEs with an index | 1908.2 / 1980.0 | 2893.2 / 2945.1 | 2996.3 / 2973.9 | 3402.7 / 3317.3 | 3276.1 / 3333.6 | 8000.8 / 4995.1 |
| **11: INSERTs from a SELECT** | 354.1 / 326.7 | 257.9 / 249.7 | 279.8 / 288.4 | 464.1 / 428.5 | 472.2 / 455.6 | 3668.8 / 2566.7 |
| 12: DELETE without an index | 28.8 / 28.4 | 34.9 / 28.6 | 31.1 / 34.4 | 32.0 / 34.2 | 38.6 / 34.7 | 80.8 / 58.0 |
| 13: DELETE with an index | 32.4 / 34.3 | 41.5 / 41.6 | 58.2 / 47.3 | 51.8 / 50.1 | 71.3 / 53.0 | 188.0 / 157.5 |
| **14: A big INSERT after a big DELETE** | 175.9 / 185.2 | 185.6 / 205.6 | 202.4 / 195.5 | 262.3 / 352.8 | 375.6 / 270.4 | 1429.3 / 849.8 |
| 15: A big DELETE followed by many small INSERTs | 290.3 / 267.9 | 364.7 / 347.9 | 361.4 / 368.1 | 427.7 / 381.2 | 397.1 / 378.9 | 934.7 / 621.4 |
| 16: DROP TABLE | 7.5 / 5.7 | 9.7 / 9.7 | 11.5 / 13.4 | 19.7 / 27.0 | 20.3 / 20.1 | 38.0 / 40.3 |
| **Suite total** | 8080.7 / 8214.6 | 11539.7 / 12050.4 | 11990.1 / 12031.0 | 14009.9 / 13376.5 | 13421.5 / 13461.2 | 28397.2 / 22279.9 |

Each column against `pglite-memory` in the same round:

| Benchmark | pgrust-memory | pgrust-threads-memory | pgrust-threads-memory-broker | pgrust-postmaster-memory-broker | pgrust-postmaster-opfs-repacked-relaxed |
| --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 4.15× / 5.29× | 4.54× / 4.54× | 4.53× / 4.95× | 6.01× / 4.91× | 10.80× / 10.31× |
| 2: 25000 INSERTs in a transaction | 1.74× / 1.90× | 1.68× / 1.68× | 1.84× / 1.92× | 1.86× / 1.82× | 2.05× / 1.94× |
| 2.1: 25000 INSERTs in single statement | 1.30× / 1.48× | 1.49× / 1.61× | 1.59× / 1.60× | 1.52× / 2.11× | 3.43× / 3.45× |
| 3: 25000 INSERTs into an indexed table | 1.37× / 1.43× | 1.38× / 1.38× | 1.85× / 1.77× | 1.73× / 1.75× | 4.09× / 3.95× |
| 3.1: 25000 INSERTs into an indexed table in single statement | 1.20× / 1.33× | 1.17× / 1.43× | 1.54× / 1.48× | 1.37× / 1.37× | 4.15× / 3.80× |
| 4: 100 SELECTs without an index | 1.26× / 1.21× | 1.46× / 1.30× | 1.52× / 1.16× | 1.20× / 1.12× | 1.44× / 1.20× |
| 5: 100 SELECTs on a string comparison | 0.99× / 1.01× | 0.99× / 0.97× | 1.20× / 1.00× | 1.08× / 0.94× | 1.02× / 0.89× |
| **6: Creating an index** | 0.66× / 1.17× | 0.87× / 1.47× | 0.98× / 1.60× | 1.31× / 1.58× | 4.08× / 4.71× |
| 7: 5000 SELECTs with an index | 1.60× / 1.72× | 1.78× / 1.62× | 1.82× / 1.63× | 2.04× / 1.80× | 2.72× / 2.03× |
| 8: 1000 UPDATEs without an index | 1.12× / 1.20× | 1.21× / 1.18× | 1.42× / 1.14× | 1.32× / 1.10× | 2.36× / 1.54× |
| 9: 25000 UPDATEs with an index | 1.68× / 1.67× | 1.74× / 1.76× | 2.05× / 1.89× | 1.77× / 1.98× | 2.77× / 2.64× |
| 10: 25000 text UPDATEs with an index | 1.52× / 1.49× | 1.57× / 1.50× | 1.78× / 1.68× | 1.72× / 1.68× | 4.19× / 2.52× |
| **11: INSERTs from a SELECT** | **0.73× / 0.76×** | 0.79× / 0.88× | 1.31× / 1.31× | 1.33× / 1.39× | **10.36× / 7.86×** |
| 12: DELETE without an index | 1.21× / 1.00× | 1.08× / 1.21× | 1.11× / 1.20× | 1.34× / 1.22× | 2.80× / 2.04× |
| 13: DELETE with an index | 1.28× / 1.21× | 1.80× / 1.38× | 1.60× / 1.46× | 2.20× / 1.55× | 5.80× / 4.59× |
| **14: A big INSERT after a big DELETE** | **1.05× / 1.11×** | 1.15× / 1.06× | 1.49× / 1.90× | 2.14× / 1.46× | **8.13× / 4.59×** |
| 15: A big DELETE followed by many small INSERTs | 1.26× / 1.30× | 1.24× / 1.37× | 1.47× / 1.42× | 1.37× / 1.41× | 3.22× / 2.32× |
| 16: DROP TABLE | 1.30× / 1.71× | 1.54× / 2.35× | 2.64× / 4.74× | 2.71× / 3.54× | 5.10× / 7.08× |
| **Suite total** | 1.43× / 1.47× | 1.48× / 1.46× | 1.73× / 1.63× | 1.66× / 1.64× | 3.51× / 2.71× |

`pgrust-memory` booted and ran all 18 rows in both rounds; no fallback was needed.

### 3.2 One rung at a time

Each step's multiplier, from both rounds summed (the upper rung's r1 + r2 ms over the lower rung's):

| step | row 11 | row 6 | row 14 | Suite total |
| --- | --- | --- | --- | --- |
| pgrust as a single-thread wasm program (`pgrust-memory` ÷ `pglite-memory`) | 0.75× | 0.89× | 1.08× | 1.45× |
| threads target (`pgrust-threads-memory` ÷ `pgrust-memory`) | 1.12× | 1.29× | 1.02× | 1.02× |
| broker store seam (`…-threads-memory-broker` ÷ `…-threads-memory`) | 1.57× | 1.10× | 1.55× | 1.14× |
| postmaster (`…-postmaster-memory-broker` ÷ `…-threads-memory-broker`) | 1.04× | 1.14× | 1.05× | 0.98× |
| **OPFS port (`…-postmaster-opfs-repacked-relaxed` ÷ `…-postmaster-memory-broker`)** | **6.72×** | **3.05×** | **3.53×** | 1.89× |
| **the whole ladder** (`…-postmaster-opfs-repacked-relaxed` ÷ `pglite-memory`) | **9.16×** | **4.36×** | **6.31×** | 3.11× |

On a log scale the OPFS step is **86% of row 11's multiple, 76% of row 6's and 68% of row 14's**;
the three threads-and-transport steps are 27%, 32% and 27%; the program itself is −13%, −8% and +4%
(`verdict.log`). Two things stand out besides the OPFS step:

- **The single-thread module is faster than PGlite on row 11** (0.73× and 0.76×) and close to it on
  rows 6 and 14. Whatever pgrust costs as wasm, it is no more than C costs as wasm on these rows:
  C's own wasm-and-browser tax (PGlite in Chromium, mean of two rounds, ÷ the better native C round)
  is 3.02× on row 11, 1.96× on row 6 and 1.97× on row 14; pgrust's (`pgrust-memory` ÷ native pgrust,
  the same way) is 1.85×, 1.77× and 1.75× (`verdict.log`).
- **Of the transport steps, the broker seam is the one that costs**, 1.57× and 1.55× on rows 11 and
  14. The threads target and the postmaster are each within 1.00–1.29×.

### 3.3 Supplementary: PGlite on the same store design

The headline multiples compare pgrust on OPFS with PGlite in memory. PGlite on the repacked OPFS store
(the published package, in-process, no broker) was run twice after the ladder:

| Benchmark | pglite-opfs-repacked-relaxed r3 / r4 | pglite-memory r1 / r2 | pgrust-postmaster-opfs r1 / r2 | PGlite's own OPFS step (opfs ÷ memory) | pgrust-postmaster-opfs ÷ pglite-opfs |
| --- | --- | --- | --- | --- | --- |
| **6: Creating an index** | 104.0 / 95.1 | 37.0 / 29.5 | 150.9 / 139.1 | 2.99× | 1.46× |
| **11: INSERTs from a SELECT** | 1564.2 / 1520.5 | 354.1 / 326.7 | 3668.8 / 2566.7 | 4.53× | 2.02× |
| **14: A big INSERT after a big DELETE** | 623.1 / 582.0 | 175.9 / 185.2 | 1429.3 / 849.8 | 3.34× | 1.89× |
| **Suite total** | 13864.3 / 13853.1 | 8080.7 / 8214.6 | 28397.2 / 22279.9 | 1.70× | 1.83× |

**OPFS costs PGlite 3.0–4.5× on exactly these rows too.** pgrust on OPFS is 1.46–2.02× PGlite on
OPFS. On rows 6 and 14 that is about what pgrust costs over PGlite with both stores in memory at the
postmaster rung (1.43× and 1.79×, both rounds summed); on row 11 it is more (2.02× against 1.36×).

## 4. Anchor C: what the guest does on rows 11, 6 and 14

### 4.1 The profile arm, and whether it is the shipped module

The published module has no name section. The Arm is the published build with names kept and
nothing else changed, as nearly as this machine allows. It took two recipes and three builds
(`arm-build*.log`):

1. **`CARGO_PROFILE_WASM_RELEASE_STRIP=none` with `-g` in `PGRUST_WASM_OPT_EXTRA`** was rejected.
   With no strip the link keeps seven `.debug_*` sections (525 286 bytes, although every Rust unit is
   `debug = 0`), so `wasm-opt -g` ran in DWARF-preserving mode: 75 s instead of about 210 s,
   45 957 923 bytes instead of about 40 MB. And a different `strip` is a different cargo profile:
   every unit got a new output hash, and the raw link's function, element, code and data sections
   already differed from the shipped raw link before Binaryen ran (`parity-sections-attempt1.log`).
2. The cargo profile left exactly as shipped (`strip = "symbols"`) and only the linker changed:
   `CARGO_TARGET_WASM32_WASIP1_THREADS_LINKER=tmp/agents/anchors/linker/wasm-ld`, a wrapper that swaps
   rustc's `--strip-all` for `--strip-debug` and execs the toolchain's `rust-lld`
   (`linker/invocations.log`: the `postgres` link, one swap; the second entry is the script's unwind
   smoke). Cargo wrote the shipped build's own output name (`deps/postgres-3ca3db9f7f00303b.wasm`),
   i.e. the same unit hashes. The first try failed on a doubled `-flavor wasm`; the second built in
   11 m 06 s.

What the Arm is, byte for byte (`parity-sections.log`):

- **A `name` section (3 313 052 bytes, 32 737 function names) and no `.debug_*` section.**
- **Its raw link equals the shipped raw link in every non-custom section but code, and in code
  differs in one function body out of 35 181, by 33 bytes of the same length**: a `try_table` catch
  label in `sqe::stencils::fused_filter_agg::run_fused_filter_agg`. That function is not sampled once in the
  whole profiled Suite (`fused-filter-agg-presence.log`).
- **The Arm was made by Binaryen 133; the shipped module was not.** It was built on 19 September;
  mise installed Binaryen 133 on 23 September and 132, which the notes of 16 and 18 September
  record, is no longer installed. Binaryen 133 over the shipped module's own saved raw link, with
  the shipped flags and no names (`repro-shipped-opt.sh`, the `b133` control below), gives
  39 982 302 bytes, not the shipped 40 004 938: one function fewer and 22 635 fewer bytes of code,
  from the version alone.
- Against that `b133` control the Arm's code section is the same size (33 856 719 bytes) and its data
  section is the shipped one, but names change Binaryen's function order: the same 384 types in a
  different order and 861 of 33 567 bodies of a different length.

So the Arm is not byte-identical in code to what ships, and the only proof left is timing. The
same node lane, interleaved shipped / arm / b133 / … / shipped / arm (four rounds each for shipped
and arm), milliseconds:

| Benchmark | shipped r1–r4 | arm r1–r4 | b133 r1–r2 | shipped median | arm median | arm ÷ shipped (medians) | shipped's own spread (max ÷ min) | arm's own spread |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **11: INSERTs from a SELECT** | 431.7 / 392.2 / 427.4 / 428.1 | 439.6 / 482.3 / 405.6 / 442.9 | 399.9 / 458.5 | 427.7 | 441.2 | 1.03× | 1.10× | 1.19× |
| **6: Creating an index** | 36.8 / 39.7 / 32.5 / 33.5 | 39.4 / 40.3 / 35.3 / 47.6 | 47.9 / 32.9 | 35.1 | 39.9 | 1.13× | 1.22× | 1.35× |
| **14: A big INSERT after a big DELETE** | 268.9 / 250.4 / 259.6 / 254.1 | 248.3 / 239.9 / 246.8 / 253.1 | 265.9 / 282.7 | 256.9 | 247.6 | 0.96× | 1.07× | 1.06× |
| **Suite total** | 13016.8 / 12896.1 / 12872.3 / 12754.9 | 12870.4 / 14160.8 / 12853.0 / 13018.0 | 13939.1 / 12891.3 | 12884.2 | 12944.2 | 1.00× | 1.02× | 1.10× |

**Rows 11 and 14 and the Suite match within noise**: the arm-over-shipped medians (1.03×, 0.96×,
1.00×) sit inside each module's own round-to-round spread. **Row 6 is flagged**: the Arm's median is
4.8 ms (13%) slower on a 35 ms row, inside the Arm's own spread but outside the shipped module's
32.5–39.7 ms. The row 6 profile below is read with that in mind.

### 4.2 The node lane reproduces the memory-broker multiples, not the OPFS ones

Node has no OPFS, so the lane is the node twin of `pgrust-postmaster-memory-broker`. Means of all
Runs, milliseconds:

| Benchmark | node PGlite (2 Runs) | node pgrust, postmaster + memory broker (shipped, 4) | ÷ | Chromium pglite-memory (2) | Chromium pgrust-postmaster-memory-broker (2) | ÷ | Chromium pgrust-postmaster-opfs-repacked-relaxed (2) | ÷ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **11: INSERTs from a SELECT** | 265.5 | 419.8 | 1.58× | 340.4 | 463.9 | 1.36× | 3117.8 | 9.16× |
| **6: Creating an index** | 30.8 | 35.6 | 1.16× | 33.3 | 47.5 | 1.43× | 145.0 | 4.36× |
| **14: A big INSERT after a big DELETE** | 164.5 | 258.2 | 1.57× | 180.5 | 323.0 | 1.79× | 1139.5 | 6.31× |
| **Suite total** | 7850.4 | 12885.0 | 1.64× | 8147.7 | 13441.4 | 1.65× | 25338.5 | 3.11× |

The Suite multiple is the same in the node lane and in Chromium on the heap store (1.64× and 1.65×),
and the three rows land within 0.2–0.3× of their Chromium memory-broker ratios. So the profile below
explains the memory-broker multiple; the OPFS step (§3.2) is outside what it can see.

### 4.3 The profile

One profiled Run of the whole Suite on the Arm (`node --cpu-prof --cpu-prof-interval 250`, 16
threads, one `.cpuprofile` each). The profiler adds about 28% (Suite 16 566.7 ms against the Arm's
unprofiled median 12 944.2), so the shares matter here, not the milliseconds. In every window the
backend is thread 11, with 146, 35 and 123 distinct leaf functions on rows 11, 6 and 14; every other
guest thread shows one to six, parked in `waiter::clock::RealClock::wait`, `Channel::recv` or the
host's `awaitCommand`, and the storage coordinator, a JS worker, 14 to 68. Wasm names are
v0-mangled in the name section and demangled with binutils `c++filt`, crate hashes stripped.

`#call` is the broker client in the pre-release store bundle (`public/pgrust/host/vendor/
pglite-opfs-repacked.js`): it writes a request into the channel, rings the coordinator and blocks in
`Atomics.wait` for the answer. Its self time is almost all the backend blocked in that wait.

**Row 11, INSERTs from a SELECT** (window 582.8 ms): top 25 functions by self time

| # | function | bucket | self ms | % of window |
| --- | --- | --- | --- | --- |
| 1 | `#call [pglite-opfs-repacked.js:15922]` | host JS: sync broker request | 213.5 | 36.6 |
| 2 | `nbtree::search::bt_compare` | nbtree | 32.5 | 5.6 |
| 3 | `crc32c::sb8::pg_comp_crc32c_sb8` | crc32c | 22.7 | 3.9 |
| 4 | `transam_xlog::insert::XLogInsertRecord` | transam_xlog | 21.3 | 3.6 |
| 5 | `indexam::index_insert` | indexam | 18.8 | 3.2 |
| 6 | `ring [pglite-opfs-repacked.js:15302]` | host JS | 15.2 | 2.6 |
| 7 | `<types_storage::bufpage::PageMut>::add_item` | types_storage | 11.3 | 1.9 |
| 8 | `xloginsert::insert_record` | xloginsert | 10.4 | 1.8 |
| 9 | `bufmgr::read::BufferAlloc` | bufmgr | 9.9 | 1.7 |
| 10 | `bytes [pglite-opfs-repacked.js:15174]` | host JS | 8.6 | 1.5 |
| 11 | `heapam::hio::RelationGetBufferForTuple` | heapam | 8.1 | 1.4 |
| 12 | `nodemodifytable::exec_insert::<…modify_table_arm::{closure#1}>` | nodemodifytable | 8.0 | 1.4 |
| 13 | `exectuples::deform::heap_getsomeattrs_int` | exectuples | 6.9 | 1.2 |
| 14 | `bufmgr::pin::PinBuffer` | bufmgr | 6.8 | 1.2 |
| 15 | `<waiter::clock::real::RealClock as waiter::clock::WaiterClock>::wait` | guest blocked | 6.6 | 1.1 |
| 16 | `nbtree::insert::bt_delete_or_dedup_one_page` | nbtree | 6.4 | 1.1 |
| 17 | `execexpr::interp::run_program` | execexpr | 5.9 | 1.0 |
| 18 | `nbtree::insert::bt_insertonpg` | nbtree | 5.6 | 1.0 |
| 19 | `nbtree::insert::bt_binsrch_insert` | nbtree | 4.9 | 0.8 |
| 20 | `nodeseqscan::exec_seq_scan` | nodeseqscan | 4.7 | 0.8 |
| 21 | `execindexing::ExecInsertIndexTuples` | execindexing | 4.3 | 0.7 |
| 22 | `<hashbrown::map::HashMap<RelFileLocatorBackend, u32, …, mcx::Mcx>>::get_inner` | hashbrown | 4.2 | 0.7 |
| 23 | `<nbtree::fcframe::OrderProcFrame>::cmp` | nbtree | 4.1 | 0.7 |
| 24 | `lwlock::LWLockRelease` | lwlock | 4.0 | 0.7 |
| 25 | `<pgstat::pending::PgStatState>::prep_pending_entry` | pgstat | 3.9 | 0.7 |

**Row 6, Creating an index** (window 43.1 ms, about 170 samples; the Arm's row 6 is flagged in §4.1)

| # | function | bucket | self ms | % of window |
| --- | --- | --- | --- | --- |
| 1 | `#call [pglite-opfs-repacked.js:15922]` | host JS: sync broker request | 9.8 | 22.7 |
| 2 | `pg_qsort::qsort_rec::<tuplesort::SortTuple, …>` | pg_qsort | 6.5 | 14.9 |
| 3 | `nbtsort::btbuild` | nbtsort | 4.0 | 9.3 |
| 4 | `nbtree::itup::form_tuple` | nbtree | 3.1 | 7.1 |
| 5 | `heapam_visibility::HeapTupleSatisfiesVacuumHorizon` | heapam_visibility | 1.5 | 3.5 |
| 6 | `bytes [pglite-opfs-repacked.js:15174]` | host JS | 1.3 | 2.9 |
| 7 | `waitGate [sab-pipe.js:152]` | host JS: blocked in Atomics.wait | 1.2 | 2.9 |
| 8 | `<tuplesort::Tuplesort>::putindextuplevalues::{closure#0}` | tuplesort | 1.2 | 2.9 |
| 9 | `heapam::heapgettup` | heapam | 1.2 | 2.8 |
| 10 | `nbtree::utils::bt_keep_natts_fast` | nbtree | 1.0 | 2.2 |
| 11 | `execindexing::FormIndexDatum` | execindexing | 0.9 | 2.2 |
| 12 | `nbtsort::buildadd` | nbtsort | 0.9 | 2.1 |
| 13 | `<tuplesort::Tuplesort>::getindextuple::{closure#0}` | tuplesort | 0.8 | 1.9 |
| 14 | `exectuples::deform::slot_getsomeattrs_int` | exectuples | 0.7 | 1.5 |
| 15 | `bufmgr::write::checksum::page_checksum` | bufmgr | 0.6 | 1.4 |
| 16 | `merged.<computed> [pglite-opfs-repacked.js:16715]` | host JS | 0.6 | 1.4 |
| 17 | `bufmgr::ops::LockBuffer` | bufmgr | 0.6 | 1.4 |
| 18 | `crc32c::sb8::pg_comp_crc32c_sb8` | crc32c | 0.6 | 1.4 |
| 19 | `<types_storage::bufpage::PageMut>::add_item` | types_storage | 0.6 | 1.4 |
| 20 | `<tuplesort::TuplesortData>::sort_memtuples_inner` | tuplesort | 0.6 | 1.4 |
| 21 | `<hashbrown::map::HashMap<RelFileLocatorBackend, u32, …, mcx::Mcx>>::get_inner` | hashbrown | 0.6 | 1.4 |
| 22 | `ring [pglite-opfs-repacked.js:15302]` | host JS | 0.6 | 1.4 |
| 23 | `<nbtree::itup::ItupBuf>::with_size` | nbtree | 0.6 | 1.3 |
| 24 | `(garbage collector)` | V8 | 0.3 | 0.7 |
| 25 | `xloginsert::insert_record` | xloginsert | 0.3 | 0.7 |

**Row 14, A big INSERT after a big DELETE** (window 340.8 ms)

| # | function | bucket | self ms | % of window |
| --- | --- | --- | --- | --- |
| 1 | `#call [pglite-opfs-repacked.js:15922]` | host JS: sync broker request | 79.8 | 23.4 |
| 2 | `nbtree::search::bt_compare` | nbtree | 27.0 | 7.9 |
| 3 | `indexam::index_insert` | indexam | 17.3 | 5.1 |
| 4 | `transam_xlog::insert::XLogInsertRecord` | transam_xlog | 15.8 | 4.6 |
| 5 | `<types_storage::bufpage::PageMut>::add_item` | types_storage | 12.1 | 3.5 |
| 6 | `crc32c::sb8::pg_comp_crc32c_sb8` | crc32c | 11.1 | 3.3 |
| 7 | `xloginsert::insert_record` | xloginsert | 10.7 | 3.1 |
| 8 | `nodemodifytable::exec_insert::<…modify_table_arm::{closure#1}>` | nodemodifytable | 10.5 | 3.1 |
| 9 | `<waiter::clock::real::RealClock as waiter::clock::WaiterClock>::wait` | guest blocked | 8.5 | 2.5 |
| 10 | `bufmgr::read::BufferAlloc` | bufmgr | 6.8 | 2.0 |
| 11 | `ring [pglite-opfs-repacked.js:15302]` | host JS | 5.6 | 1.6 |
| 12 | `nbtree::utils::bt_mkscankey` | nbtree | 5.3 | 1.5 |
| 13 | `<nbtree::fcframe::OrderProcFrame>::cmp` | nbtree | 4.7 | 1.4 |
| 14 | `<hashbrown::map::HashMap<RelFileLocatorBackend, u32, …, mcx::Mcx>>::get_inner` | hashbrown | 4.1 | 1.2 |
| 15 | `nbtree::insert::bt_insertonpg` | nbtree | 4.1 | 1.2 |
| 16 | `lwlock::LWLockRelease` | lwlock | 4.1 | 1.2 |
| 17 | `nbtree::insert::bt_delete_or_dedup_one_page` | nbtree | 3.7 | 1.1 |
| 18 | `execindexing::ExecInsertIndexTuples` | execindexing | 3.4 | 1.0 |
| 19 | `nbtree::utils::bt_keep_natts_fast` | nbtree | 3.1 | 0.9 |
| 20 | `bufmgr::pin::PinBuffer` | bufmgr | 3.0 | 0.9 |
| 21 | `bytes [pglite-opfs-repacked.js:15174]` | host JS | 2.9 | 0.8 |
| 22 | `nbtree::insert::bt_binsrch_insert` | nbtree | 2.9 | 0.8 |
| 23 | `bufmgr::ReadBufferExtended` | bufmgr | 2.9 | 0.8 |
| 24 | `nbtree::page::bt_checkpage_ref` | nbtree | 2.8 | 0.8 |
| 25 | `nbtree::itup::form_tuple` | nbtree | 2.8 | 0.8 |

Self time in the groups the question named, per row, as % of the window (zero means not one sample):

| group | row 11 | row 6 | row 14 |
| --- | --- | --- | --- |
| allocator (`dlmalloc`, `dlfree`, `realloc`, `__rust_alloc`, …) | 0.1 | 0.0 | 0.2 |
| mcx (pgrust memory contexts) | 0.3 | 0.0 | 0.4 |
| executor (`exec*`, `node*` crates) | 7.1 | 3.7 | 6.2 |
| sort (`tuplesort`, `pg_qsort`) | 0.4 | 22.5 | 0.7 |
| unwind (`_Unwind_*`) | 0.0 | 0.0 | 0.0 |
| seams (`*_seams` crates) | 0.0 | 0.0 | 0.4 |
| thread-local (`std::sys::thread_local` storage) | 0.1 | 0.0 | 0.2 |
| memcpy/memmove/memset/memcmp | 0.0 | 0.0 | 0.1 |
| **host JS: the sync broker request (`#call`)** | **36.6** | **22.7** | **23.4** |
| host JS: everything else (broker client encoding, `ring`, pipes) | 8.0 | 9.3 | 5.9 |
| guest blocked (futex, channel, latch wait) | 1.1 | 0.0 | 2.5 |
| V8 (GC, program) | 0.2 | 0.7 | 0.0 |

Self time by crate, every bucket at 1% or more of the window:

| row 11 bucket | % | row 6 bucket | % | row 14 bucket | % |
| --- | --- | --- | --- | --- | --- |
| host JS: `#call` | 36.6 | host JS: `#call` | 22.7 | host JS: `#call` | 23.4 |
| nbtree | 12.5 | pg_qsort | 15.6 | nbtree | 19.3 |
| bufmgr | 7.6 | nbtsort | 12.0 | bufmgr | 9.1 |
| host JS: store bundle, other | 7.3 | nbtree | 10.7 | transam_xlog | 6.0 |
| transam_xlog | 4.3 | tuplesort | 6.8 | indexam | 5.1 |
| crc32c | 3.9 | host JS: store bundle, other | 6.4 | host JS: store bundle, other | 4.0 |
| indexam | 3.2 | heapam_visibility | 3.5 | nodemodifytable | 3.8 |
| heapam | 3.2 | bufmgr | 2.9 | types_storage | 3.5 |
| types_storage | 1.9 | host JS: blocked in `Atomics.wait` | 2.9 | xloginsert | 3.5 |
| xloginsert | 1.9 | heapam | 2.8 | crc32c | 3.3 |
| nodemodifytable | 1.9 | execindexing | 2.2 | guest blocked | 2.5 |
| exectuples | 1.8 | exectuples | 1.5 | heapam | 2.1 |
| execexpr | 1.3 | crc32c | 1.4 | pgstat | 1.3 |
| pgstat | 1.2 | types_storage | 1.4 | hashbrown | 1.2 |
| planner | 1.2 | catalog_index | 1.4 | lwlock | 1.2 |
| execindexing | 1.2 | hashbrown | 1.4 | execindexing | 1.2 |
| guest blocked | 1.1 | | | | |

Top 10 by total (inclusive) time. The thread-entry chain every sample sits under (`runThread`,
`js-to-wasm`, `wasi_thread_start`, …) is left out; what remains is the backend's own call chain:

| # | row 11 | % | row 6 | % | row 14 | % |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `postgres::simple_query::exec_simple_query` | 99.7 | `postgres::main_loop::PostgresMain` | 94.2 | `postgres::main_loop::PostgresMain` | 99.9 |
| 2 | `postgres::main_loop::dispatch_message` | 99.7 | `postgres::postgres_main_seam` | 94.2 | `postgres::postgres_main_seam` | 99.9 |
| 3 | `postgres::main_loop::PostgresMain` | 99.7 | `backend_startup::backend_main` | 94.2 | `backend_startup::backend_main` | 99.9 |
| 4 | `postgres::postgres_main_seam` | 99.7 | `launch_backend::run_child_task` | 94.2 | `launch_backend::run_child_task` | 99.9 |
| 5 | `backend_startup::backend_main` | 99.7 | `postgres::simple_query::exec_simple_query` | 91.3 | `postgres::simple_query::exec_simple_query` | 99.7 |
| 6 | `launch_backend::run_child_task` | 99.7 | `postgres::main_loop::dispatch_message` | 91.3 | `postgres::main_loop::dispatch_message` | 99.7 |
| 7 | `execmain::querydesc::with_qd_dyn` | 75.3 | `utility::dispatch::exec_index_stmt` | 85.4 | `execmain::procnode::exec_proc_node` | 98.9 |
| 8 | `pquery::PortalRunMulti` | 75.3 | `utility::dispatch::slow_switch` | 85.4 | `execmain::execmain::execute_plan` | 98.9 |
| 9 | `pquery::PortalRun` | 75.3 | `utility::dispatch::process_utility_slow` | 85.4 | `execmain::querydesc::with_qd::<…executor_run_seam…>` | 98.9 |
| 10 | `nodemodifytable::exec_modify_table::<…>` | 75.3 | `utility::dispatch::dispatch_switch` | 85.4 | `execmain::querydesc::with_qd_dyn` | 98.9 |

What the profile shows, and nothing more:

- **None of the suspected runtime taxes is there.** The allocator, pgrust's memory contexts,
  unwinding, the seams, thread-local access and memcpy/memmove together are at most 1.3% of any of
  the three windows. `memcpy`, `memmove` and `memset` do not exist as functions in this module at all
  (bulk-memory `memory.copy` and `memory.fill` are inline); `dlmalloc` and `_Unwind_RaiseException`
  do exist, and the allocator is 0.0–0.2% of these windows and unwinding never sampled.
- **The guest's own time is PostgreSQL's work**: B-tree search and insert, the buffer manager, WAL
  insertion and its CRC (the software `pg_comp_crc32c_sb8`, 3.3–3.9% on rows 11 and 14), and on row 6
  the sort and the B-tree build.
- **The largest single item on all three rows is the backend waiting on its store**: 36.6%, 22.7% and
  23.4% of the window in `#call`, plus 5.9–9.3% more in other host JS (mostly the same bundle's request
  encoding and `ring`). On the heap store the coordinator is outside its `wait` for 27.3%, 22.4% and
  16.1% of the same windows (`coordinator-row-slices.log`), so on rows 11 and 14 at least a quarter
  and a third of the backend's wait is the hand-off between the two threads rather than the
  coordinator's work.

Walking each `#call` sample up to the nearest pgrust frame (`broker-callers.log`) says what the
backend is asking the store for:

| row | `#call` ms | the pgrust frame the request comes from |
| --- | --- | --- |
| 11 | 213.5 | `XLogFileInitInternal` 50.6% (zero-filling a new WAL segment through `pg_pwrite_zeros`), `smgrzeroextend` 28.2% (zero-filling relation extensions through `FileZero`), `XLogWrite` 15.9%, `mdopenfork` 3.9%, `issue_xlog_fsync` 1.1% |
| 6 | 9.8 | `mdextend_inner` 67.6%, `issue_xlog_fsync` 13.7%, `XLogWrite` 6.4%, other 12.3% |
| 14 | 79.8 | `smgrzeroextend` 52.1%, `XLogWrite` 29.0%, `mdopenfork` 18.6% (`path_open`), `issue_xlog_fsync` 0.4% |

These are the requests that go to OPFS in the browser's store column. Under node each costs a write
into the coordinator's heap image and two thread hand-offs; on OPFS it is a synchronous access handle
operation in the coordinator instead. How much each costs there was not measured (§6).

## 5. Verdict

| Row | Browser multiple here (`pgrust-postmaster-opfs-repacked-relaxed` ÷ `pglite-memory`, both rounds) | Port: native pgrust ÷ C (four pairs) | Wasm codegen: Chromium `pgrust-memory` ÷ `pglite-memory` | Threads and transport: `pgrust-postmaster-memory-broker` ÷ `pgrust-memory` | Host: the OPFS step (PGlite's own OPFS step) | **Verdict** | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **11: INSERTs from a SELECT** | 9.16× | 0.75×, 1.26×, 1.26×, 1.13× | 0.75× (0.73× / 0.76×) | 1.83× (threads 1.12×, broker 1.57×, postmaster 1.04×) | **6.72×** (4.53×) | **host**: the OPFS store, 86% of the multiple on a log scale; threads and transport second, 27%, most of it the broker seam | high: every rung agrees in both rounds, and the OPFS step is 7.8× and 5.6× taken round by round (`verdict.log`) |
| **6: Creating an index** | 4.36× | 1.05×, 1.06×, 0.93×, 1.35× | 0.89× (0.66× / 1.17×) | 1.61× (1.29×, 1.10×, 1.14×) | **3.05×** (2.99×) | **host**: the OPFS store, 76%; threads and transport second, 32%, spread over all three steps | medium: a 25–150 ms row, `pgrust-memory`'s ratio to PGlite moves 0.66× → 1.17× between rounds, and the profile arm is 13% slow here (§4.1); the OPFS step is 3.1× and 3.0× round by round |
| **14: A big INSERT after a big DELETE** | 6.31× | 1.02×, 1.30×, 1.22×, 1.28× | 1.08× (1.05× / 1.11×) | 1.65× (1.02×, 1.55×, 1.05×) | **3.53×** (3.34×) | **host**: the OPFS store, 68%; threads and transport second, 27%, most of it the broker seam | medium-high: the OPFS column itself moved 1429 → 850 ms between rounds, but the OPFS step is 3.8× and 3.1× taken round by round |

Neither the port nor the wasm codegen carries more than a sliver of the multiple on these rows:
natively pgrust is at most 1.35× C, and as a single-thread wasm module it is at most 1.08× PGlite,
paying a smaller wasm tax than C does. The threads target, the broker seam and the postmaster cost 1.61–1.83× together. The
OPFS store costs 3.05–6.72×, and PGlite pays the same store design 2.99–4.53× on the same rows.

## 6. What this does not show

- **Which OPFS operation costs what.** The OPFS rung was measured, not profiled: node has no OPFS,
  and the profile lane (§4.2) reproduces the memory-broker multiple and nothing beyond it. The
  broker requests the profile names (WAL segment zero-fill, relation-extension zero-fill, WAL writes,
  file opens) are what the backend asks for; their cost on OPFS is the next thing to measure, in
  Chromium, on the coordinator's worker.
- **Why pgrust asks more of the store than PGlite does.** pgrust on OPFS is 1.46–2.02× PGlite on
  OPFS. The two wasm engines do not run the same configuration (`node-settings.log`): pgrust's lanes
  run `fsync=on`, `file_extend_method=write_zeros`, `shared_buffers` 32 MB and `wal_buffers` -1
  (1 MB), PGlite `fsync=off`, `posix_fallocate`, 128 MB and 4 MB. PGlite also reaches its store in
  process, without a broker. None of these was varied here.
- **The earlier multiples, exactly.** The whole ladder measured 9.16×, 4.36× and 6.31× here
  against the 7.4×, 5.1× and 4.9× this investigation started from. The OPFS column is the one that
  moved: with the same module on 19 September ([`findings/0002`](../findings/0002-pgrust-autocommit-insert-regression.md)
  §"Adopted") it ran row 11 in 2066.6 and 2107.0 ms, row 6 in 139.2 and 143.4, row 14 in 846.1 and
  791.3 and the Suite in 19 061 and 19 012 ms; here 3668.8 and 2566.7, 150.9 and 139.1, 1429.3 and
  849.8, and 28 397 and 22 280. The machine had 23 of 30 GiB in use and a VM running. That is a
  statement about the host, and the verdict does not depend on it: the OPFS step is the largest step
  on every row in every round here, and it stays the largest if the 19 September OPFS times are put
  over today's memory-broker rung (4.50×, 2.97× and 2.53× on rows 11, 6 and 14, against at most
  1.57× for any other step; a cross-day ratio, for scale only, in `verdict.log`).
- **Interleaving across the store supplement.** PGlite on OPFS ran after the ladder, not between
  its rungs.
- **Other rows.** The tables carry all 18 rows; no verdict is drawn for any row but 11, 6 and 14.
  Rows 16, 13, 9 and 10 remain unexplained here.
- **A literal `--profile dist` native binary.** The native binary has dist's codegen but the
  Spencer regex engine and rustc 1.98.1 (§2.1). No Suite script uses a regular-expression operator.
- **A byte-identical profile arm.** The Arm differs from the shipped module in Binaryen version
  (133 against 132) and, through the names, in function order (§4.1). It times the same as the
  shipped module on rows 11 and 14 and the Suite, and 13% slower on row 6 (medians).
- **Any other browser, machine or OS.** One i7-1165G7 on Linux, headless Chromium 149. No Safari,
  no WebKit, no phone. OPFS is implemented separately by each browser, and nothing here says how the
  host step behaves in another one.

## Reproduction

In this repo, from the root, scratch under `tmp/agents/anchors/` (its own `package.json` with
`postgres@3.4.9`, `bun install` there):

```
# builds (in the pgrust checkout; nothing is committed there)
tmp/agents/anchors/build-native.sh                 # dist codegen, dev-rooted profile, target/anchor-natdist/postgres
tmp/agents/anchors/build-arm.sh                    # names kept via linker/wasm-ld; copy target/.../postgres.wasm to arm-named.wasm
tmp/agents/anchors/repro-shipped-opt.sh            # Binaryen 133 over the saved shipped raw link: the b133 control

# Anchor A
bun tmp/agents/anchors/native-ab.ts --rounds 2
bun tmp/agents/anchors/native-ab.ts --rounds 2 --tag nopar \
  --extra max_parallel_workers_per_gather=0,max_parallel_maintenance_workers=0

# Anchor B (one Configuration per Run; round 2 reverses the order)
bun tmp/agents/anchors/browser-ladder.ts --round 1
bun tmp/agents/anchors/browser-ladder.ts --round 2
bun tmp/agents/anchors/browser-ladder.ts --round 3 --configs pglite-opfs-repacked-relaxed
bun tmp/agents/anchors/browser-ladder.ts --round 4 --configs pglite-opfs-repacked-relaxed

# Anchor C (each lane is node --import ./tmp/agents/anchors/node-ts-hooks.ts tmp/agents/anchors/node-suite.ts ...)
bun tmp/agents/anchors/node-lanes.ts                # PGlite, shipped, arm, b133 x2, then the profiled arm
bun tmp/agents/anchors/node-lanes.ts --set parity2  # shipped, arm x2 more
bun tmp/agents/anchors/slice-cpuprofile.ts tmp/agents/anchors/prof/arm \
  tmp/agents/anchors/results/node-arm-prof.json 11,6,14 tmp/agents/anchors/prof/arm-slices.md
bun tmp/agents/anchors/broker-callers.ts tmp/agents/anchors/prof/arm tmp/agents/anchors/results/node-arm-prof.json 11

# every table above
bun tmp/agents/anchors/tables.ts
bun tmp/agents/anchors/verdict.ts
```
