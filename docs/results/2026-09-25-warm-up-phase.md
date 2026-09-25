# The Warm-up: every Engine now pays its first-use costs on a line of its own, and pgrust's Speedtest row 1 falls from 4.5× PGlite Memory to 2.5–3.0×

- Date: 2026-09-25
- Machine: i7-1165G7 (8 logical cores), 30 GiB, Linux 7.0.0-34-generic, ext4 under `/home`. Every
  timed Run waited for a 1-minute load under 2.5 (§4).
- Browser: headless **Chromium 149.0.7827.55**, Playwright 1.61.1's `chromium_headless_shell-1228`,
  in the bench's persistent context (a fresh profile on disk, OPFS on disk), driven by
  `bun run bench --no-build`.
- Engines, from the page's own header:
  `@pgxsinkit/pglite 0.5.5-pgx.3 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust 3624f82cf0 |
  wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available`.
  The published pgrust modules (threads `556d0731dd5f…`, single-session `4c010907fe9f…`) were
  sha-verified before and after every Run and never replaced.
- Columns: `pglite-memory` (PGL-MEM, the Baseline), `pglite-opfs-repacked-relaxed` (PGL-OPFS) and
  `pgrust-postmaster-opfs-repacked-relaxed` (pgrust), all three in one page per Run.
- Before and after: the **before** Runs served a `bun run build` of `48e626c`; the **after** Runs a
  build of `1f3c8db`, the commit on top of it that adds the Warm-up. Nothing else differs between
  the two builds.
- Driver: a scratch gate loop (`tmp/agents/warmup/gate.sh`: module check, load gate, one
  `bun run bench` per Run); the tables of §4 to §6 are printed by `tmp/agents/warmup/tables.ts` from
  the Runs' own results files in `tmp/agents/warmup/runs/`, and §7's by `e2e-table.ts` from the e2e
  lane's results file in `tmp/agents/warmup/e2e/` (all untracked).

## What this answers

The first Benchmark of every Suite has been paying the Engine's first-use costs: the browser
compiling each wasm function at its first call, the catalog and relation caches filling. On the
Speedtest that lands on row 1, 1 000 single-row INSERTs, which reads about 4× PGlite for pgrust in
Chromium ([the persistent-context note](2026-09-24-persistent-context.md) §5: 4.29× PGlite Memory).
The [per-statement profile](2026-09-25-per-statement-profile.md) took it apart in node: 2.53× PGlite
cold against 1.65× warm, with 85% of the cold difference warm-up rather than the engine's
per-statement cost (§8 and its Verdict). The owner decided that a Benchmark must not carry an
Engine's bootstrap costs: every Engine now runs one fixed **Warm-up** script once after it boots and
before the first Benchmark of every Suite, and the Warm-up is timed and reported on its own line,
with a ratio like any row, and kept out of every Suite total. PGlite and pgrust both pay it, in the
open. This note records what the Warm-up is, where it runs, and what it changes on the three columns
the recent notes lean on.

**Five findings.**

1. **Row 1 falls for both engines, and much further for pgrust.** PGlite Memory's row 1 goes from
   59.0–60.6 ms to 39.3–41.3 and pgrust's from 266.2–276.6 to 103.8–117.3, so pgrust's row 1 goes
   from 4.51–4.57× PGlite Memory to 2.52–2.99×. PGlite OPFS's goes from 63.0–72.4 to 46.6–64.3 (§5).
2. **The Warm-up line is where pgrust's first-use costs now show, and they are larger than row 1 made
   them look.** The Warm-up is 62.8–71.5 ms on PGlite Memory, 79.5–103.7 on PGlite OPFS and
   691.7–739.4 on pgrust, 9.7–11.3× PGlite Memory, across the four Runs of the three Suites (§5).
3. **Rows after row 1 warm up too, on pgrust only.** Row 2 (25 000 INSERTs in a transaction) goes from
   1093–1138 ms to 876–896, row 4 from 441–465 to 358–366 and row 7 from 918 to 819–859; PGlite's
   rows 2 to 15 move by no more than 9%, bar two short rows that were already noisy. pgrust's Suite
   total drops by 543–660 ms, 4.4–5.4% (12 241–12 266 ms to 11 607–11 698), and its multiple over
   PGlite Memory from 1.49–1.51× to 1.45–1.46× (§5, §6).
