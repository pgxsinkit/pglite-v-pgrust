# The Prepared Suite: with its statements prepared, pgrust runs Speedtest rows 7, 9 and 10 at 1.19–1.46× PGlite OPFS, against 1.46–1.66× as literal SQL

- Date: 2026-09-25
- Machine: i7-1165G7 (8 logical cores), 30 GiB, Linux 7.0.0-34-generic, ext4 under `/home`. The
  incus VM `dev101` took 0.8 of a core throughout. From 20:01:55 a script in another session
  (`bun tmp/agents/store-crash/hang2.ts`, not this repo's) took one more core, beside the second
  Prepared Run and all three Speedtest control Runs (§4). Every timed Run waited for a 1-minute load
  under 2.5.
- Browser: headless **Chromium 149.0.7827.55** (Playwright 1.61.1), in the bench's persistent
  context (a fresh profile on disk, OPFS on disk), driven by `bun run bench --no-build`.
- Engines, from the page's own header:
  `@pgxsinkit/pglite 0.5.5-pgx.3 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust 6ed7984bf0 |
  wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available`.
  pgrust `6ed7984bf0` is `3624f82cf0` plus one host-JS commit (§6). The modules are still the ones
  built from `3624f82cf0` (threads `556d0731dd5f…`, single-session `4c010907fe9f…`). They were
  byte-identical after the sync, and were sha-verified in `public/pgrust/` and `dist/pgrust/`, with
  `dist/`'s `pgrust-wasi.js`, before and after every Run.
- Columns: `pglite-memory` (PGL-MEM), `pglite-opfs-repacked-relaxed` (PGL-OPFS, the Baseline of
  the Prepared Runs) and `pgrust-postmaster-opfs-repacked-relaxed` (pgrust), all three in one page
  per Run.
- Drivers: a scratch gate loop (`tmp/agents/prepared-suite/gate.sh`: module check, load gate, one
  `bun run bench` per Run). §3 to §5 and §7 come from `tables.ts`, which reads the Runs' own
  results files in `tmp/agents/prepared-suite/runs/` and the warm-up note's in
  `tmp/agents/warmup/runs/`. §6's node lane comes from `ab/lanes.ts` and `ab/tables.ts` (all
  untracked).

## What this answers

[The prepared-statements note](2026-09-25-prepared-statements.md) measured what a prepared statement
buys each engine per statement: a reused generic plan takes the planner and parse analysis out of
the per-statement path in both engines, and pgrust gains about twice what PGlite gains, because
planning is where it was slowest. Its variant A2, the `PREPARE` sent as a short text of its own and
then the `EXECUTE`s as one text, was the fastest for pgrust. In Chromium on disk it took pgrust from
1.48–1.56× PGlite OPFS to 1.09–1.20× on rows 7, 9 and 10 when warm (§9 there). The owner decided that
the public page should show what a client that prepares its statement shapes gets. This note records
the Suite that does it, the **Prepared Suite**, and its gate. It also records the fix for the host
clock read that the same note found on the wire-protocol path (§6 there).

**Five findings.**

1. **On the page, prepared, pgrust runs rows 7, 9 and 10 at 1.39× / 1.46×, 1.39× / 1.27× and
   1.27× / 1.19× PGlite OPFS** (Runs 1 / 2). The same rows sent as literal SQL, in five Speedtest
   Runs on the same columns, are 1.47–1.62×, 1.53–1.66× and 1.46–1.60× (§3, §5).
2. **Both engines gain on every row, and pgrust gains most on the index rows.** Against the
   Speedtest's literal rows, rows 7, 9 and 10 cost pgrust 58%, 55% and 51% less a statement,
   PGlite OPFS 54%, 45% and 39% less, and PGlite Memory 52%, 46% and 37% less. The INSERT rows (1,
   2, 3) save 7–34 µs a statement in each engine, and the multiple does not narrow there (row 2
   1.39× → 1.43×, row 3 1.42× → 1.49×). Row 8, an UPDATE over a range with no index, so a scan per
   statement, saves 7–10% (§5).
3. **The note's 1.09–1.20× were warm figures, and a Run measures each row once.** A Suite Run
   times each row once, after the Warm-up and the row's own untimed setup. The prepared-statements
   note calls that cold, and its cold A2 in Chromium was 1.51×, 1.27× and 1.18× on rows 7, 9 and 10.
   Its 1.09–1.20× came from the second and third passes through the same engine. The Suite's ratios
   sit with the cold ones, and so does pgrust's row 7: 71.2–72.7 µs a statement here, against the
   note's cold 68.2–94.5 and warm 52.4 (§3). In the
   fourteen-column e2e page, where five columns before it have used the same module, the Postmaster
   OPFS column runs them at 0.93×, 1.14× and 1.11× (§8).
4. **The host clock fix is small and in the expected direction.** pgrust's WASI shim built a new
   `DataView` on every `clock_time_get`, and now builds one per memory buffer. Called from JS, a
   clock read takes 206–226 ns where it took 319–467 ns. In the node lane, named statements, warm,
   three processes per arm, row 7 goes from 54.8 to 51.9 µs a statement and row 9 from 50.0 to 48.5
   (medians). The two arms' ranges overlap (§6).
