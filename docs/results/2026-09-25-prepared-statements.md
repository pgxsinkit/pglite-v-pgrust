# Prepared statements: a reused generic plan halves pgrust's per-statement cost on the index rows and takes it from 1.74–1.80× PGlite to 1.34–1.45× (1.09–1.20× in Chromium on disk)

- Date: 2026-09-25
- Machine: i7-1165G7 (8 logical cores), 30 GiB, Linux 7.0.0-34-generic. An incus VM (`dev101`, qemu,
  not started by this probe) came up at 10:30 and took two cores while it booted, which held the
  first Run at the load gate for 135 s; sampled every 15 s from 10:43 to 11:10 (every Run but the
  first two), it took 64% of a core on average, above one core in 18 of 107 samples, at most 240%
  (`vm-sampler.log`). Every timed Run waited for a 1-minute load under 2.5 (§1).
- Lane: **node v26.10.0**, bite 3's node lane (the
  [per-statement profile](2026-09-25-per-statement-profile.md), §3): the bench's own engine
  (`createPgrustPglite`, the postmaster with its backends as `node:worker_threads`, the broker store on
  the coordinator's heap, `durability: "strict"` with `fsync=off` passed last), and PGlite in memory on
  node's main thread; bun 1.4.2 for the drivers. Browser check: headless **Chromium 149.0.7827.55**
  (Playwright 1.61.1) in the bench's persistent context, the two disk-lane columns (§9).
- Engines: **pgrust** `spike/wasip1-threads@569d16128c` (PostgreSQL 18.6), the published threads
  module `df17f7e24a33…` for every timed Run and bite 1's named Arm `c0e376f19e36…` for the profiled
  ones; **PGlite** `@pgxsinkit/pglite 0.5.5-pgx.3` (PostgreSQL 18.3), its published `pglite.wasm`
  `9f9ec7f25956…` for the timed Runs and bite 3's named build of the same bytes `ecd4ef287d40…` for
  the profiled ones.
- Drivers and raw artefacts: `tmp/agents/prepared/` (untracked). Every number below is printed by a
  script there from the Runs' own JSON, `.cpuprofile` and server-log files (Reproduction).
- Nothing was adopted. No pgrust file was edited, no pgrust build was made, and nothing in this
  repo's `src/` changed. `dist/` and `public/pgrust/` were sha-verified before and after every Run
  (node and browser) and never modified.

## What this answers

[The per-statement profile](2026-09-25-per-statement-profile.md) found that pgrust's remaining
1.5–1.8× over PGlite on the statement-heavy Speedtest rows is per-statement fixed cost: the planner
first (2.9–3.6× PGlite's planner self time on rows 7, 9 and 10), then executor start and end, the
catalog caches, parse analysis and the portal code. pgxsinkit's sync applier and live queries send
the same statement shapes over and over, so a client can prepare them. This note measures what a
prepared statement buys each engine per statement, at the SQL level (`PREPARE`/`EXECUTE`) and on the
wire (a named statement, Parse once, Bind/Execute per statement), on Speedtest rows 1, 7, 9 and 10,
and whether the gap to PGlite narrows.

**Eight findings.**

1. **A reused generic plan takes the planner and parse analysis out of the per-statement path in both
   engines**, and pgrust has more to lose there. Every prepared Run switched to a generic plan at the
   sixth execution in both engines (5 custom plans, then generic, `pg_prepared_statements` after
   every warm row), with the same plan shape as the literal statement (`explain.log`). Warm, the
   planner goes from 36.3 and 26.2 µs a statement (rows 7 and 9) to 0.0–0.1 in pgrust and from 9.8
   and 7.5 to 0.0–0.1 in PGlite; parse analysis from 9.5 and 6.0 to 0.0–0.7 (§6).
2. **The gap narrows, and most of it goes.** With the PREPARE sent alone and the EXECUTEs in one text
   (A2, the fastest pgrust variant), pgrust is 1.34×, 1.39× and 1.45× PGlite on rows 7, 9 and 10
   warm, from 1.75×, 1.80× and 1.74× for the literal rows; the difference per statement falls from
   59.9, 46.1 and 50.8 µs to 14.1, 12.5 and 18.0. pgrust saves 83.7, 58.8 and 61.5 µs a statement
   (52–60%), PGlite 37.9, 25.2 and 28.7 (42–48%) (§3, §4, §5).
3. **What is left is executor setup and teardown, the B-tree and the portal code.** On warm row 9
   the remaining +12.5 µs is the executor +5.9 (ExecutorStart 7.2 against 3.3 µs, ExecutorEnd 2.8
   against 1.4), the B-tree +2.3, the portal code +1.8, Rust's generic code +1.8, buffers +1.3 and
   the heap +1.1; the catalog caches fall from +3.4 to +0.5 (§6).
4. **On the wire, a named statement is the fastest variant for PGlite but not for pgrust.** B named
   gives pgrust 54.4, 50.1 and 60.5 µs a statement on rows 7, 9 and 10 (A2: 56.1, 44.7, 57.6) and
   PGlite 35.7, 29.7 and 38.0 (A2: 42.0, 32.2, 39.6), so 1.52×, 1.68× and 1.59×. Each statement is
   three protocol messages, and in pgrust each message reads the host clock through the WASI shim
   (`clock_time_get` and the `DataView` it builds: the message I/O bucket is 3.4 µs a statement on
   row 9, against A2's 0.2); 41% of those clock reads come from `check_log_duration`, which in pgrust
   reads the clock before it tests the logging settings and in C does not (§6).
5. **The unnamed extended protocol costs more than the literal text in both engines**: Parse, Bind,
   Describe and Execute per statement (what PGlite's own `query(sql, params)` sends) is 37–42% slower
   than the literal rows on 7, 9 and 10 in pgrust and 30–38% in PGlite, and the ratio does not move
   (1.78–1.91×) (§5).
6. **pgrust's plan cache follows C's rule**, so both engines make five custom plans, build the
   generic plan on the sixth execution and reuse it from the seventh. One statement per round trip, the seventh
   execution onward is 80–109 µs faster than the second to fifth in pgrust and 52–69 µs in PGlite on
   the row 7 and row 9 shapes; the sixth is not faster, since it builds the generic plan (§7).
7. **The brief's variant A, PREPARE in the same text as its EXECUTEs, is a trap in both engines.**
   A prepared statement keeps the whole message text as its source (65 578 characters for a 64 KiB
   text in both engines, `leak-*.log`). C copies that text into every EXECUTE's portal: PGlite's A is
   3.2× its literal row 9 and 6.3× row 10, the excess growing with the text at about 4 GB/s. pgrust's
   `PortalDefineQuery` copies every portal's source text into `TopPortalContext` and never frees it,
   so every EXECUTE and every extended-protocol Bind that is not reusing a parked portal leaks its
   statement text for the life of the session; on A's row 9 the backend aborted with 2.42 GB in
   `TopPortalContext` (§8).
8. **Chromium on disk confirms A2 and narrows further**: on the two disk-lane columns, A2 takes
   pgrust from 1.48×, 1.51× and 1.56× PGlite OPFS to 1.17×, 1.09× and 1.20× on rows 7, 9 and 10 warm;
   the difference per statement falls from 43.5, 35.8 and 44.2 µs to 7.5, 3.7 and 9.9 (§9).

## Method

- **Variants.** Rows 1, 7, 9 and 10 of the Speedtest, from the bench's own `benchmark<N>.sql`, with
  the same data and the same statements in the loop (`make-sql.ts`, `sql/`):
  - **baseline**: the row as it is, one text over the simple query protocol;
  - **A**: `PREPARE` once, then one `EXECUTE` per statement, all in one text (the brief's A);
  - **A2**: the same statements, the `PREPARE` sent first as a short text of its own (with row 1's
    `CREATE TABLE`, which the `PREPARE` needs), then the `EXECUTE`s in a second text; both texts in
    one timed window. Added after A turned out to measure the text copy of §8, not the prepared
    statement;
  - **B unnamed (Bu)**: one extended-protocol batch per row: Parse, Bind, Describe (portal) and
    Execute per statement on the unnamed statement, one Sync at the end;
  - **B named (Bn)**: one batch: Parse of a named statement once, then Bind, Describe and Execute per
    statement, one Sync at the end.

  The B batches go through the clients' own `execProtocol`, which both expose: PGlite's
  `execProtocol` runs a batch through `PostgresMainLoopOnce` until the input is consumed, and the
  bench's pgrust client (`src/client/pgrust-pglite.ts`) sends a batch whole and reads until the reply
  to its last message, here `ReadyForQuery`. So a named statement needed no client code. A batch ends
  in one Sync, so its statements run in one implicit transaction, as a multi-statement text does; the
  statements around the loop (`CREATE TABLE`, `BEGIN`, `COMMIT`) go through the unnamed statement in
  the same batch. The batch bytes are built with PGlite's own protocol serializer before the clock
  starts (9.5–15.0 µs a statement, `tables.md`, not in any figure below); the texts are read from
  files, so no variant's figure includes building the statements.
- **Rounds.** One node process per engine and variant (`driver.ts --mode rows`). Round 1 is the Suite
  as it runs, rows 1 to 10 in order with the variant in rows 1, 7, 9 and 10: **cold**. Rounds 2 and 3
  run the four variant rows again in the same engine, each from the state the Suite gives it,
  restored untimed (`DROP TABLE t1` before row 1; `DROP TABLE t2`, `benchmark2.sql` and
  `benchmark6.sql` before row 7; row 9 follows row 7 and row 10 follows row 9, as in the Suite):
  **warm**. `DEALLOCATE ALL` (untimed) precedes every variant row. Two processes per engine and
  variant, interleaved (`lanes.ts --set rows`), so each warm cell has four values and each cold cell
  two.
- **Microseconds per statement**: the row's milliseconds over the Suite's statement count (1 000,
  5 000, 25 000, 25 000), whatever the variant adds (a `PREPARE`, a Parse).
- **Correctness.** The 26 rows-mode Runs that ran three rounds (profiled ones included) end with the
  same checksums of t1 and t2, the two one-round A Runs end after row 8 (which doubles t1's b) with
  the same checksums as each other, and all 75 row 7 texts timed return 5 000 results whose counts
  sum to 25 000 (`tables.md`, "Checksums").
- **Profiles.** For rows 7 and 9, one profiled process per engine for each of baseline, A2 and B named
  (`lanes.ts --set prof`, `node --cpu-prof --cpu-prof-interval 250`), sliced by bite 3's slicer over
  the two warm windows (`slices.sh`), with bite 3's buckets; a bucket's share times the unprofiled
  warm median of the same engine and variant, over the statement count.
- **Load gate.** Bite 1's gate (`tmp/agents/anchors/load.ts`): each timed Run started only with the
  1-minute load under 2.5, checked every 15 s for at most 10 minutes. Profiled and browser Runs are
  gated too.

## 1. Environment and load

41 gated Runs, one at a time, none at the 10-minute cap; the longest wait was 135 s (the first Run,
while the VM booted). 1-minute, 5-minute and 15-minute load before and after (`tables.md`, "Load";
`browser-tables.md`, "Load"):

| Run | waited | load before → after (1/5/15) |
| --- | --- | --- |
| pgrust-baseline-p1 | 135 s | 2.26 2.26 2.68 → 2.89 2.41 2.72 |
| pglite-baseline-p1 | 75 s | 2.37 2.41 2.69 → 2.37 2.41 2.69 |
| pgrust-A-p1 (rows 1, 7, one round) | 0 s | 1.00 1.94 2.49 → 1.14 1.94 2.48 |
| pgrust-A1-p1 (row 1, three rounds) | 0 s | 1.29 1.96 2.49 → 1.56 1.99 2.49 |
| pglite-A-p1 | 0 s | 1.56 1.99 2.49 → 1.88 2.02 2.47 |
| pgrust-A2-p1 | 0 s | 1.88 2.02 2.47 → 2.36 2.12 2.49 |
| pglite-A2-p1 | 0 s | 2.36 2.12 2.49 → 2.15 2.08 2.48 |
| pgrust-Bu-p1 | 0 s | 2.15 2.08 2.48 → 2.09 2.07 2.46 |
| pglite-Bu-p1 | 0 s | 2.09 2.07 2.46 → 2.24 2.12 2.46 |
| pgrust-Bn-p1 | 0 s | 2.24 2.12 2.46 → 1.96 2.07 2.44 |
| pglite-Bn-p1 | 0 s | 1.96 2.07 2.44 → 1.88 2.05 2.42 |
| pgrust-baseline-p2 | 0 s | 1.88 2.05 2.42 → 1.84 2.02 2.41 |
| pglite-baseline-p2 | 0 s | 1.77 2.01 2.40 → 1.82 2.01 2.39 |
| pgrust-A-p2 (rows 1, 7, one round) | 0 s | 1.82 2.01 2.39 → 2.42 2.14 2.43 |
| pgrust-A1-p2 (row 1, three rounds) | 0 s | 2.42 2.14 2.43 → 2.10 2.08 2.41 |
| pglite-A-p2 | 0 s | 2.10 2.08 2.41 → 1.91 2.01 2.36 |
| pgrust-A2-p2 | 0 s | 1.91 2.01 2.36 → 1.78 1.98 2.34 |
| pglite-A2-p2 | 0 s | 1.78 1.98 2.34 → 1.82 1.98 2.34 |
| pgrust-Bu-p2 | 0 s | 1.82 1.98 2.34 → 2.42 2.12 2.37 |
| pglite-Bu-p2 | 0 s | 2.42 2.12 2.37 → 2.10 2.06 2.35 |
| pgrust-Bn-p2 | 0 s | 2.10 2.06 2.35 → 2.25 2.10 2.35 |
| pglite-Bn-p2 | 0 s | 2.15 2.09 2.35 → 2.05 2.07 2.34 |
| pgrust-plancache-p1 | 0 s | 1.33 1.88 2.27 → 1.87 1.98 2.29 |
| pglite-plancache-p1 | 0 s | 1.87 1.98 2.29 → 1.80 1.97 2.29 |
| pgrust-plancache-p2 | 0 s | 1.73 1.95 2.28 → 1.77 1.95 2.27 |
| pglite-plancache-p2 | 0 s | 1.77 1.95 2.27 → 1.87 1.97 2.28 |
| pgrust-A-full (§8; stopped on row 9) | 0 s | 1.57 1.89 2.24 → 0.90 1.36 1.91 |
| arm-baseline-prof | 0 s | 1.16 1.39 1.92 → 1.99 1.55 1.95 |
| pglite-named-baseline-prof | 0 s | 1.99 1.55 1.95 → 2.17 1.61 1.96 |
| arm-A2-prof | 0 s | 2.17 1.61 1.96 → 2.55 1.73 1.99 |
| pglite-named-A2-prof | 30 s | 2.48 1.81 2.01 → 2.46 1.83 2.01 |
| arm-Bn-prof | 0 s | 2.46 1.83 2.01 → 3.32 2.11 2.10 |
| pglite-named-Bn-prof | 30 s | 2.28 1.97 2.06 → 2.14 1.96 2.05 |
| browser pgrust-baseline-p1 | 0 s | 1.81 1.89 2.03 → 2.04 1.94 2.04 |
| browser pglite-baseline-p1 | 0 s | 2.04 1.94 2.04 → 1.89 1.91 2.02 |
| browser pgrust-A2-p1 | 0 s | 1.89 1.91 2.02 → 1.82 1.90 2.02 |
| browser pglite-A2-p1 | 0 s | 1.82 1.90 2.02 → 2.01 1.94 2.03 |
| browser pgrust-baseline-p2 | 0 s | 2.01 1.94 2.03 → 2.25 2.01 2.05 |
| browser pglite-baseline-p2 | 0 s | 2.25 2.01 2.05 → 2.29 2.04 2.06 |
| browser pgrust-A2-p2 | 0 s | 2.29 2.04 2.06 → 2.41 2.08 2.07 |
| browser pglite-A2-p2 | 0 s | 2.41 2.08 2.07 → 3.12 2.27 2.13 |

Not in the table: the first `pgrust-A-p1`, with rows 1 and 7 and three rounds, stopped at the start
of round 2 with `could not extend file "base/5/16403_fsm": I/O error`
(`results/pgrust-A-rounds3-eio.server.log`, §8), and the smoke Runs of each driver
(`results-smoke/`, never gated, never quoted). SHOW in every node Run: pgrust `fsync=off`,
`wal_init_zero=off`, `wal_buffers=4MB`, `synchronous_commit=on`, `plan_cache_mode=auto`; PGlite the
same but `wal_init_zero=on`.

## 2. The variants

Row 9 as each variant sends it (row 7 and row 10 have the same shape; `sql/`):

```sql
-- baseline (benchmark9.sql, 911 062 bytes): one text
BEGIN;
UPDATE t2 SET b=6669 WHERE a=1;
UPDATE t2 SET b=58207 WHERE a=2;
-- ... 25 000 UPDATEs
COMMIT;

-- A (row9-A.sql, 636 125 bytes): one text
BEGIN;
PREPARE p9(integer, integer) AS UPDATE t2 SET b=$1 WHERE a=$2;
EXECUTE p9(6669, 1);
EXECUTE p9(58207, 2);
-- ... 25 000 EXECUTEs
COMMIT;

-- A2: two texts, in one timed window
PREPARE p9(integer, integer) AS UPDATE t2 SET b=$1 WHERE a=$2;   -- row9-A2-prepare.sql
BEGIN; EXECUTE p9(6669, 1); ... COMMIT;                           -- row9-A2-execute.sql
```

The other three shapes: row 1 `PREPARE p1(integer, integer, varchar) AS INSERT INTO t1 VALUES($1, $2,
$3)`; row 7 `PREPARE p7(integer, integer) AS SELECT count(*), avg(b) FROM t2 WHERE b>=$1 AND b<$2`;
row 10 `PREPARE p10(varchar, integer) AS UPDATE t2 SET c=$1 WHERE a=$2`. The parameter types are the
columns' own.

The B batches, as protocol messages (`row<N>-B.json` holds the statement, its parameter type OIDs
and the 25 000 parameter tuples; `driver.ts` builds the bytes):

| variant | row 9's batch | bytes |
| --- | --- | --- |
| Bu | P/B/E `BEGIN`; 25 000 × (Parse `UPDATE t2 SET b=$1 WHERE a=$2` [int4, int4], Bind, Describe P, Execute); P/B/E `COMMIT`; Sync | 2 436 127 |
| Bn | P/B/E `BEGIN`; Parse `p9` once; 25 000 × (Bind `p9`, Describe P, Execute); P/B/E `COMMIT`; Sync | 1 336 175 |

Parameters go as text, as PGlite's `query` sends them. Describe (portal) is there because PGlite's own
`query` sends it; it makes each SELECT's reply carry a RowDescription, as the simple protocol's does.

## 3. Results, per row, engine and variant

Microseconds per statement (`tables.md`, "Results"). Warm: rounds 2 and 3 of process 1, then of
process 2, and their median; cold: round 1 of each process.

| row | variant | pgrust warm (p1 r2 / r3; p2 r2 / r3) | pgrust warm | pgrust cold (p1 / p2) | PGlite warm (p1 r2 / r3; p2 r2 / r3) | PGlite warm | PGlite cold (p1 / p2) | pgrust ÷ PGlite warm | cold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | baseline | 39.8 / 35.4; 37.4 / 35.8 | 36.6 | 146.2 / 166.0 | 27.8 / 21.0; 20.0 / 18.9 | 20.5 | 39.3 / 56.8 | 1.79× | 3.25× |
| 1: 1000 INSERTs | A | 29.1 / 78.6; 32.3 / 78.6 (row 1 alone) | 55.4 | 187.8 / 187.6 | 30.3 / 35.8; 28.3 / 41.8 | 33.0 | 63.1 / 45.8 | 1.68× | 3.45× |
| 1: 1000 INSERTs | A2 | 35.2 / 24.8; 25.7 / 30.6 | 28.1 | 133.8 / 133.4 | 14.7 / 15.6; 16.4 / 15.1 | 15.3 | 31.3 / 37.5 | 1.83× | 3.88× |
| 1: 1000 INSERTs | B unnamed | 70.9 / 69.3; 65.9 / 73.2 | 70.1 | 228.4 / 259.0 | 31.4 / 32.0; 32.5 / 30.9 | 31.7 | 79.1 / 71.4 | 2.21× | 3.24× |
| 1: 1000 INSERTs | B named | 26.2 / 31.9; 28.3 / 27.5 | 27.9 | 101.9 / 120.2 | 14.9 / 12.8; 12.7 / 11.5 | 12.8 | 40.2 / 32.8 | 2.19× | 3.04× |
| 7: 5000 SELECTs with an index | baseline | 150.5 / 138.5; 141.0 / 134.7 | 139.7 | 180.9 / 176.8 | 79.6 / 80.0; 85.5 / 78.8 | 79.8 | 101.0 / 100.1 | 1.75× | 1.78× |
| 7: 5000 SELECTs with an index | A | (does not run warm, §8) | - | 164.6 / 173.9 | 70.8 / 67.7; 77.1 / 103.1 | 74.0 | 80.0 / 74.9 | - | 2.19× |
| 7: 5000 SELECTs with an index | A2 | 57.4 / 55.9; 53.3 / 56.2 | 56.1 | 74.5 / 90.9 | 45.6 / 40.6; 41.8 / 42.1 | 42.0 | 48.9 / 51.4 | 1.34× | 1.65× |
| 7: 5000 SELECTs with an index | B unnamed | 196.5 / 196.7; 195.3 / 188.6 | 195.9 | 229.8 / 239.7 | 111.9 / 104.1; 109.2 / 111.1 | 110.2 | 127.3 / 128.4 | 1.78× | 1.84× |
| 7: 5000 SELECTs with an index | B named | 50.8 / 65.9; 53.2 / 55.5 | 54.4 | 71.4 / 75.2 | 35.9 / 35.5; 35.1 / 36.0 | 35.7 | 40.8 / 43.3 | 1.52× | 1.74× |
| 9: 25000 UPDATEs with an index | baseline | 102.8 / 102.6; 105.1 / 104.2 | 103.5 | 107.6 / 107.0 | 59.3 / 57.2; 55.5 / 57.5 | 57.4 | 60.7 / 63.5 | 1.80× | 1.73× |
| 9: 25000 UPDATEs with an index | A | (backend aborts, §8) | - | - | 182.6 / 182.2; 182.9 / 202.6 | 182.7 | 181.1 / 179.2 | - | - |
| 9: 25000 UPDATEs with an index | A2 | 44.5 / 44.3; 44.9 / 44.8 | 44.7 | 46.1 / 47.3 | 32.4 / 32.5; 31.8 / 31.9 | 32.2 | 31.5 / 33.9 | 1.39× | 1.43× |
| 9: 25000 UPDATEs with an index | B unnamed | 146.7 / 152.4; 146.7 / 145.0 | 146.7 | 148.3 / 151.1 | 77.3 / 75.9; 76.1 / 78.8 | 76.7 | 81.2 / 78.2 | 1.91× | 1.88× |
| 9: 25000 UPDATEs with an index | B named | 50.6 / 49.7; 54.9 / 48.5 | 50.1 | 49.3 / 49.9 | 31.3 / 29.2; 29.2 / 30.3 | 29.7 | 31.4 / 30.5 | 1.68× | 1.60× |
| 10: 25000 text UPDATEs with an index | baseline | 122.9 / 117.6; 117.5 / 120.6 | 119.1 | 120.1 / 118.7 | 68.3 / 68.4; 67.4 / 68.6 | 68.3 | 78.4 / 71.8 | 1.74× | 1.59× |
| 10: 25000 text UPDATEs with an index | A | (not run, §8) | - | - | 424.4 / 428.6; 434.5 / 446.3 | 431.6 | 429.2 / 429.1 | - | - |
| 10: 25000 text UPDATEs with an index | A2 | 57.8 / 57.4; 57.3 / 59.6 | 57.6 | 58.1 / 59.8 | 39.7 / 39.6; 40.4 / 39.3 | 39.6 | 43.8 / 43.5 | 1.45× | 1.35× |
| 10: 25000 text UPDATEs with an index | B unnamed | 164.6 / 163.9; 161.8 / 162.5 | 163.2 | 168.3 / 167.5 | 92.0 / 90.7; 86.7 / 87.7 | 89.2 | 91.0 / 93.1 | 1.83× | 1.82× |
| 10: 25000 text UPDATEs with an index | B named | 64.3 / 57.9; 58.9 / 62.0 | 60.5 | 61.1 / 62.3 | 39.0 / 37.4; 38.0 / 37.9 | 38.0 | 41.9 / 40.0 | 1.59× | 1.51× |

pgrust's A: rows 1 and 7 once (one-round processes), and row 1 alone three times (the `A1`
processes) for its warm figures; its round-3 row 1 is 78.6 µs in both processes, which this note did
not look into beyond §8. The baseline is within −1% to +11% of bite 3's warm figures (130.5 / 80.9,
99.2 / 54.5, 107.7 / 65.8 µs on rows 7, 9 and 10 there).

## 4. pgrust ÷ PGlite, and the difference, per variant

Warm medians (`tables.md`, "Warm medians" and "The gap"):

| row | baseline | A | A2 | B unnamed | B named |
| --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 36.6 / 20.5 (1.79×) | 55.4 / 33.0 (1.68×) | 28.1 / 15.3 (1.83×) | 70.1 / 31.7 (2.21×) | 27.9 / 12.8 (2.19×) |
| 7: 5000 SELECTs with an index | 139.7 / 79.8 (1.75×) | - / 74.0 | 56.1 / 42.0 (1.34×) | 195.9 / 110.2 (1.78×) | 54.4 / 35.7 (1.52×) |
| 9: 25000 UPDATEs with an index | 103.5 / 57.4 (1.80×) | - / 182.7 | 44.7 / 32.2 (1.39×) | 146.7 / 76.7 (1.91×) | 50.1 / 29.7 (1.68×) |
| 10: 25000 text UPDATEs with an index | 119.1 / 68.3 (1.74×) | - / 431.6 | 57.6 / 39.6 (1.45×) | 163.2 / 89.2 (1.83×) | 60.5 / 38.0 (1.59×) |

pgrust − PGlite, µs per statement:

| row | baseline | A2 | B unnamed | B named |
| --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 16.1 | 12.8 | 38.4 | 15.1 |
| 7: 5000 SELECTs with an index | 59.9 | 14.1 | 85.8 | 18.7 |
| 9: 25000 UPDATEs with an index | 46.1 | 12.5 | 70.0 | 20.4 |
| 10: 25000 text UPDATEs with an index | 50.8 | 18.0 | 74.0 | 22.5 |

- **On the index rows a prepared shape narrows the multiple**: A2 to 1.34–1.45×, B named to
  1.52–1.68×, from 1.74–1.80×; the difference falls by 65–76% with A2 and 56–69% with B named.
- **Row 1 does not narrow.** Its warm text is 28–37 ms of which the `CREATE TABLE` and the commit are
  a fixed part (bite 3, §9: 3.05 ms a text in pgrust, 1.15 in PGlite), and the 1 000 INSERTs have no
  index to plan for; both engines save 5–9 µs a statement with A2 or B named, and the multiple stays at
  1.79–2.19×.
- **Cold** the ratios follow warm on rows 7, 9 and 10 (A2 1.35–1.65×, B named 1.51–1.74×); row 1's
  cold multiple is warm-up, as bite 3 found (§8 there), and a prepared shape does not change it.

## 5. What each variant saves over the literal row

Warm medians, µs per statement saved (share of the literal row's), negative where the variant is
slower (`tables.md`, "Saving over baseline"):

| row | engine | A | A2 | B unnamed | B named |
| --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | pgrust | −18.8 (−51%) | 8.5 (23%) | −33.5 (−92%) | 8.7 (24%) |
| 1: 1000 INSERTs | PGlite | −12.5 (−61%) | 5.2 (25%) | −11.2 (−55%) | 7.7 (38%) |
| 7: 5000 SELECTs with an index | pgrust | - | 83.7 (60%) | −56.2 (−40%) | 85.3 (61%) |
| 7: 5000 SELECTs with an index | PGlite | 5.9 (7%) | 37.9 (47%) | −30.3 (−38%) | 44.1 (55%) |
| 9: 25000 UPDATEs with an index | pgrust | - | 58.8 (57%) | −43.2 (−42%) | 53.4 (52%) |
| 9: 25000 UPDATEs with an index | PGlite | −125.3 (−218%) | 25.2 (44%) | −19.3 (−34%) | 27.6 (48%) |
| 10: 25000 text UPDATEs with an index | pgrust | - | 61.5 (52%) | −44.1 (−37%) | 58.7 (49%) |
| 10: 25000 text UPDATEs with an index | PGlite | −363.2 (−532%) | 28.7 (42%) | −20.8 (−30%) | 30.4 (44%) |

- **A prepared shape saves pgrust about twice what it saves PGlite** on rows 7, 9 and 10: 2.1–2.3×
  with A2 (83.7 against 37.9, 58.8 against 25.2, 61.5 against 28.7 µs) and 1.9× with B named,
  because what it removes, planning and parse analysis, is where pgrust was slowest.
- **The unnamed extended protocol is the slowest variant** in both engines: per statement it still
  parses, analyses and plans (a new unnamed statement's first plan is always custom), and it adds
  three protocol messages to each.
- **B named against A2**: PGlite does better on the wire (1.6–6.3 µs a statement under A2 on rows 7,
  9, 10); pgrust does better with SQL (A2 is 5.4 and 2.9 µs under B named on rows 9 and 10, and
  within 1.7 µs on rows 1 and 7). §6 says why.

## 6. Where the saving comes from: rows 7 and 9, profiled

One profiled process per engine and variant (baseline, A2, B named), the two warm windows of rows 7
and 9 merged (`three.md`, from `prof/*-warm-slices.json`; phases from `deltas-A2.md` and
`deltas-Bn.md`). µs per statement, pgrust / PGlite:

**Row 7** (5 000 SELECTs):

| bucket | baseline | A2 | B named |
| --- | --- | --- | --- |
| parser | 2.2 / 2.1 | 0.6 / 0.6 | 0.0 / 0.0 |
| analyzer/rewriter | 9.5 / 5.2 | 0.7 / 0.7 | 0.0 / 0.0 |
| planner | 36.3 / 9.8 | 0.0 / 0.1 | 0.0 / 0.1 |
| executor | 15.7 / 5.2 | 11.6 / 4.4 | 11.5 / 4.6 |
| access/heap | 2.7 / 2.1 | 2.1 / 1.7 | 2.0 / 1.8 |
| access/index | 4.5 / 1.8 | 2.2 / 1.3 | 3.1 / 1.4 |
| storage/buffer | 2.4 / 0.8 | 1.5 / 0.9 | 1.9 / 0.8 |
| storage/other | 1.8 / 1.4 | 1.1 / 1.3 | 0.7 / 1.9 |
| transam/WAL | 0.1 / 0.1 | 0.1 / 0.0 | 0.0 / 0.0 |
| catalog/syscache | 12.1 / 5.0 | 2.8 / 1.7 | 2.5 / 1.4 |
| tcop/portal/dest | 6.0 / 1.4 | 5.4 / 2.4 | 5.8 / 1.9 |
| nodes | 5.6 / 9.5 | 0.9 / 2.2 | 0.7 / 1.5 |
| fmgr/adt | 4.1 / 3.1 | 1.7 / 1.2 | 2.1 / 1.6 |
| commands | 0.1 / 0.1 | 0.8 / 0.3 | 0.2 / 0.1 |
| utils/misc | 7.0 / 3.9 | 2.6 / 3.2 | 2.6 / 2.2 |
| memory contexts | 8.2 / 12.9 | 3.7 / 3.7 | 3.0 / 2.2 |
| allocator | 1.8 / 0.3 | 0.9 / 0.8 | 1.3 / 0.3 |
| memcpy/memmove/memset/memcmp/str* | 0.0 / 1.0 | 0.0 / 0.7 | 0.0 / 0.5 |
| Rust generics | 2.6 / 0.0 | 2.2 / 0.0 | 2.0 / 0.0 |
| thread-local | 0.2 / 0.0 | 0.3 / 0.0 | 0.2 / 0.0 |
| unwind / setjmp-longjmp trampolines | 0.0 / 0.8 | 0.0 / 0.6 | 0.0 / 0.5 |
| store: #call | 0.5 / 0.0 | 0.8 / 0.0 | 0.4 / 0.0 |
| store: other JS | 0.2 / 0.8 | 0.2 / 0.6 | 0.1 / 1.0 |
| message I/O JS | 1.0 / 0.0 | 0.9 / 0.0 | 3.4 / 0.0 |
| JS <-> wasm transitions | 0.0 / 0.8 | 0.1 / 0.8 | 0.0 / 1.0 |
| client (pgrust idle in pq_getbyte + PGlite protocol JS) | 12.2 / 11.0 | 12.4 / 11.7 | 10.0 / 10.3 |
| everything else (V8, guest waits, other) | 2.7 / 0.8 | 0.7 / 1.0 | 0.9 / 0.7 |
| **total** | **139.7 / 79.8** | **56.1 / 42.0** | **54.4 / 35.7** |
| ratio | 1.75× | 1.34× | 1.52× |

**Row 9** (25 000 UPDATEs):

| bucket | baseline | A2 | B named |
| --- | --- | --- | --- |
| parser | 1.0 / 1.0 | 0.6 / 0.7 | 0.0 / 0.0 |
| analyzer/rewriter | 6.0 / 2.5 | 0.5 / 0.4 | 0.0 / 0.1 |
| planner | 26.2 / 7.5 | 0.1 / 0.0 | 0.0 / 0.0 |
| executor | 14.6 / 5.0 | 9.7 / 3.8 | 9.9 / 3.5 |
| access/heap | 4.6 / 2.7 | 2.8 / 1.6 | 2.7 / 1.8 |
| access/index | 8.7 / 4.5 | 6.0 / 3.7 | 6.3 / 3.5 |
| storage/buffer | 3.5 / 2.1 | 2.8 / 1.5 | 3.0 / 1.6 |
| storage/other | 2.5 / 2.0 | 1.8 / 1.3 | 1.6 / 1.4 |
| transam/WAL | 2.8 / 1.5 | 1.8 / 1.5 | 2.1 / 1.3 |
| catalog/syscache | 6.3 / 2.9 | 1.5 / 1.1 | 2.0 / 0.9 |
| tcop/portal/dest | 3.9 / 1.4 | 3.4 / 1.5 | 4.8 / 1.5 |
| nodes | 3.7 / 5.2 | 0.6 / 1.2 | 0.3 / 0.6 |
| fmgr/adt | 0.1 / 1.1 | 0.1 / 0.4 | 0.3 / 0.6 |
| commands | 0.2 / 0.1 | 0.7 / 0.2 | 0.1 / 0.1 |
| utils/misc | 5.2 / 3.8 | 2.0 / 2.7 | 2.6 / 2.6 |
| memory contexts | 3.8 / 5.4 | 1.5 / 2.6 | 1.8 / 2.2 |
| allocator | 1.1 / 0.3 | 0.9 / 0.2 | 0.9 / 0.1 |
| memcpy/memmove/memset/memcmp/str* | 0.0 / 1.0 | 0.0 / 0.8 | 0.0 / 0.5 |
| Rust generics | 2.2 / 0.0 | 1.8 / 0.0 | 1.7 / 0.0 |
| thread-local | 0.1 / 0.0 | 0.1 / 0.0 | 0.2 / 0.0 |
| unwind / setjmp-longjmp trampolines | 0.0 / 0.4 | 0.0 / 0.3 | 0.0 / 0.2 |
| store: #call | 2.4 / 0.0 | 2.8 / 0.0 | 2.4 / 0.0 |
| store: other JS | 0.5 / 2.5 | 0.4 / 2.8 | 0.4 / 2.7 |
| message I/O JS | 0.3 / 0.0 | 0.2 / 0.0 | 3.4 / 0.0 |
| JS <-> wasm transitions | 0.0 / 0.9 | 0.0 / 0.6 | 0.3 / 0.7 |
| client (pgrust idle in pq_getbyte + PGlite protocol JS) | 2.4 / 2.7 | 2.2 / 2.5 | 2.5 / 2.9 |
| everything else (V8, guest waits, other) | 1.4 / 0.9 | 0.4 / 0.7 | 0.7 / 1.0 |
| **total** | **103.5 / 57.4** | **44.7 / 32.2** | **50.1 / 29.7** |
| ratio | 1.80× | 1.39× | 1.68× |

Phases, inclusive µs per statement (`deltas-A2.md`, `deltas-Bn.md`), baseline / A2 / B named:

| phase | row 7 pgrust | row 7 PGlite | row 9 pgrust | row 9 PGlite |
| --- | --- | --- | --- | --- |
| analyze (transformStmt) | 15.3 / 0.0 / 0.1 | 16.5 / 0.0 / - | 7.4 / 0.1 / - | 4.2 / 0.1 / - |
| planning (pgrust pg_plan_query; C planner) | 55.9 / - / - | 22.8 / - / - | 38.2 / - / - | 17.5 / - / - |
| GetCachedPlan (a generic plan's lookup) | - / 0.9 / 0.5 | - / 0.5 / 0.4 | - / 0.6 / 0.6 | - / 0.4 / 0.3 |
| ExecutorStart (standard) | 20.3 / 12.5 / 14.2 | 7.2 / 6.9 / 7.2 | 10.9 / 7.2 / 8.0 | 4.1 / 3.3 / 3.3 |
| ExecutorRun (standard) | 18.9 / 10.9 / 13.1 | 18.4 / 10.3 / 12.7 | 29.2 / 21.9 / 22.7 | 19.4 / 16.9 / 15.9 |
| ExecutorEnd (standard) | 3.7 / 2.4 / 2.5 | 1.3 / 1.1 / 1.0 | 4.5 / 2.8 / 3.0 | 1.8 / 1.4 / 1.1 |
| PortalDrop | 5.7 / 4.6 / 4.3 | 2.1 / 2.0 / 1.5 | 1.0 / 1.3 / 0.9 | 0.4 / 0.6 / 0.4 |

- **The planner collapses**, as expected: 36.3 and 26.2 µs a statement in pgrust, 9.8 and 7.5 in
  PGlite, to at most 0.1 in every prepared Run. Looking the generic plan up (`GetCachedPlan`,
  revalidation included) costs 0.5–0.9 µs in pgrust and 0.3–0.5 in PGlite. Parse analysis goes with
  it (the EXECUTE's own analysis in A2 is 0.5–0.7 µs), and so does most of the catalog cache work:
  12.1 → 2.5–2.8 µs on row 7 and 6.3 → 1.5–2.0 on row 9 in pgrust, 5.0 → 1.4–1.7 and 2.9 → 0.9–1.1
  in PGlite, so the catalog gap falls from +7.2 and +3.4 to +0.5 to +1.2 µs. The node walkers and memory
  contexts fall in both engines too (row 7: nodes 5.6 → 0.7–0.9 in pgrust, 9.5 → 1.5–2.2 in PGlite).
- **The executor shrinks and stays the largest gap.** pgrust's executor bucket falls 15.7 → 11.5–11.6
  (row 7) and 14.6 → 9.7–9.9 (row 9), PGlite's 5.2 → 4.4–4.6 and 5.0 → 3.5–3.8, so the executor
  difference goes from +10.4 and +9.6 to +5.9 to +7.2 µs. ExecutorStart is still 1.8–2.4× PGlite's
  (12.5–14.2 against 6.9–7.2 on row 7, 7.2–8.0 against 3.3 on row 9) and ExecutorEnd 2.0–2.7×. A
  generic plan still builds and tears down the executor state every execution in both engines:
  pgrust's two reuse paths that C lacks, the executor skeleton
  (`crates/backend/executor/execmain/src/execmain.rs:75`) and portal retention
  (`crates/backend/utils/mmgr/portalmem/src/lib.rs:797`), take only SELECTs over
  Result/Limit/SeqScan/IndexScan/IndexOnlyScan trees (`skeleton_parkable`, `execmain.rs:203`), and
  these rows run an Aggregate or an Update over a Bitmap Heap Scan in both engines, literal or
  generic (`explain.log`).
- **ExecutorRun falls on row 7 in both engines by the same amount** (pgrust 18.9 → 10.9–13.1, PGlite
  18.4 → 10.3–12.7). The plans are the same shape; bite 3 (§5 there) found PGlite's protocol JS inside
  ExecutorRun on this row; why pgrust's falls as well was not looked at.
- **What B named adds in pgrust is per message.** Against A2, B named's row 9 carries +3.2 µs of
  message I/O JS and +1.4 of the portal code, and saves the EXECUTE's parse (0.6) and analysis (0.5)
  and the utility dispatch (commands, 0.6). The message I/O is the WASI clock: `clock_time_get` and
  the `DataView` it creates on every call (`src/vendor/pgrust/pgrust-wasi.js:252` and `:360`, the
  vendored pgrust host, byte-identical to `public/pgrust/host/pgrust-wasi.js`) are
  5.8% of the backend's row 9 windows, about 2.9 µs a statement, called from `dispatch_message` (the
  statement timestamp, 34%), `check_log_duration` in Bind and Execute (41%) and
  `pgstat_report_activity` (24%) (`callers-clock-Bn.log`). The first and third are C's own
  per-message clock reads. The second is not: pgrust's `check_log_duration`
  (`crates/backend/tcop/postgres/src/simple_query.rs:806`) reads the clock (`:814`) and only then
  tests whether any duration logging is on, where C tests first
  (`src/backend/tcop/postgres.c:2426` in the PostgreSQL 18.6 reference tree under the pgrust checkout,
  `crates/postgres-18.6-reference/`; the same test at `:2532` in PGlite's `postgres-pglite`) and
  reads the clock only if one is; with every duration log
  off here, that is about 1.2 µs a statement pgrust spends and C does not. A multi-statement text pays
  these once per message, so A2 does not see them.
- **What is left on row 9 with A2** (+12.5 µs): the executor +5.9, the B-tree +2.3, the portal code
  +1.8, Rust's generic code +1.8, buffers +1.3, the heap +1.1, the store and WAL +0.7 together, the
  largest of the positive parts. On row 7 (+14.1): the executor +7.2, the portal code +2.9, Rust's
  generic code +2.2, the catalog caches +1.1, the B-tree +0.9.

## 7. The plan cache

Both engines decide custom against generic with C's rule. pgrust's `choose_custom_plan`
(`crates/backend/utils/cache/plancache/src/lib.rs:1401`) is PostgreSQL 18's
(`src/backend/utils/cache/plancache.c:1166` in the 18.6 reference tree) test for test: no parameters or nothing to revalidate means generic;
`plan_cache_mode` and the cursor options next; custom until five custom plans have been made
(`num_custom_plans < 5`); then generic when the generic plan's cost is under the average custom cost,
and generic while that cost is not yet known. C's first test, one-shot plans are always custom, has no
counterpart in the port's function. `GetCachedPlan` (`lib.rs:806`) follows C's: on the first generic
choice it builds the generic plan, records its cost and chooses again.

Measured directly (`driver.ts --mode plancache`, two processes per engine, 30 repetitions each): after
the Suite's rows 1 to 6, one statement per round trip inside a transaction, 100 executions per
repetition, each timed on its own, the three modes interleaved. Microseconds per execution, round trip
included, the median over the 60 repetitions per index, then over the indices in each column
(`tables.md`, "The plan cache"):

| engine | shape | mode | #1 | #2–#5 | #6 | #7–#100 | #2–#5 minus #7–#100 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pgrust | row 1 INSERT | literal (simple Query) | 216.7 | 122.2 | 109.4 | 113.3 | 8.9 |
| pgrust | row 1 INSERT | EXECUTE (simple Query) | 188.6 | 144.3 | 153.5 | 102.5 | 41.7 |
| pgrust | row 1 INSERT | named Bind/Execute | 205.4 | 125.7 | 130.3 | 79.4 | 46.4 |
| pgrust | row 7 SELECT | literal | 511.0 | 278.7 | 258.3 | 257.2 | 21.5 |
| pgrust | row 7 SELECT | EXECUTE | 331.8 | 261.4 | 263.0 | 154.2 | 107.3 |
| pgrust | row 7 SELECT | named Bind/Execute | 387.9 | 240.4 | 235.1 | 131.5 | 108.9 |
| pgrust | row 9 UPDATE | literal | 386.6 | 213.0 | 207.3 | 209.1 | 3.8 |
| pgrust | row 9 UPDATE | EXECUTE | 298.8 | 223.7 | 225.3 | 144.1 | 79.6 |
| pgrust | row 9 UPDATE | named Bind/Execute | 368.2 | 215.8 | 216.0 | 128.7 | 87.1 |
| PGlite | row 1 INSERT | literal | 101.6 | 53.4 | 50.1 | 49.8 | 3.6 |
| PGlite | row 1 INSERT | EXECUTE | 93.4 | 61.6 | 65.1 | 39.6 | 22.0 |
| PGlite | row 1 INSERT | named Bind/Execute | 94.5 | 46.9 | 49.1 | 29.8 | 17.1 |
| PGlite | row 7 SELECT | literal | 285.6 | 156.5 | 148.5 | 149.3 | 7.1 |
| PGlite | row 7 SELECT | EXECUTE | 202.6 | 144.9 | 142.1 | 75.9 | 69.0 |
| PGlite | row 7 SELECT | named Bind/Execute | 193.1 | 118.3 | 119.9 | 58.0 | 60.3 |
| PGlite | row 9 UPDATE | literal | 208.8 | 118.0 | 112.8 | 112.4 | 5.6 |
| PGlite | row 9 UPDATE | EXECUTE | 170.4 | 121.0 | 122.3 | 68.5 | 52.5 |
| PGlite | row 9 UPDATE | named Bind/Execute | 176.4 | 109.2 | 107.1 | 57.5 | 51.7 |

`pg_prepared_statements` after 1, 5, 6, 7 and 100 executions reads 0 generic / 1 custom, 0 / 5,
1 / 5, 2 / 5 and 95 / 5 for every shape and mode in both engines and both processes.

- **The step is at the seventh execution, not the sixth**, in both engines: the sixth chooses generic
  (the cost is not yet known), builds the generic plan and runs it, so it is counted generic and costs
  what a custom execution costs (per index, row 9 on the wire: 216.0 µs at #6 in pgrust, 142.4 at #7;
  PGlite 107.1 and 63.4). From the seventh the plan is reused.
- **A generic plan saves pgrust 80–109 µs an execution and PGlite 52–69** on the row 7 and row 9
  shapes, in this lane where each statement is its own round trip; the literal controls do not step
  (3.6–21.5 µs, the first executions of each repetition warming up). Per round trip pgrust costs 1.7–2.7×
  PGlite here, the round trip included: the literal UPDATE is 209.1 µs a round trip against 103.5 µs
  a statement inside a text.

## 8. Two engine behaviours variant A ran into

**A prepared statement's source text is the whole message.** `PrepareQuery` hands the parse state's
source text, the whole query string of the message, to `CreateCachedPlan`
(`src/backend/commands/prepare.c:90`, in the 18.6 reference tree and in PGlite's `postgres-pglite`
alike), and pgrust's port does the same
(`crates/backend/commands/prepare/src/lib.rs:107`). With A's `PREPARE` inside a text of 25 000
statements, that text is the statement's source: `pg_prepared_statements.statement` is 65 578
characters long for a `PREPARE` in a 64 KiB text in both engines (`leak-probe.ts`, `leak-*.log`).

**C copies it on every EXECUTE.** `ExecuteQuery` copies the source into the new portal's context
(`MemoryContextStrdup`, `prepare.c:192`) and frees it with the portal. PGlite's A is 33.0, 74.0, 182.7
and 431.6 µs a statement on rows 1, 7, 9 and 10 against A2's 15.3, 42.0, 32.2 and 39.6; the excess,
17.7, 32.0, 150.5 and 392.0 µs, is proportional to the text (67 794, 137 882, 636 125 and 1 591 577
bytes): 3.8–4.3 bytes a nanosecond, a copy's rate. That is PostgreSQL's behaviour and any client that
prepares inside a large text pays it.

**pgrust copies it and never frees it.** pgrust's `ExecuteQuery` passes the source to
`PortalDefineQuery` without copying (`prepare/src/lib.rs:203`), and `PortalDefineQuery`
(`crates/backend/utils/mmgr/portalmem/src/lib.rs:458`) copies it into the portal manager's top
context, `TopPortalContext`, a session-lifetime context, and `leak()`s the copy (`:479`). C's
`PortalDefineQuery` stores the caller's pointer (`src/backend/utils/mmgr/portalmem.c:296`). The
simple-query path does not go through it (`PortalDefineQuerySharedText`, bite 3 §11); its four callers
are the extended protocol's Bind (`crates/backend/tcop/postgres/src/extended_query.rs:794`),
`EXECUTE`, `DECLARE CURSOR` (`crates/backend/commands/portalcmds/src/lib.rs:107`) and SPI cursors
(`crates/backend/executor/spi/src/cursor.rs:183`). Measured (`leak-probe.ts`, 2 000 statements per path after 50 of warm-up,
`pg_backend_memory_contexts.used_bytes` for `TopPortalContext` before and after):

| path (2 000 statements) | source text | pgrust, bytes kept per statement | PGlite |
| --- | --- | --- | --- |
| `exec("SELECT n")`, the simple protocol | 11 | 0.1 | 0.0 |
| `query("SELECT $1::int", [n])`, PGlite's own query(), unnamed Parse/Bind/Execute | 14 | 16.1 | 0.0 |
| Bind/Execute on a named `SELECT $1::int` | 14 | 0.1 | 0.0 |
| Bind/Execute on a named `SELECT count(*) FROM pg_class WHERE oid = $1` | 44 | 64.1 | 0.0 |
| `EXECUTE s(n)`, `PREPARE s(int) AS SELECT $1` sent alone | 27 | 32.1 | 0.0 |
| `EXECUTE l(n)`, `PREPARE l` inside a 64 KiB text | 65 578 | 65 578.1 | 0.0 |

The named `SELECT $1::int` keeps nothing, which fits pgrust's portal retention: its generic plan is
a Result node, which retention parks and rebinds without defining the portal again (§6,
`extended_query.rs:775`). The aggregate is not parkable and keeps its text and its name on every
Bind. So in a pgrust session every `query()` and
every `EXECUTE` keeps its statement text until the session ends. On A's rows it is fatal: in
`pgrust-A-full` (A on all four rows, round 1) the backend stopped 2 615 statements into row 9 with
`memory allocation of 636125 bytes failed` after dumping its contexts, `TopPortalContext: 2420679067
total in 8616 blocks`, one block per EXECUTE so far: 1 000 of row 1's text, 5 000 of row 7's, 2 615 of
row 9's (`results/node-pgrust-A-full.server.log`); the client then waited on a backend that was gone
until the driver's 300 s watchdog. In the first three-round attempt at rows 1 and 7, after round 1 had
kept 0.76 GB, round 2's first text failed with `could not extend file "base/5/16403_fsm": I/O error`
(`results/pgrust-A-rounds3-eio.server.log`); that the two are connected is an inference this note did
not test. [Finding 0001](../findings/0001-pgrust-multi-statement-memory.md) was the same shape on the
simple-query path (a per-statement copy of the text into a context that lives as long as the message);
this one lives as long as the session.

## 9. The browser: the disk-lane columns in Chromium

A2 was the fastest variant for pgrust (§3), and a text variant needs nothing the page does not already
have, so the check drives the built page's own Engine workers (`dist/`) directly, as
`tmp/agents/adopt/show.ts` does: `pgrust-postmaster.worker-*.js` with
`pgrust-postmaster-opfs-repacked-relaxed`'s open options and `pglite.worker-*.js` with
`pglite-opfs-repacked-relaxed`'s, each worker a fresh engine on an emptied OPFS directory, in the
bench's persistent context (a disk-backed profile). `measure` is the page's own timed call
(`performance.now()` around the Engine call, in the worker); A2's two texts are two `measure`s, summed.
Same rounds as the node lane, baseline and A2, two passes (`browser.ts`, `browser-tables.md`).
B named was not run in the browser: the page's workers speak only the simple protocol, so it needs a
worker bundle of its own, and A2 was the variant to confirm.

| row | variant | pgrust Postmaster OPFS warm (4 values) | median | cold | PGlite OPFS warm (4 values) | median | cold | pgrust ÷ PGlite warm | cold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | baseline | 29.9 / 32.6 / 39.2 / 32.5 | 32.6 | 270.7 / 250.1 | 32.0 / 34.7 / 51.4 / 40.3 | 37.5 | 72.4 / 71.1 | 0.87× | 3.63× |
| 1: 1000 INSERTs | A2 | 21.1 / 22.4 / 33.6 / 23.7 | 23.1 | 226.8 / 248.4 | 28.3 / 32.9 / 30.0 / 28.5 | 29.3 | 44.0 / 50.4 | 0.79× | 5.03× |
| 7: 5000 SELECTs with an index | baseline | 136.3 / 124.2 / 131.4 / 144.0 | 133.8 | 184.6 / 186.4 | 88.2 / 93.8 / 92.5 / 87.9 | 90.4 | 105.2 / 108.5 | 1.48× | 1.74× |
| 7: 5000 SELECTs with an index | A2 | 46.9 / 48.9 / 57.7 / 55.8 | 52.4 | 68.2 / 94.5 | 44.0 / 42.6 / 45.8 / 46.3 | 44.9 | 47.1 / 60.8 | 1.17× | 1.51× |
| 9: 25000 UPDATEs with an index | baseline | 104.0 / 102.5 / 106.8 / 112.7 | 105.4 | 107.2 / 109.7 | 69.7 / 69.2 / 69.5 / 70.7 | 69.6 | 66.3 / 67.2 | 1.51× | 1.63× |
| 9: 25000 UPDATEs with an index | A2 | 43.9 / 43.6 / 49.1 / 48.0 | 46.0 | 47.6 / 51.3 | 42.5 / 40.9 / 41.9 / 42.9 | 42.2 | 37.6 / 40.4 | 1.09× | 1.27× |
| 10: 25000 text UPDATEs with an index | baseline | 123.5 / 123.6 / 122.4 / 133.1 | 123.6 | 121.3 / 123.3 | 80.4 / 81.7 / 77.8 / 78.4 | 79.4 | 80.5 / 83.8 | 1.56× | 1.49× |
| 10: 25000 text UPDATEs with an index | A2 | 56.0 / 54.5 / 60.4 / 60.6 | 58.2 | 56.4 / 61.9 | 48.1 / 46.5 / 48.5 / 49.8 | 48.3 | 47.5 / 53.0 | 1.20× | 1.18× |

| row | pgrust saved by A2 | PGlite OPFS saved by A2 | pgrust − PGlite, baseline | pgrust − PGlite, A2 |
| --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 9.5 (29%) | 8.3 (22%) | −4.9 | −6.2 |
| 7: 5000 SELECTs with an index | 81.4 (61%) | 45.5 (50%) | 43.5 | 7.5 |
| 9: 25000 UPDATEs with an index | 59.4 (56%) | 27.4 (39%) | 35.8 | 3.7 |
| 10: 25000 text UPDATEs with an index | 65.4 (53%) | 31.1 (39%) | 44.2 | 9.9 |

- **The node lane's finding holds in Chromium on disk**: A2 saves pgrust 53–61% a statement on rows
  7, 9 and 10 and PGlite OPFS 39–50%, and pgrust's multiple falls from 1.48–1.56× to 1.09–1.20×.
- **It narrows further here than in node** because PGlite OPFS keeps costs a prepared shape does not
  touch: its A2 row 9 is 42.2 µs a statement here against 32.2 in memory under node, where pgrust's is
  46.0 against 44.7.
- **Warm row 1 is faster on pgrust than on PGlite OPFS** in this lane (0.87×, A2 0.79×): a 23–38 ms
  text whose `CREATE TABLE` and commit reach each engine's store; cold it is 3.6–5.0×, the warm-up
  bite 3 described.

## Verdict

| question | answer | evidence |
| --- | --- | --- |
| What does a prepared shape buy pgrust per statement? | On the index rows, 53–85 µs of 104–140, about half: the planner (26–36 µs), parse analysis (6–10) and most of the catalog cache work (4–10) go, and the executor sheds 4–5 (rows 7 and 9, profiled). On row 1, 8.5 µs of 37. | §3, §5, §6 |
| And PGlite? | 25–44 µs of 57–80 on the index rows (42–55%); 5–8 of 20.5 on row 1. | §5 |
| Does the gap narrow? | Yes, on rows 7, 9 and 10: 1.74–1.80× to 1.34–1.45× with A2 and 1.52–1.68× with B named in node; 1.48–1.56× to 1.09–1.20× in Chromium on disk with A2. Per statement the difference falls from 46–60 µs to 12.5–18 in node and from 36–44 µs to 4–10 on disk. Row 1's does not. | §4, §9 |
| What stays? | Executor setup and teardown (ExecutorStart 1.8–2.4× PGlite's), the B-tree, the portal code and Rust's generic code: +12.5 µs a statement on row 9, +14.1 on row 7. | §6 |
| SQL-level or wire-level? | For PGlite the named wire statement is fastest. For pgrust the SQL-level `EXECUTE` in one text is as fast or faster, because each wire message pays host clock reads through the WASI shim, one of which (`check_log_duration`) C does not make. Either is far better than the unnamed extended protocol, which is slower than literal SQL in both engines. | §5, §6 |
| When does the generic plan start? | The sixth execution builds it, the seventh reuses it, in both engines, by C's rule. | §7 |

**For a client that prepares its shapes**, on these rows pgrust closes most of the distance to PGlite
that bite 3 measured: the planner, the largest single part, is paid once per shape instead of once per
statement, in both engines, and pgrust gains twice what PGlite gains because that is where it was
slowest. The rest, about 12–18 µs a statement in node and 4–10 on disk, is executor setup and
teardown and the index and heap work, which a prepared shape does not remove in either engine. How a
client prepares matters: PGlite's own `query(sql, params)`, the unnamed statement, re-plans every call
and is the slowest variant here; a named statement (or one `PREPARE` and `EXECUTE`s) is what pays;
`PREPARE` inside the same large text as its `EXECUTE`s is a trap in PostgreSQL itself; and on pgrust
every `EXECUTE` and every Bind that re-defines a portal keeps its statement text for the life of the
session (§8), which a client that runs long sessions on pgrust would hit whichever way it prepares,
since `query()` does it too.

## 10. What this does not show

- **pgxsinkit's own statements.** The shapes here are the Speedtest's single-row statements; the
  applier sends multi-row INSERTs through `query()` (pgxsinkit `packages/client/src/sync/apply.ts:181`), whose
  per-statement cost is spread over their rows. No pgxsinkit workload was run.
- **B named in the browser**, and the browser's cost of the extra messages: the page's workers speak
  only the simple protocol (§9).
- **The client's cost of building the statements.** The B batches were built before the clock at
  9.5–15.0 µs a statement with PGlite's serializer (`tables.md`, "B batches"); a real client pays that
  (or its own) on every statement, in both engines alike.
- **Why ExecutorStart and ExecutorEnd are still about twice PGlite's** with the planner gone. The
  profile says where (§6), not why.
- **Why ExecutorRun falls on row 7** with a prepared shape, in both engines (§6).
- **The `I/O error` after pgrust kept 0.76 GB** (§8): recorded, not reproduced or traced.
- **pgrust's A beyond one round** on rows 7, 9 and 10: its warm figures are row 1's only (§3, §8).
- **Other browsers**, and the OPFS store under the B variants.

## Reproduction

In this repo, from the root. Scratch under `tmp/agents/prepared/`; it reuses bite 1's
`tmp/agents/anchors/` (`node-ts-hooks.ts`, `load.ts`, `suite.ts`, the Arm) and bite 3's
`tmp/agents/profile3/` (`slice3.ts`, `buckets.ts`, `crate-map.tsv`, `pglite-symbols.tsv`, the named
PGlite).

```
bun tmp/agents/prepared/make-sql.ts                  # sql/: baseline, A, A2 texts and the B specs

# the lanes (each Run its own node process behind the load gate; modules and dist/ sha-verified)
bun tmp/agents/prepared/lanes.ts --set rows          # 5 variants x 2 engines x 2 passes, rows mode
bun tmp/agents/prepared/lanes.ts --set plancache     # the per-execution probe, 2 processes per engine
bun tmp/agents/prepared/lanes.ts --set crashA        # pgrust's A on all four rows, round 1 (stops on row 9)
bun tmp/agents/prepared/lanes.ts --set prof          # Arm and named PGlite, baseline, A2, B named, --cpu-prof

# untimed probes
node --import ./tmp/agents/anchors/node-ts-hooks.ts tmp/agents/prepared/leak-probe.ts --engine pgrust   # and pglite
node --import ./tmp/agents/anchors/node-ts-hooks.ts tmp/agents/prepared/explain.ts --engine pgrust      # and pglite

# the browser check (built page in dist/, persistent context)
bun tmp/agents/prepared/browser.ts --variants baseline,A2 --passes 2

# tables
bun tmp/agents/prepared/tables.ts > tmp/agents/prepared/tables.md
bun tmp/agents/prepared/browser-tables.ts > tmp/agents/prepared/browser-tables.md
tmp/agents/prepared/slices.sh
bun tmp/agents/prepared/three.ts > tmp/agents/prepared/three.md
bun tmp/agents/prepared/deltas.ts A2 > tmp/agents/prepared/deltas-A2.md
bun tmp/agents/prepared/deltas.ts Bn > tmp/agents/prepared/deltas-Bn.md
bun tmp/agents/profile3/callers3.ts --runs tmp/agents/prepared/prof/arm-Bn-prof:tmp/agents/prepared/results/node-arm-Bn-prof.json \
  --rows r2-9,r3-9 --leaf '^(clock_time_get|dv)$' --depth 6
```