4. **The RTT and Concurrency Suites move for pgrust as well** (one Run each): the RTT Suite's first
   statement goes from 0.646 to 0.404 ms and its sum of twelve from 8.97 to 7.07 ms; the Concurrency
   Suite's read fan-out (Test 1) from 897 to 438 ms, below PGlite Memory's 751 (§6).
5. **pgrust's Warm-up line depends on which columns ran before it in the same page.** In one
   fourteen-column page (the e2e lane, not load-gated), the first column to use each pgrust module
   pays 561–660 ms for its Warm-up, but every Threads and Postmaster column after the first Threads
   one pays 55–135 ms, close to PGlite's 64–93, and then runs Speedtest row 1 in 33.6–50.0 ms
   against PGlite Memory's 41.9. The two single-session columns both pay the full price. Most of
   what the Warm-up line holds for pgrust is something a sibling column in the same page can have
   paid already (§7).

## 1. The script

`src/suites/warmup.sql`, one file for all three Suites, byte-identical for every Engine and sent as
one query text, the way a Speedtest script is. It is 612 statements under a two-line comment:

- `CREATE TABLE warmup_scratch(k INTEGER PRIMARY KEY, v INTEGER, t VARCHAR(100))`, a name no Suite
  uses in either dialect (the Speedtest's `t1`, `t2`, `t3`, `t2_1` and `t3_1`, the RTT Suite's `t1`
  and `t2`, the Concurrency Suite's three `concurrency_*` tables);
- 500 single-row INSERTs (`k` 1 to 500, `v` = 7919·k mod 1000, `t` = `'warm-up row <k>'`);
- `CREATE INDEX warmup_scratch_v ON warmup_scratch(v)`;
- 36 indexed SELECTs (half a 100-wide range on `v` with `count(*)` and `avg(k)`, half a point on
  `k`), 36 indexed UPDATEs (half `v = v + 1` by `k`, half a text update over a 10-wide range on `v`)
  and 36 DELETEs by `k`;
- one big DELETE (`WHERE v >= 100`, 418 of the 464 rows left) and `DROP TABLE warmup_scratch`.

It is the dialect-neutral subset the Speedtest scripts are written in, so wa-sqlite runs it
unchanged, and a Configuration's SQL rewrite reaches it as it reaches everything else a Run executes:
the two unlogged columns warm up on an UNLOGGED table. PGlite (in node) and SQLite (`bun:sqlite`)
leave the same 46 rows before the DROP. Sized in node on PGlite before it went into the page: 57–68 ms
as the first text after boot and 32–43 ms the second time, against 35–46 and 24–28 ms for a first
draft of 300 rows and 24 of each kind. The larger one is still a few hundred rows and a few dozen of
each kind, and puts PGlite's Warm-up between 50 and 150 ms, which was the size asked for.

## 2. Where it runs

In `runSuite` (`src/runner/run-suite.ts`), the one place every Suite's Run is driven, for every
Engine and every Suite:

1. the worker starts, the Engine boots and its store opens (`open`, now with no preamble);
2. **the Warm-up runs, timed** — `measure`, the request every statement Benchmark uses, so the clock
   is the worker's `performance.now()` around the Engine call and nothing else, on the first Session;
3. the Suite's untimed setup runs (`exec`): the Speedtest's editable preamble, the RTT Suite's two
   tables, the Concurrency Suite's 100 000-row table;
4. the Benchmarks run as before.

The Warm-up comes before the setup in all three Suites, not only in the Concurrency Suite, so the
line measures the same thing everywhere: the first SQL an Engine runs after boot. Had it come after
the setup, the RTT Suite's `CREATE TABLE`s (pgrust's first `CREATE TABLE` is 29.4 ms cold against
1.0 warm, per-statement profile §8) and the Concurrency Suite's 100 000-row build would pay part of
the first-use cost untimed first, and the Warm-up line would mean something different in each
Suite. On pgrust
Postmaster it runs on Session 0, the Session the setup and the single-statement Benchmarks run on.

## 3. How it is reported

- **The page:** the first row of every Suite's table, labelled **Warm-up**, with a ratio against the
  Baseline like any row, set in italics above the Benchmarks.
- **The Markdown export** (`src/results/markdown.ts`), and so the results file `bun run bench` writes:
  a line above the table, `Warm-up: warmup.sql, timed once per Run after the Engine opens and before
  the Suite's untimed setup; its row is not part of any Suite total`, and the Warm-up as the table's
  first row, `| Warm-up | … |`. An export without that line is from before `1f3c8db`.