5. **Nothing else moved beyond what the box did.** The Speedtest control on the same build puts
   pgrust at 1.58×, 1.45× and 1.48× PGlite Memory over its 18 rows, against 1.46× and 1.45× in the
   warm-up note's after Runs. In Runs 2 and 3, which had another session's process on one core, the
   totals are up to 4.3% higher. Run 1 is 10% higher on pgrust and PGlite OPFS (§7).

## 1. The Suite

Seven rows: the Speedtest scripts that repeat one statement. Each row's statement becomes a **shape**:
the Speedtest's statement with its literals replaced by `$1`, `$2` and `$3`, parameter types taken
from the columns the literals stand for. The row's timed text is the script's own statements as
`EXECUTE`s with the Speedtest's own values, in the script's own `BEGIN`/`COMMIT` where it has them:

| Row | `PREPARE`, untimed, its own text | untimed before it | timed text | bytes (the Speedtest's) |
| --- | --- | --- | --- | ---: |
| 1: 1000 INSERTs | `p1(integer, integer, varchar) AS INSERT INTO t1 VALUES($1, $2, $3)` | `CREATE TABLE t1(…)` | 1 000 `EXECUTE`s, no transaction | 67 663 (78 718) |
| 2: 25000 INSERTs in a transaction | `p2(integer, integer, varchar) AS INSERT INTO t2 VALUES($1, $2, $3)` | `CREATE TABLE t2(…)` | `BEGIN`, 25 000, `COMMIT` | 1 739 026 (2 014 081) |
| 3: 25000 INSERTs into an indexed table | `p3(integer, integer, varchar) AS INSERT INTO t3 VALUES($1, $2, $3)` | `CREATE TABLE t3(…)` and `CREATE INDEX i3 ON t3(c)` | `BEGIN`, 25 000, `COMMIT` | 1 739 013 (2 014 094) |
| 7: 5000 SELECTs with an index | `p7(integer, integer) AS SELECT count(*), avg(b) FROM t2 WHERE b>=$1 AND b<$2` | `benchmark6.sql`: `CREATE INDEX i2a ON t2(a)`, `CREATE INDEX i2b ON t2(b)` | `BEGIN`, 5 000, `COMMIT` | 137 796 (307 796) |
| 8: 1000 UPDATEs without an index | `p8(integer, integer) AS UPDATE t1 SET b=b*2 WHERE a>=$1 AND a<$2` | nothing | `BEGIN`, 1 000, `COMMIT` | 23 797 (45 797) |
| 9: 25000 UPDATEs with an index | `p9(integer, integer) AS UPDATE t2 SET b=$1 WHERE a=$2` | nothing | `BEGIN`, 25 000, `COMMIT` | 636 062 (911 062) |
| 10: 25000 text UPDATEs with an index | `p10(varchar, integer) AS UPDATE t2 SET c=$1 WHERE a=$2` | nothing | `BEGIN`, 25 000, `COMMIT` | 1 591 513 (1 841 513) |

After each row, `DEALLOCATE p<N>`, untimed. Row 9 as it is sent:

```sql
-- untimed, one text
PREPARE p9(integer, integer) AS UPDATE t2 SET b=$1 WHERE a=$2;
-- timed, one text (prepared9.sql)
BEGIN;
EXECUTE p9(6669, 1);
EXECUTE p9(58207, 2);
-- ... 25 000 EXECUTEs
COMMIT;
-- untimed, one text
DEALLOCATE p9;
```

- **The texts are generated from the Speedtest's own files.** `tmp/agents/prepared-suite/make-sql.ts`
  reads `benchmark<N>.sql` and turns every line that matches the row's shape into its `EXECUTE`. It
  stops on any other line that is not `BEGIN;`, `COMMIT;` or exactly the row's DDL. The generated
  files are committed beside the Suite as `src/suites/prepared/prepared<N>.sql`, as the Speedtest's
  are. Rows 1, 7, 9 and 10 are byte-identical to the prepared-statements note's A2 execute texts.
  `prepared.test.ts` goes the other way: it turns every `EXECUTE` back into the Speedtest's
  statement, puts the DDL back where the script had it, and checks the result against
  `benchmark<N>.sql` byte for byte. Every Postgres Engine gets the same bytes, and the unlogged
  Configurations get their usual rewrite, which reaches the rows' setup, so rows 1 to 3 create
  UNLOGGED tables there.
- **What moved out of the timed window, and why.** A `PREPARE` needs its table, so the DDL that
  rows 1, 2 and 3 of the Speedtest run inside their timed text runs untimed before the `PREPARE`:
  three `CREATE TABLE`s and row 3's `CREATE INDEX`. The per-statement profile's fit puts the fixed
  part of a row 1 text, its `CREATE TABLE`, its commit and the round trip, at 3.05 ms in pgrust and
  1.15 in PGlite, warm, in node (§9 there): 3 and 1 µs of row 1's per-statement figure here, of which
  only the `CREATE TABLE` moved. Both engines run `wal_level = replica` (`SHOW`,
  node), so creating t2 and t3 outside the INSERTs' transaction changes no WAL-skipping. The
  `PREPARE` goes in a short text of its own, because PostgreSQL keeps a prepared statement's whole
  message as its source text and copies it into every `EXECUTE`'s portal (prepared-statements note
  §8). Unlike A2 there, the `PREPARE` is not inside the timed window.
- **The state at each row mirrors the Speedtest's.** Rows 1 to 3 build and fill t1, t2 and t3 with
  the Speedtest's data. Before row 7, the setup runs row 6's own script: the two indexes on t2, built
  after row 2's 25 000 rows are in, as in the Speedtest, so row 7 plans against the same indexes and
  the same statistics that `CREATE INDEX` leaves. Rows 8, 9 and 10 run on what rows 1 to 7 left.
  Rows 2.1, 3.1, 4, 5 and 11 to 16 are not run: t2_1 and t3_1 (and 3.1's second index on t3) do not
  exist here, and no prepared row reads them.
- **Where it runs.** `StatementBenchmark` gains an optional `setup` and `teardown`: untimed texts
  that `runSuite` sends one by one through `exec`, just before the Benchmark's first Measurement and
  just after its last. The other three Suites carry none, and their Runs are unchanged. The Warm-up
  runs first, as in every Suite. The Suite has no Suite-level setup, one iteration and no editable
  preamble.
- **wa-sqlite.** SQLite has no `PREPARE`/`EXECUTE` in any spelling, so the Suite declares it
  (`Suite.unsupportedReasonFor`). The page skips both wa-sqlite columns without opening them, and
  their headers say `not run: SQLite has no PREPARE or EXECUTE`, in the page and in the export.
  `runSuite` refuses the pair too, for any other caller. This is the one place where a Suite does not
  run on every Engine.
- **On the page** it is the fourth Suite, after the Concurrency Suite, with the usual Start button,
  table, Markdown export and `data-testid`s (`suite-prepared`, `start-prepared`,
  `copy-markdown-prepared`, `markdown-prepared`, `error-prepared`, `engine-stats-prepared`).
  `bun run bench --suite prepared` runs it alone, and `bun run bench` runs all four. Every row label is the Speedtest's with ` (prepared)` after it, so
  every row is still a `| Test` row: `Test 9: 25000 UPDATEs with an index (prepared)`.

## 2. The plan cache

Both engines decide custom against generic with PostgreSQL's rule, as the prepared-statements note
found (§7 there): five custom plans, the generic plan built on the sixth execution, and that plan
reused from the seventh. So each row's first six `EXECUTE`s are planned one by one, as the literal
statements are. The other 994 to 24 994 reuse the generic plan. Not re-measured here.

## 3. The gate: two Runs

`bun run bench --no-build --suite prepared --configurations
pglite-memory,pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed --baseline
pglite-opfs-repacked-relaxed`, twice. Milliseconds, Run 1 / Run 2, with pgrust's ratio to each
PGlite column. No Run failed, and the Warm-up line and its export line are in both:

| Row | PGlite Memory | PGlite OPFS | pgrust Postmaster OPFS | pgrust ÷ PGlite OPFS | pgrust ÷ PGlite Memory |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Warm-up** | 64.5 / 67.9 | 87.2 / 97.6 | 867.4 / 745.0 | 9.95× / 7.64× | 13.45× / 10.97× |
| 1: 1000 INSERTs (prepared) | 26.2 / 32.7 | 35.9 / 39.7 | 85.4 / 81.8 | 2.38× / 2.06× | 3.26× / 2.50× |
| 2: 25000 INSERTs in a transaction (prepared) | 445.3 / 480.6 | 465.9 / 496.8 | 682.6 / 690.5 | 1.46× / 1.39× | 1.53× / 1.44× |
| 3: 25000 INSERTs into an indexed table (prepared) | 496.5 / 513.7 | 595.8 / 633.2 | 939.1 / 896.9 | 1.58× / 1.42× | 1.89× / 1.75× |
| 7: 5000 SELECTs with an index (prepared) | 252.2 / 253.7 | 257.0 / 248.6 | 356.2 / 363.4 | 1.39× / 1.46× | 1.41× / 1.43× |
| 8: 1000 UPDATEs without an index (prepared) | 151.3 / 181.3 | 181.0 / 156.7 | 183.3 / 229.8 | 1.01× / 1.47× | 1.21× / 1.27× |
| 9: 25000 UPDATEs with an index (prepared) | 838.5 / 810.7 | 902.8 / 935.2 | 1 251.5 / 1 184.5 | 1.39× / 1.27× | 1.49× / 1.46× |
| 10: 25000 text UPDATEs with an index (prepared) | 1 163.0 / 1 228.5 | 1 184.5 / 1 277.7 | 1 500.7 / 1 516.0 | 1.27× / 1.19× | 1.29× / 1.23× |
| **Total (the 7 `Test` rows)** | 3 372.9 / 3 501.2 | 3 623.0 / 3 787.8 | 4 998.8 / 4 962.9 | 1.38× / 1.31× | 1.48× / 1.42× |

Microseconds per statement, the row's milliseconds over its statement count:

| Row | statements | PGlite Memory | PGlite OPFS | pgrust | pgrust − PGlite OPFS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 000 | 26.2 / 32.7 | 35.9 / 39.7 | 85.4 / 81.8 | 49.6 / 42.2 |
| 2 | 25 000 | 17.8 / 19.2 | 18.6 / 19.9 | 27.3 / 27.6 | 8.7 / 7.7 |
| 3 | 25 000 | 19.9 / 20.5 | 23.8 / 25.3 | 37.6 / 35.9 | 13.7 / 10.5 |
| 7 | 5 000 | 50.4 / 50.7 | 51.4 / 49.7 | 71.2 / 72.7 | 19.8 / 23.0 |
| 8 | 1 000 | 151.3 / 181.3 | 181.0 / 156.7 | 183.3 / 229.8 | 2.3 / 73.2 |
| 9 | 25 000 | 33.5 / 32.4 | 36.1 / 37.4 | 50.1 / 47.4 | 13.9 / 10.0 |
| 10 | 25 000 | 46.5 / 49.1 | 47.4 / 51.1 | 60.0 / 60.6 | 12.6 / 9.5 |

- **Rows 7, 9 and 10: 1.19–1.46× PGlite OPFS, 1.23–1.49× PGlite Memory.** pgrust spends 9.5–23.0 µs
  a statement more than PGlite OPFS on them.
- **Against the prepared-statements note's Chromium check** (§9 there, A2, the same two disk-lane
  columns). pgrust's row 7, 71.2–72.7 µs a statement, is the note's cold (68.2–94.5), not its warm
  (52.4). Its rows 9 and 10, 47.4–50.1 and 60.0–60.6, are inside the note's cold ranges (47.6–51.3,
  56.4–61.9), which on those rows are close to the warm figures (46.0, 58.2). PGlite OPFS is at or
  below the note's cold figures: 49.7–51.4, 36.1–37.4 and 47.4–51.1 against 47.1–60.8, 37.6–40.4 and
  47.5–53.0. So the Suite's ratios are the note's cold ones, 1.51×, 1.27× and 1.18×. Its warm 1.17×,
  1.09× and 1.20× come from a second pass through a warm engine, which a Run never makes. Row 7 is
  the widest here, as it was cold in the note.