- **The data:** the Warm-up is its own Measurement everywhere it travels: `RunPlan.warmupSql`
  beside `benchmarks`, its own `onWarmup` callback beside `onResult`, and its own `warmup` cells in
  the results grid, keyed by column, beside the Benchmarks' `cells`. Nothing that walks a Suite's
  Benchmarks can reach it.
- **The label** does not start with `Test`, so any total taken over a table's `| Test` rows (every
  total in these notes) leaves it out by construction.

## 4. Environment and load

Eight timed Runs, one at a time, before then after; one untimed smoke Run (RTT at three iterations)
before the gate. Only the last one waited, 15 s. The 1-minute load before → after each Run:

| Run | build | Suite | waited | load before → after |
| --- | --- | --- | --- | --- |
| before r1 | `48e626c` | Speedtest | 0 s | 0.58 → 1.69 |
| before r2 | `48e626c` | Speedtest | 0 s | 1.69 → 1.73 |
| before | `48e626c` | RTT | 0 s | 1.73 → 1.93 |
| before | `48e626c` | Concurrency | 0 s | 1.93 → 2.25 |
| after r1 | `1f3c8db` | Speedtest | 0 s | 1.94 → 1.79 |
| after r2 | `1f3c8db` | Speedtest | 0 s | 1.79 → 2.07 |
| after | `1f3c8db` | RTT | 0 s | 2.07 → 2.83 |
| after | `1f3c8db` | Concurrency | 15 s | 2.42 → 2.68 |

No Run reported a failure or a page error.

## 5. Before and after

Milliseconds; Speedtest before r1 / r2 → after r1 / r2, RTT and Concurrency one Run each (RTT is ms
per statement, Concurrency Test 1 is a total wall). The Warm-up has no before: it did not exist.

| Row | PGlite Memory | PGlite OPFS repacked (relaxed) | pgrust Postmaster OPFS repacked (relaxed) | pgrust ÷ PGlite Memory |
| --- | --- | --- | --- | --- |
| **Speedtest Warm-up** | – → 62.8 / 71.0 | – → 103.7 / 79.5 | – → 709.5 / 739.4 | – → 11.30× / 10.42× |
| **Speedtest 1: 1000 INSERTs** | 60.6 / 59.0 → 41.3 / 39.3 | 72.4 / 63.0 → 46.6 / 64.3 | 276.6 / 266.2 → 103.8 / 117.3 | 4.57× / 4.51× → 2.52× / 2.99× |
| Speedtest total (the 18 `Test` rows) | 8220.8 / 8100.2 → 7987.1 / 8004.3 | 8412.8 / 8438.7 → 8406.4 / 8612.4 | 12266.3 / 12241.2 → 11698.3 / 11606.7 | 1.49× / 1.51× → 1.46× / 1.45× |
| **RTT Warm-up** | – → 65.3 | – → 91.5 | – → 705.3 | – → 10.80× |
| RTT 1: insert small row | 0.400 → 0.266 | 0.329 → 0.348 | 0.646 → 0.404 | 1.62× → 1.52× |
| RTT sum of the 12 | 4.788 → 4.640 | 4.746 → 4.689 | 8.968 → 7.074 | 1.87× → 1.52× |
| **Concurrency Warm-up** | – → 71.5 | – → 96.0 | – → 691.7 | – → 9.67× |
| Concurrency 1: Read fan-out, total wall | 734.3 → 751.4 | 755.8 → 715.9 | 897.1 → 438.4 | 1.22× → 0.58× |

Against [the persistent-context note](2026-09-24-persistent-context.md)'s new lane (§3, pgrust
`569d16128c`, before the three postmaster settings were adopted): its row 1 was 58.0–63.4 ms on
PGlite Memory, 63.6–66.7 on PGlite OPFS and 245.9–277.9 on pgrust, which the before Runs here match
(59.0–60.6, 63.0–72.4, 266.2–276.6). After, row 1 is 39.3–41.3, 46.6–64.3 and 103.8–117.3.

The Warm-up does not take row 1 to its warm value. The per-statement profile's warm row 1, the
second time through the same engine in node, was 30.8–40.3 ms on pgrust and 18.7–19.3 on PGlite
(§8); here row 1 after a Warm-up is 103.8–117.3 and 39.3–41.3 in Chromium. That note also found
pgrust still warming after 2 100 statements (§8). The Warm-up is kept small on purpose, and 612
statements do not finish the job; §7 shows how far from warm row 1 still is.

## 6. What else moved