- **Row 1 still pays first use.** It is 2.06–2.38× PGlite OPFS, and the Speedtest's row 1 is
  1.82–3.41× over the five Speedtest Runs of §5 (the warm-up note, §5 and §7).
- **Row 8 is one short row**, 150–230 ms of scans, and its two Runs disagree, at 1.01× and 1.47×.

## 4. Environment and load

Five gated Runs, one at a time; the 1-minute, 5-minute and 15-minute load before → after each
(`gate.log`):

| Run | waited | load before → after (1/5/15) | alongside |
| --- | --- | --- | --- |
| Prepared r1 | 45 s | 2.20 2.63 2.57 → 2.85 2.75 2.61 | not sampled; nothing but the VM at 20:00:55 |
| Prepared r2 | 15 s | 2.29 2.63 2.57 → 2.83 2.74 2.61 | another session's `bun` script from 20:01:55, one core |
| Speedtest r1 | 45 s | 2.27 2.62 2.57 → 3.34 2.88 2.67 | the same script |
| Speedtest r2 | 15 s | 2.42 2.71 2.62 → 3.73 3.00 2.72 | the same script (sampled every 5 s: 94% of a core) |
| Speedtest r3 | 45 s | 2.22 2.70 2.63 → 3.27 2.91 2.71 | the same script, then its next run from 20:06:19 |

The machine's own load before the Runs was higher than in the warm-up note (0.58–2.42 there): the VM
(0.8 of a core throughout) and, from 20:01:55, a script from another session that held one core
(`sampler.log`, from 20:04:07). Each Run raised the 1-minute load by 0.5–1.3 on its own: Chromium
and the postmaster's threads. Before the gate there was one untimed smoke Run of the Suite on four
columns (both PGlite Memory columns, pgrust Postmaster OPFS and wa-sqlite Memory). It was not gated
and is not quoted. It showed the page skipping wa-sqlite with its header note, and the unlogged
column running.

## 5. What preparing buys each engine, against the Speedtest

The same rows as literal SQL: this bite's three Speedtest control Runs (§7) and the warm-up note's
two after Runs on the same three columns, all from `1f3c8db` on, so all with a Warm-up. Milliseconds,
control r1 / r2 / r3 / after r1 / after r2:

| Row | PGlite Memory | PGlite OPFS | pgrust | pgrust ÷ PGlite OPFS |
| --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 44.2 / 47.0 / 39.9 / 41.3 / 39.3 | 46.1 / 53.9 / 44.2 / 46.6 / 64.3 | 157.3 / 129.6 / 112.8 / 103.8 / 117.3 | 1.82–3.41× |
| 2: 25000 INSERTs in a transaction | 655.2 / 651.6 / 645.7 / 622.0 / 608.8 | 683.7 / 708.8 / 657.9 / 619.4 / 655.0 | 933.9 / 915.5 / 924.4 / 895.7 / 876.2 | 1.29–1.45× |
| 3: 25000 INSERTs into an indexed table | 811.2 / 846.7 / 858.2 / 800.2 / 809.9 | 906.0 / 962.5 / 847.8 / 856.0 / 842.5 | 1 333.1 / 1 281.0 / 1 178.0 / 1 213.7 / 1 169.0 | 1.33–1.47× |
| 7: 5000 SELECTs with an index | 523.1 / 511.7 / 543.5 / 571.1 / 520.7 | 703.8 / 552.3 / 550.3 / 533.7 / 558.7 | 1 068.6 / 894.0 / 808.3 / 819.2 / 858.7 | 1.47–1.62× |
| 8: 1000 UPDATEs without an index | 185.5 / 188.3 / 181.0 / 164.8 / 183.8 | 200.9 / 176.8 / 184.7 / 183.5 / 176.7 | 222.8 / 220.3 / 245.9 / 226.3 / 215.4 | 1.11–1.33× |
| 9: 25000 UPDATEs with an index | 1 526.7 / 1 572.5 / 1 515.0 / 1 480.2 / 1 532.4 | 1 849.4 / 1 682.5 / 1 651.2 / 1 652.2 / 1 720.1 | 2 864.4 / 2 685.5 / 2 745.3 / 2 633.0 / 2 637.8 | 1.53–1.66× |
| 10: 25000 text UPDATEs with an index | 1 897.8 / 1 962.2 / 1 875.7 / 1 911.0 / 1 891.8 | 2 189.1 / 2 091.2 / 1 996.9 / 1 960.7 / 2 022.7 | 3 245.0 / 3 057.9 / 3 185.3 / 3 091.2 / 2 998.8 | 1.46–1.60× |

Microseconds per statement, the median of those five literal Runs → the mean of the two Prepared
Runs, and what that saves:

| Row | PGlite Memory | PGlite OPFS | pgrust | pgrust ÷ PGlite OPFS |
| --- | --- | --- | --- | --- |
| 1 | 41.3 → 29.5 (11.8, 29%) | 46.6 → 37.8 (8.8, 19%) | 117.3 → 83.6 (33.6, 29%) | 2.52× → 2.21× |
| 2 | 25.8 → 18.5 (7.3, 28%) | 26.3 → 19.3 (7.1, 27%) | 36.6 → 27.5 (9.2, 25%) | 1.39× → 1.43× |
| 3 | 32.4 → 20.2 (12.2, 38%) | 34.2 → 24.6 (9.7, 28%) | 48.5 → 36.7 (11.8, 24%) | 1.42× → 1.49× |
| 7 | 104.6 → 50.6 (54.0, 52%) | 110.5 → 50.6 (59.9, 54%) | 171.7 → 72.0 (99.8, 58%) | 1.55× → 1.42× |
| 8 | 183.8 → 166.3 (17.5, 10%) | 183.5 → 168.8 (14.7, 8%) | 222.8 → 206.6 (16.2, 7%) | 1.21× → 1.22× |
| 9 | 61.1 → 33.0 (28.1, 46%) | 67.3 → 36.8 (30.5, 45%) | 107.4 → 48.7 (58.7, 55%) | 1.60× → 1.33× |
| 10 | 75.9 → 47.8 (28.1, 37%) | 80.9 → 49.2 (31.7, 39%) | 123.6 → 60.3 (63.3, 51%) | 1.53× → 1.23× |

- **Both engines gain on every row.** On the index rows 7, 9 and 10, pgrust saves 58.7–99.8 µs a
  statement and PGlite OPFS 30.5–59.9: pgrust saves 1.7–2.0× what PGlite OPFS saves. The
  prepared-statements note found the same in node (2.1–2.3× with A2, §5 there), and put the
  difference down to the planner and parse analysis, where pgrust was slowest (§6 there). The
  multiple falls from 1.53–1.60× to 1.23–1.42×.
- **The INSERT rows save both engines about the same, so their multiple does not narrow.** Rows 2
  and 3 save 7.1–12.2 µs a statement in every column: an `INSERT … VALUES` has little to plan. Part
  of rows 1 to 3's saving is the DDL that moved to the untimed setup (§1). Row 1's multiple is
  first use either way.
- **Row 8 saves 7–10%**: each of its UPDATEs scans t1's 1 000 rows for a range of `a` that has no
  index, and that scan is most of the statement in both engines.
- **The literal rows are five Runs over two sessions, and the prepared rows are two.** The first
  control Run is the slowest of the five for pgrust on every row but row 8 (§7), which is why the
  saving is taken from the medians.

## 6. The host clock fix (pgrust `6ed7984bf0`)

The prepared-statements note found `clock_time_get` and a `DataView` behind 5.8% of the backend's
time on its named-statement lane, about 2.9 µs a statement (§6 there). Through the WASI shim, each
clock read allocated a new `DataView` over the memory's buffer. One pgrust commit on
`spike/wasip1-threads`, host JS only, no Rust and no rebuild (`wasm/pgrust-wasi.js`):