Speedtest, pgrust, before r1 / r2 → after r1 / r2: row 2 1093.3 / 1138.4 → 895.7 / 876.2, row 2.1
242.8 / 227.2 → 205.6 / 195.6, row 4 440.7 / 465.2 → 357.7 / 365.9, row 7 917.9 / 917.5 → 819.2 /
858.7, row 8 242.3 / 245.5 → 226.3 / 215.4, row 16 19.9 / 15.5 → 8.6 / 7.3. Each of them is the first
row of its kind in the Suite, and a kind the Warm-up now runs before it: INSERTs (rows 2 and 2.1),
`count`/`avg` aggregates over a range (rows 4 and 7), UPDATEs (row 8) and DROP TABLE (row 16). That is
what first use would look like; which code each row shares with the Warm-up was not profiled. Rows 9
and 10 do not move, as the per-statement profile found (they run what rows 7 and 8 already ran). On the
PGlite columns rows 2 to 15 move by −9% to +9% of their before mean, except the two short DELETE
rows 12 and 13 (23–51 ms), whose own two before Runs differ by 17–44%; PGlite Memory's row 16 falls
from 5.1 to 2.6–3.1 ms (`pglite-drift.ts`).

pgrust's Suite total falls by 543–660 ms, less than its Warm-up line (709–739 ms): the Warm-up is 612
statements of work of its own, not only first use.

RTT and Concurrency, one Run each, so only the direction is claimed. On RTT the pgrust statements
that fall most are 1, 3, 5, 6 and 7 (0.603–1.444 → 0.361–1.008 ms); a trimmed mean already drops a
Benchmark's slowest 10 iterations, so this is first use that lasted longer than ten executions. On
Concurrency, pgrust's read fan-out halves (897 → 438 ms) while its four Clients each run on their own
backend, of which only Session 0's ran the Warm-up; the other three backends' caches start cold.
Why the other three benefit was not looked at here; code compiled by one backend's worker being
reused by the others would explain it and was not verified. pgrust's disjoint-row writers (Test 4) go
from 4435 to 4902 transactions/s; the PGlite columns move by no more than their own noise.

## 7. In a page of fourteen columns

The e2e lane (`bun run test:e2e`) runs all fourteen Configurations in one page, Suite by Suite, with
the RTT Suite at three iterations. It ran once after the gate, alone on the box but **not behind the
load gate**, so only the shape of what follows is claimed. The Warm-up per column in each Suite,
and Speedtest row 1, milliseconds:

| Column (page order) | module | Speedtest | RTT | Concurrency | Speedtest row 1 |
| --- | --- | --- | --- | --- | --- |
| PGlite Memory | PGlite | 64.0 | 83.3 | 69.4 | 41.9 |
| PGlite Memory (unlogged) | PGlite | 67.7 | 65.8 | 66.1 | 40.0 |
| PGlite OPFS repacked (relaxed) | PGlite | 82.5 | 91.6 | 83.9 | 50.5 |
| PGlite OPFS repacked (strict) | PGlite | 92.5 | 88.3 | 87.0 | 63.0 |
| pgrust Memory | single-session | 600.9 | 585.7 | 563.2 | 98.6 |
| pgrust Memory (unlogged) | single-session | 607.7 | 659.8 | 586.5 | 76.5 |
| pgrust Threads Memory | threads | 586.2 | 560.8 | 622.6 | 100.6 |
| pgrust Threads Memory (broker) | threads | 62.5 | 134.6 | 71.8 | 36.2 |
| pgrust Threads OPFS repacked (relaxed) | threads | 63.8 | 104.8 | 74.3 | 34.5 |
| pgrust Threads OPFS repacked (strict) | threads | 94.3 | 109.0 | 91.4 | 50.0 |
| pgrust Postmaster Memory (broker) | threads | 93.1 | 73.7 | 71.3 | 33.6 |
| pgrust Postmaster OPFS repacked (relaxed) | threads | 55.5 | 77.7 | 66.4 | 34.3 |
| wa-sqlite Memory | wa-sqlite | 107.0 | 120.8 | 87.3 | 62.8 |
| wa-sqlite Memory (journal off) | wa-sqlite | 50.9 | 50.7 | 59.4 | 33.4 |

The first column in each Suite to run the threads module pays 561–623 ms; the five threads columns
after it, the Postmaster OPFS column this note's gate measures among them, pay 55–135 ms and run
Speedtest row 1 in 33.6–50.0 ms, at or below PGlite Memory. The second single-session column pays the
full price again, in every Suite. The Concurrency Suite's read fan-out follows the same line: 145.0
ms on the Postmaster OPFS column here against 438.4 in the gate's three-column page.