```diff
   let memory = null;
   const u8 = () => new Uint8Array(memory.buffer);
-  const dv = () => new DataView(memory.buffer);
+  // (nine lines: why one view per buffer, and why memory.buffer is still read on every call)
+  let dvBuffer = null;
+  let dvView = null;
+  const dv = () => {
+    const buffer = memory.buffer;
+    if (buffer !== dvBuffer) {
+      dvBuffer = buffer;
+      dvView = new DataView(buffer);
+    }
+    return dvView;
+  };
```

`memory.buffer` is still read on every call, as `broker-fs.js`'s adapter reads it, because it is a
new object whenever the memory grows. Under node v26.10.0 (`buffer-identity*.mjs`), that holds for a
private memory, for a shared one grown on the same thread, and for a shared one grown on another
thread: this thread's `memory.buffer` is then a new object of the new length. Between grows it is
the same object. A view kept past a grow is stale: a private buffer is detached, and a shared one
keeps its old length. So the view is rebuilt exactly when the identity changes, and every caller of
`dv()` sees what `new DataView(memory.buffer)` would have given it. `u8()` is unchanged, and so is
`threads-host.js`, which has a `dv()` of its own for its pipe reads and writes.

- **Called from JS** (`clock-micro.mjs`, 2 000 000 monotonic reads on a shared memory, three rounds
  per arm, interleaved): old 318.9 / 465.2 / 466.5 ns a call, new 205.9 / 225.6 / 208.9. After a
  grow on the same thread and after a grow on another thread, both arms write the clock into the new
  region.
- **The node lane** (the prepared-statements note's `driver.ts` with a switch for the source tree
  the engine is opened from, `ab/`). The engine is the bench's own under node: the postmaster, the
  published threads module, `fsync=off`. Variant B named: one Parse of a named statement, then
  Bind/Describe/Execute per statement, one Sync. Three rounds per process, where round 1 is the
  Suite's rows 1 to 10 (cold) and rounds 2 and 3 repeat rows 7 and 9 (warm). Six processes, old,
  new, new, old, old, new, each behind the anchors' load gate. The two trees differ only in
  `src/vendor/pgrust/pgrust-wasi.js` (`894d5e17…` against `b9b33eff…`). µs per statement:

| Row | arm | warm (r2 / r3, per process in Run order) | warm median | cold (per process) | cold median |
| --- | --- | --- | ---: | --- | ---: |
| 7: 5000 SELECTs with an index | old | 53.7 / 56.0; 56.9 / 51.2; 56.0 / 53.2 | 54.8 | 76.5 / 80.7 / 77.0 | 77.0 |
| 7: 5000 SELECTs with an index | new | 51.6 / 52.1; 54.7 / 49.6; 51.7 / 65.1 | 51.9 | 70.9 / 73.6 / 75.5 | 73.6 |
| 9: 25000 UPDATEs with an index | old | 48.2 / 47.7; 50.1 / 49.9; 51.2 / 50.1 | 50.0 | 52.8 / 54.4 / 54.9 | 54.4 |
| 9: 25000 UPDATEs with an index | new | 49.9 / 47.7; 48.3 / 48.7; 54.7 / 48.2 | 48.5 | 48.8 / 51.3 / 53.5 | 51.3 |

  Warm, the medians fall by 2.9 µs (5.3%) on row 7 and by 1.5 µs (3.0%) on row 9, and cold by 3.4
  and 3.1. The arms' warm ranges overlap on both rows (row 9: old 47.7–51.2, new 47.7–54.7), so the
  lane puts the saving at a few µs a statement at most and does not resolve it more finely. All six
  processes end with the same t1 and t2 checksums. The load before each process was 2.25–2.40 and
  after 2.25–2.87 (`ab/tables.md`); the waits were 0–30 s.
- **Against the prepared-statements note:** its B named on `569d16128c` was 54.4 and 50.1 µs warm on
  rows 7 and 9. The old arm here, on `3624f82cf0`, whose `check_log_duration` no longer reads the
  clock (41% of the reads there), is 54.8 and 50.0. That commit's saving does not show at this
  resolution either. The two were measured on different days under different loads, so this is an
  observation, not a comparison.
- **pgrust's own lanes pass on the new shim** (`tmp/agents/clockview/` in the pgrust checkout):
  `postmaster-node PASS fs=broker`, the threads-node tablespace proofs (both `PASS`),
  `tablespace-host-proof PASS`, the host-pipes gate (6 of 6), the browser-profile proof (`PASS`),
  and a single-threaded `--stdio-wire` session on the single-session module.
- **Vendored by `bun run sync:pgrust`** from the checkout. `src/vendor/pgrust/pgrust-wasi.js`,
  `VERSION` and `SOURCE.md` move to `6ed7984bf0`, and so does `public/pgrust/host/pgrust-wasi.js`.
  Every other file in `public/pgrust/` is byte-identical to before the sync (`shas-before.txt`
  against `shas-after-sync.txt`): both modules, `vfs.img`, `vfs.json` and the pre-release store
  bundle. There is no pgxsinkit checkout beside this one, so the sync left the bundle and its
  `SOURCE.md` block alone. `SOURCE.md`'s assets block now names `6ed7984bf0`, whose modules are the
  ones built from `3624f82cf0`: the commit between them changes no Rust.

## 7. The Speedtest control

Three Speedtest Runs on the same build and the same three columns, `--baseline pglite-memory`,
against [the warm-up note](2026-09-25-warm-up-phase.md)'s two after Runs (`1f3c8db`, pgrust
`3624f82cf0`). Milliseconds, control r1 / r2 / r3 | after r1 / r2:

| Row | PGlite Memory | PGlite OPFS | pgrust | pgrust ÷ PGlite Memory |
| --- | --- | --- | --- | --- |
| **Warm-up** | 67.4 / 68.4 / 68.3 \| 62.8 / 71.0 | 94.7 / 122.4 / 93.9 \| 103.7 / 79.5 | 955.3 / 716.9 / 659.6 \| 709.5 / 739.4 | 14.18× / 10.48× / 9.66× \| 11.30× / 10.42× |
| 1: 1000 INSERTs | 44.2 / 47.0 / 39.9 \| 41.3 / 39.3 | 46.1 / 53.9 / 44.2 \| 46.6 / 64.3 | 157.3 / 129.6 / 112.8 \| 103.8 / 117.3 | 3.56× / 2.76× / 2.83× \| 2.52× / 2.99× |
| 4: 100 SELECTs without an index | 350.4 / 387.9 / 390.0 \| 353.9 / 341.8 | 365.5 / 343.0 / 342.1 \| 337.8 / 345.8 | 420.6 / 416.7 / 454.5 \| 357.7 / 365.9 | 1.20× / 1.07× / 1.17× \| 1.01× / 1.07× |
| 7: 5000 SELECTs with an index | 523.1 / 511.7 / 543.5 \| 571.1 / 520.7 | 703.8 / 552.3 / 550.3 \| 533.7 / 558.7 | 1 068.6 / 894.0 / 808.3 \| 819.2 / 858.7 | 2.04× / 1.75× / 1.49× \| 1.43× / 1.65× |
| 9: 25000 UPDATEs with an index | 1 526.7 / 1 572.5 / 1 515.0 \| 1 480.2 / 1 532.4 | 1 849.4 / 1 682.5 / 1 651.2 \| 1 652.2 / 1 720.1 | 2 864.4 / 2 685.5 / 2 745.3 \| 2 633.0 / 2 637.8 | 1.88× / 1.71× / 1.81× \| 1.78× / 1.72× |
| 10: 25000 text UPDATEs with an index | 1 897.8 / 1 962.2 / 1 875.7 \| 1 911.0 / 1 891.8 | 2 189.1 / 2 091.2 / 1 996.9 \| 1 960.7 / 2 022.7 | 3 245.0 / 3 057.9 / 3 185.3 \| 3 091.2 / 2 998.8 | 1.71× / 1.56× / 1.70× \| 1.62× / 1.59× |
| **Total (the 18 `Test` rows)** | 8 109.1 / 8 335.6 / 8 142.7 \| 7 987.1 / 8 004.3 | 9 371.1 / 8 868.5 / 8 421.4 \| 8 406.4 / 8 612.4 | 12 801.6 / 12 114.7 / 12 078.3 \| 11 698.3 / 11 606.7 | 1.58× / 1.45× / 1.48× \| 1.46× / 1.45× |

(All 18 rows are in `tables.md`.)

- **The multiple holds.** Over the 18 rows pgrust is 1.45× and 1.48× PGlite Memory in Runs 2 and 3,
  against 1.46× and 1.45× before. Against the after Runs' mean, Runs 2 and 3 are 1.8–4.3% higher on
  PGlite Memory (8 336 and 8 143 against 7 987 and 8 004 ms), 3.7–4.0% higher on pgrust (12 115 and
  12 078 against 11 698 and 11 607), and −1.0% and +4.2% on PGlite OPFS. That is what a second busy
  core on the box would do. The shim change cannot reach the Speedtest's rows, which each send one
  simple Query.
- **Run 1 is the outlier.** It was the first Run with the other session's script beside it. pgrust
  and PGlite OPFS are 9.9% and 10.1% higher than the after Runs' mean, and PGlite Memory 1.4% higher.
  The rows that move most in pgrust are the first of their kind (Warm-up 955 ms, rows 1, 2.1, 4 and
  7), the rows the warm-up note found paying first use (§6 there). Compiling under contention would
  explain that, and it was not traced.
- **Rows outside the after Runs' range by more than 10%**, on the median of the three control Runs:
  pgrust rows 1, 2.1, 4 and 14, PGlite Memory row 12 and PGlite OPFS row 13, the last two short rows
  of 29–40 ms. None is a row this bite could have changed.

## 8. The e2e lane

`bun run test:e2e` (all fourteen Configurations in one page, the four Suites in page order, RTT at
three iterations, not load-gated) passed 72 of 72 in 359.7 s. The Prepared Suite ran on all twelve
Postgres columns without a failure, and both wa-sqlite columns were `skipped` in every row, with
`not run: SQLite has no PREPARE or EXECUTE` in their headers (`e2e/`). One Run on a box shared as in
§4, so only the shape is claimed. It repeats what the warm-up note's §7 found for the Warm-up: a
pgrust column's rows depend on which columns ran before it in the same page. The Postmaster OPFS
column comes eleventh, after five other columns on the same threads module. It ran rows 7, 9 and 10
in 239.8, 1 086.7 and 1 338.0 ms, 0.93×, 1.14× and 1.11× PGlite OPFS (relaxed) in the same page
(257.1, 956.1, 1 205.2), where the gate's three-column page, in which it is the module's only
column, has 1.19–1.46×. The first threads column, pgrust Threads Memory, had 1.36×, 1.10× and 1.19×.