So the part of pgrust's first-use cost that a Warm-up line shows is mostly something that outlives
one Run when the next Run's Engine loads the same module soon enough: compiled code, which is what the
per-statement profile inferred (§8). That was not traced here, and nor was why the single-session
module does not carry over. Two consequences. A pgrust column's Warm-up, and its first rows, depend
on its neighbours in the page, so a three-column gate and a fourteen-column page are not the same
measurement for the later pgrust columns; that was as true before `1f3c8db` as after it. And in the
gate's page, where the Postmaster column is the only user of its module, the Warm-up takes pgrust's
row 1 from 266–277 ms to 104–117, not to the 34 ms it runs in once another column has used the
module first: 612 statements do not warm everything row 1 runs.

## 8. What this changes about earlier numbers

**Every earlier note's Speedtest row 1 includes the Engine's first-use costs and is not comparable to
row 1 from `1f3c8db` on**; on pgrust that is most of the row (§5). The same holds, less sharply,
for pgrust's rows 2, 2.1, 4, 7, 8 and 16 and its Suite total (4.4–5.4% lower now), for the RTT
Suite's pgrust rows and for the Concurrency Suite's read fan-out. No older note was changed.

The scratch scripts that total an export over its `| Test` rows (`tmp/agents/persist/tables.ts`,
`persist/totals.ts`, `safari27/visibility.ts`, `anchors/browser-ladder.ts`) keep their totals. Three
earlier drivers sum every body row instead (`tmp/agents/adopt/ab.ts`, `leakfix/ab.ts`,
`levers/arms.ts`): run against an export with a Warm-up, their totals include it (on after r1, by
62.8, 103.7 and 709.5 ms), and `adopt/tables.ts`, which prints `adopt/ab.ts`'s totals, inherits that.
They were left as they are.

## 9. What this does not show

- **Other columns, gated.** The gate is three Configurations. The other eleven ran the same Warm-up
  through the same code once, in the e2e lane (§7), and none failed; no before/after was taken for
  them.
- **Other browsers.** Chromium only.
- **Replication.** Two Runs per build for the Speedtest, one for RTT and Concurrency. The row 1 drop
  is several times the spread between Runs; RTT and Concurrency are claimed for direction only.
- **A full warm-up.** The Warm-up takes the first use of each code path out of the Benchmarks; it
  does not bring an Engine to its steady state (§5, §7).
- **Why the Concurrency fan-out halves** for pgrust (§6), or what carries a warm module from one
  column to the next and why only the threads module's does (§7).
- **The fourteen-column page under the load gate** (§7): one e2e Run, not gated.
- **The probes.** `probe:memory`, `probe:idle-cpu` and `probe:prepared-store` open an Engine through
  their own code, not through `runSuite`, and run no Warm-up.

## Reproduction

In this repo, from the root, with the published modules in `dist/pgrust/`:

```
# one Run of each Suite on the gate's three columns (from 1f3c8db on, the Warm-up leads every table)
bun run bench --suite speedtest \
  --configurations pglite-memory,pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed \
  --baseline pglite-memory
bun run bench --no-build --suite rtt \
  --configurations pglite-memory,pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed \
  --baseline pglite-memory
bun run bench --no-build --suite concurrency \
  --configurations pglite-memory,pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed \
  --baseline pglite-memory

# the gated campaign and its tables (scratch, untracked):
# build 48e626c for "before", 1f3c8db for "after"
bun run build
tmp/agents/warmup/gate.sh before r1 speedtest r2 speedtest r1 rtt r1 concurrency
bun run build
tmp/agents/warmup/gate.sh after r1 speedtest r2 speedtest r1 rtt r1 concurrency
bun tmp/agents/warmup/tables.ts
bun tmp/agents/warmup/pglite-drift.ts
bun tmp/agents/warmup/check-parsers.ts tmp/agents/warmup/runs/after-r1-speedtest/*.md

# section 7's fourteen-column page (the e2e lane; RTT at three iterations, not load-gated),
# its results file moved from tmp/results/ to tmp/agents/warmup/e2e/
bun run test:e2e
bun tmp/agents/warmup/e2e-table.ts

# sizing the script (PGlite in node) and regenerating it
bun tmp/agents/warmup/generate.ts 500 36
node tmp/agents/warmup/size.ts
```