## Verdict

| question | answer | evidence |
| --- | --- | --- |
| What does the page now show? | A fourth Suite: the Speedtest's statement-heavy rows, each as one untimed `PREPARE` of its shape and one timed text of `EXECUTE`s with the Speedtest's values, on the twelve Postgres columns. | §1 |
| pgrust against PGlite OPFS, prepared? | Rows 7, 9 and 10 at 1.19–1.46×, over the seven rows 1.31–1.38×. | §3 |
| Do both engines gain? | Yes, on every row. On rows 7, 9 and 10 pgrust saves 51–58% a statement and PGlite OPFS 39–54%, and the multiple falls from 1.53–1.60× to 1.23–1.42×. The INSERT rows save both engines about equally. | §5 |
| Why not the note's 1.09–1.20×? | Those were warm passes, and a Run times each row once, cold in the note's terms. Its cold figures, 1.18–1.51×, are what the Suite reproduces. | §3 |
| The clock fix? | One `DataView` per memory buffer instead of one per clock read: 206–226 ns against 319–467 ns a read from JS, and 1.5–2.9 µs a statement off the warm medians of the node lane's named-statement rows, inside the arms' spread. The modules are unchanged. | §6 |
| Did anything else move? | No. The Speedtest's multiple holds at 1.45–1.48× in two of three control Runs, with totals up to 4.3% higher beside a second busy core on the box. | §7 |

## What this does not show

- **A warm Prepared Suite.** Each row runs once per Run. The note's second and third passes
  (1.09–1.20× in Chromium on disk) are not something a Run measures, and nothing here re-measures
  them.
- **The wire protocol in the browser.** The Suite is SQL-level `PREPARE`/`EXECUTE`, because the
  page's workers speak the simple protocol. A named statement on the wire (the note's B named) was
  not run in the browser, so the clock fix's effect in the browser is not measured either: every
  browser Run here has the new shim, and none has the old.
- **The DDL's share of rows 1 to 3's saving**, beyond the per-statement profile's estimate for a
  `CREATE TABLE` text (§1). The Speedtest times it and the Suite does not.
- **Replication on a quiet box.** Two Prepared Runs, one of them beside another session's
  CPU-bound script, and three control Runs, all beside it.
- **Other browsers**, and the eleven other columns under the load gate: the e2e lane ran them once,
  ungated (§8).
- **pgxsinkit's own statements.** The shapes are the Speedtest's single-row statements, as in the
  prepared-statements note (§10 there).
- **The plan cache on the page.** §2 is the note's finding, not re-measured in the browser.
- **wa-sqlite.** It does not run the Suite. Nothing here says what an API-level prepared statement,
  which is how SQLite prepares, would give it.

## Reproduction

In this repo, from the root, with the published modules in `public/pgrust/` (the pgrust half in
`/home/anton/dev/tmp/pgrust`, scratch under each repo's `tmp/agents/`):

```
# pgrust: the fix's own lanes, on the published modules
tmp/agents/clockview/lanes.sh                      # (in the pgrust checkout)

# here: vendor it, check the modules did not move
bun run sync:pgrust
sha256sum public/pgrust/* public/pgrust/host/*.js   # against tmp/agents/prepared-suite/shas-before.txt

# the Suite's texts, from the Speedtest's own scripts (regenerates src/suites/prepared/prepared<N>.sql)
bun tmp/agents/prepared-suite/make-sql.ts

# the clock fix: JS-level and node lane (ab/src-old is a copy of src/ at 9391013, ab/src-new the same
# with 6ed7984bf0's pgrust-wasi.js; wasi-old.js and wasi-new.js are the two shims on their own)
node tmp/agents/prepared-suite/buffer-identity.mjs
node tmp/agents/prepared-suite/buffer-identity-worker.mjs
node tmp/agents/prepared-suite/clock-micro.mjs
bun tmp/agents/prepared-suite/ab/lanes.ts
bun tmp/agents/prepared-suite/ab/tables.ts > tmp/agents/prepared-suite/ab/tables.md

# the gate (build once, then every Run --no-build behind the load gate)
bun run build
tmp/agents/prepared-suite/gate.sh r1 prepared pglite-opfs-repacked-relaxed r2 prepared pglite-opfs-repacked-relaxed \
  r1 speedtest pglite-memory
tmp/agents/prepared-suite/gate.sh r2 speedtest pglite-memory r3 speedtest pglite-memory
bun tmp/agents/prepared-suite/tables.ts > tmp/agents/prepared-suite/tables.md

# the Suite alone, as the page runs it
bun run bench --suite prepared \
  --configurations pglite-memory,pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed \
  --baseline pglite-opfs-repacked-relaxed

# the e2e lane (fourteen columns, four Suites, not load-gated)
bun run test:e2e
```
