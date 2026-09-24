# The headless lane now keeps OPFS on disk: PGlite OPFS drops from 1.68× PGlite Memory to 1.05×, and pgrust goes from 1.50× PGlite OPFS to 1.57×

- Date: 2026-09-24
- Machine: i7-1165G7 (8 logical cores), 30 GiB, Linux 7.0.0-34-generic, ext4 under `/home`, `/tmp` a
  tmpfs. A desktop Chrome held one core at 100% throughout and other agents came and went; every
  timed Run waited for a 1-minute load under 2.5 (§2).
- Browser: headless **Chromium 149.0.7827.55**, Playwright 1.61.1's `chromium_headless_shell-1228`,
  driven by `bun run bench --no-build`. Both lanes are the same executable with the same flags; the
  only difference is the browser context (§1).
- Engines, from the page's own header:
  `@pgxsinkit/pglite 0.5.5-pgx.3 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust 569d16128c |
  wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available`.
  The published pgrust modules (threads `df17f7e24a33…`, single-session `0d772984de72…`) were
  sha-verified before and after every Run and never replaced; `dist/` is the 19 September build,
  untouched here.
- Columns: `pglite-memory` (PGL-MEM), `pglite-opfs-repacked-relaxed` (PGL-OPFS) and
  `pgrust-postmaster-opfs-repacked-relaxed` (pgrust), all three in one page per Run.
- Driver: `bun run bench` at `4f65433`, the change this note records, with `--ephemeral-context` for
  the old lane (the Runs were taken before that commit was amended for one comment; the code they ran
  is the same). The load gate, the module check and the ledger are a scratch loop
  (`tmp/agents/persist/ab.sh`, `ab2.sh`); every table below is printed by
  `tmp/agents/persist/tables.ts` from the Runs' own results files in `tmp/agents/persist/runs/`
  (untracked).
- What changed in the repo: `bun run bench` and the three probes that open a store
  (`probe:memory`, `probe:idle-cpu`, `probe:prepared-store`) now run the page in a persistent context.
  No number in an older note was changed; each one that quotes a headless Chromium OPFS figure got a
  dated pointer to this one (§8).

## What this answers

[The store-levers note](2026-09-24-store-levers.md) §3 found that `bun run bench` opened its page with
Playwright's `browser.newContext()`, an off-the-record context, where one OPFS access-handle call cost
0.2–0.4 ms whatever its size and a flush 3–5 µs; in a persistent context the same calls cost 12–16 µs
and 1.3–1.5 ms. So every OPFS number the headless lane had published, for PGlite and pgrust alike,
was mostly a per-call bill that a browser on a real profile does not charge. The owner decided the
lane moves to a persistent context before anything else is decided from its numbers. This note
records the move and measures what it changes on the three columns the recent notes lean on.

**Four findings.**

1. **On disk, OPFS costs PGlite 3–6% of the Speedtest, not 68–72%.** PGlite OPFS repacked (relaxed)
   runs 7641–7698 ms against PGlite Memory's 7258–7446 ms; in the old lane it was 12 257–12 397 ms
   against 7220–7311. The rows the old lane made OPFS-bound come back to or near PGlite Memory: row 11
   at 0.99× (was 4.82×), row 6 at 1.14× (2.88×), row 14 at 1.18× (3.14×), row 3 at 1.03× (2.38×).
2. **pgrust gains about as much as PGlite does, so its multiple over PGlite OPFS barely moves.** The
   postmaster's Suite total is 0.65× what it was (PGlite OPFS: 0.63×). Against PGlite OPFS it goes
   from 1.49–1.51× to **1.55–1.57×** in three Runs of four (the fourth, 1.98×, is §4's outlier);
   against PGlite Memory from 2.50–2.57× to **1.62–1.64×**. The per-row picture reshuffles: row 1 goes
   from 6.07× to 4.00× PGlite OPFS, row 11 from 1.42× to 1.74×, row 6 from 1.68× to 1.39×, row 14
   from 1.46× to 1.37×.
3. **On commit-heavy Suites pgrust gains less than PGlite does.** Nothing got slower in absolute
   terms, but the RTT sum moved PGlite OPFS 7.23 → 4.83 ms and pgrust 12.38 → 10.93 ms, so pgrust's
   RTT ratio grew from 1.71× to 2.26× PGlite OPFS, all of it on the writing statements — consistent
   with a store flush that now costs a millisecond and more, which pgrust's commits reach (§7).
   Writers on disjoint rows (Concurrency Test 4) went from 931 to 1654 transactions/s on PGlite OPFS
   and 2233 to 2973 on pgrust (one Run each).
4. **The mechanism is read from Chromium's source and seen on disk** (§1): in the old lane no OPFS
   byte reached a file; the headless shell makes every CDP-created context incognito, and an incognito
   file system serves each access-handle call as one synchronous IPC to the browser process, with a
   flush that does nothing. The source read is Chromium main, not the 149 branch, and one link in the
   chain was not read.

## 1. What the lane was, and what it is now

**Was.** `browser.newContext()` on a browser from `chromium.launch()`. Playwright gives that browser a
`--user-data-dir` under `/tmp/playwright_chromiumdev_profile-*` (a tmpfs here) and makes the context
with CDP's `Target.createBrowserContext` (read in Playwright 1.61.1's own bundle), which the protocol
documents as "similar to an incognito profile". During a smoke Run of both OPFS columns (RTT Suite at 3
iterations, which seeds each column's store), sampled every 0.5 s: the browser's user-data directory
stayed at **46 412 bytes** for all seventeen samples, and no `Default/File System` directory ever
appeared. No OPFS byte reached a file. Every earlier Chromium driver in this repo did the same: a grep
of the scratch drivers under `tmp/agents/` finds one persistent context before this change (the
store-levers note's disk lane, `tmp/agents/levers/arms.ts --persistent`), and every other one opened
`newContext()` or `newPage()`.

**Is.** `launchPersistentContext(userDataDir, launchOptions)` — the browser type's own, with every
launch option the lane already passed (`headless`, and `FIREFOX_USER_PREFS` for Firefox) — on a
directory made fresh per Run under `tmp/bench-profiles/<run id>-XXXXXX/` (repo-local, ext4, never the
tmpfs Playwright would use for an empty `userDataDir`) and removed after it unless `--keep-profile`
is passed. The persistent context's own first page is the one driven, so a Run is still one tab.
During the same smoke Run in the new lane the profile's `Default/File System` grew from nothing to
**45–79 MB**, and the renderer held **4 file descriptors** under it (the browser process 9). After the
Run the whole profile was gone. Beside the timed Runs of rounds 3 and 4 (§3), `vmstat` put the
persistent lane at ~9.9 MB/s of block writes against 0.2–0.4 MB/s in the ephemeral lane (the box's
own background), and IO pressure (`/proc/pressure/io`, some) grew by 53–59 ms over a ~35 s persistent
Run against 15–16 ms over an ephemeral one.

**What Chromium does with each.** Read on 2026-09-24 from `chromium/src` **main** on
chromium.googlesource.com, not from the 149 branch:

- `headless/lib/browser/headless_devtools_manager_delegate.cc`: the headless shell answers
  `Target.createBrowserContext` with `params.incognito_mode = true`, and
  `headless_browser_context_impl.cc` returns that flag from `IsOffTheRecord()`.
- `content/browser/storage_partition_impl.cc` creates the partition's file system context with
  `is_in_memory()` as the `is_incognito` argument of `CreateFileSystemContext`
  (`content/browser/file_system/browser_file_system_helper.cc`, which then picks
  `PROFILE_MODE_INCOGNITO` unless the browser context may use disk when off the record). The step
  from an off-the-record browser context to an in-memory partition (`StoragePartitionConfig`) was not
  read.
- `content/browser/file_system_access/file_system_access_file_handle_impl.cc`: when an access
  handle's lock is taken, `DidTakeAccessHandleLock` opens `DoOpenIncognitoFile` if
  `file_system_context()->is_incognito()`, and `DoOpenFile` otherwise.
- The incognito path hands the renderer a remote to a `FileSystemAccessFileDelegateHost` in the
  browser process. On the renderer side,
  `third_party/blink/renderer/modules/file_system_access/file_system_access_incognito_file_delegate.cc`
  makes **one synchronous mojo call per `Read`, `Write`, `GetLength` and `SetLength`**; `Write`
  also creates a data pipe and feeds it from a thread-pool task. Its `Flush()` is `return true`, under
  the comment "Flush is a no-op for in-memory file systems".
- The regular path hands the renderer a `base::File`, and `file_system_access_regular_file_delegate.cc`
  reads and writes it **in the renderer**, with no IPC. Its `Flush()` is `base::File::Flush()`, which
  is `fdatasync` on Linux (`base/files/file_posix.cc`). The one IPC left is quota: a write or truncate
  that grows the file past its granted capacity first asks the browser synchronously
  (`RequestFileCapacityChangeSync`; `file_system_access_capacity_tracker.cc` asks for at least 1 MiB
  and doubles).

That is the store-levers note's timing signature exactly: a size-independent call cost in the old
lane, a flush of a few microseconds there and of a millisecond and more on disk. What was not
verified: the source read is main, not Chromium 149; the `StoragePartitionConfig` step above was not
read; and the browser process was not traced, so that each old-lane call is exactly one of those IPCs
is read from the code and matched by the timings, not observed.

**Where each lane says what it was.** The page has no reliable way to know which context it is in,
so it has no place to say it; `bun run bench` writes it into the results file's header
(`- Browser context: persistent (a fresh profile on disk: OPFS on disk)`, or `ephemeral
(--ephemeral-context: the pre-2026-09-24 lane, …)`) and prints it above the environment line.

## 2. Environment and load

Twelve timed Runs, one at a time. None hit the 10-minute cap; the longest wait was 90 s. The 1-minute
load before → after each Run:

| Run | lane | Suite | waited | load before → after |
| --- | --- | --- | --- | --- |
| r1 | ephemeral | Speedtest | 0 s | 1.94 → 2.07 |
| r1 | persistent | Speedtest | 0 s | 2.06 → 2.25 |
| r2 | persistent | Speedtest | 0 s | 2.23 → 3.58 |
| r2 | ephemeral | Speedtest | 90 s | 2.48 → 2.51 |
| – | ephemeral | RTT | 15 s | 2.31 → 2.64 |
| – | persistent | RTT | 15 s | 2.27 → 2.99 |
| – | persistent | Concurrency | 30 s | 2.28 → 2.73 |
| – | ephemeral | Concurrency | 15 s | 2.35 → 2.77 |
| r3 | ephemeral | Speedtest | 0 s | 2.38 → 2.69 |
| r3 | persistent | Speedtest | 15 s | 2.31 → 2.87 |
| r4 | persistent | Speedtest | 15 s | 2.45 → 2.39 |
| r4 | ephemeral | Speedtest | 0 s | 2.39 → 2.57 |

Before the timed Runs, eight untimed smoke Runs (RTT at 3 iterations, one or both OPFS columns) built
§1's profile watch and exercised `--keep-profile`; after them, a Firefox smoke that could not launch
(§9) and one `probe:memory` smoke. None of their numbers is used below except where §1 and the
pointers say so.

## 3. Speedtest, all 18 rows

The brief was two interleaved rounds: round 1 ephemeral then persistent, round 2 persistent then
ephemeral. Round 2's persistent Run came out 26% slower than round 1's on the pgrust column alone
(§4), so two more rounds were taken in the same two orders. Milliseconds, rounds 1 / 2 / 3 / 4.

### The old lane (`--ephemeral-context`)

| Benchmark | PGlite Memory | PGlite OPFS repacked (relaxed) | pgrust Postmaster OPFS repacked (relaxed) |
| --- | --- | --- | --- |
| **1: 1000 INSERTs** | 57.5 / 59.0 / 59.3 / 59.3 | 88.3 / 85.5 / 89.1 / 86.4 | 534.7 / 535.7 / 525.6 / 525.9 |
| **2: 25000 INSERTs in a transaction** | 586.6 / 581.7 / 573.2 / 591.8 | 732.2 / 738.9 / 719.6 / 752.6 | 1101.0 / 1089.5 / 1106.6 / 1099.0 |
| 2.1: 25000 INSERTs in single statement | 133.4 / 139.6 / 135.5 / 139.4 | 271.7 / 245.6 / 246.0 / 244.8 | 433.1 / 446.3 / 427.4 / 447.5 |
| 3: 25000 INSERTs into an indexed table | 730.3 / 746.4 / 743.9 / 741.5 | 1771.2 / 1742.6 / 1790.0 / 1758.5 | 2738.7 / 2717.6 / 2701.4 / 2684.6 |
| 3.1: 25000 INSERTs into an indexed table in single statement | 157.6 / 163.6 / 161.9 / 163.9 | 328.0 / 321.7 / 332.4 / 321.8 | 579.7 / 572.1 / 582.6 / 562.9 |
| 4: 100 SELECTs without an index | 310.9 / 329.4 / 311.5 / 334.0 | 324.6 / 317.7 / 310.1 / 322.0 | 391.5 / 393.3 / 390.8 / 391.1 |
| 5: 100 SELECTs on a string comparison | 791.6 / 823.3 / 793.6 / 818.6 | 841.0 / 799.1 / 795.9 / 822.9 | 745.0 / 759.2 / 757.5 / 759.9 |
| **6: Creating an index** | 28.4 / 31.1 / 28.8 / 28.7 | 82.5 / 83.6 / 82.0 / 83.1 | 143.9 / 134.5 / 144.1 / 134.5 |
| 7: 5000 SELECTs with an index | 444.5 / 477.5 / 458.8 / 453.2 | 497.6 / 513.9 / 497.1 / 498.9 | 867.6 / 870.7 / 880.3 / 861.5 |
| 8: 1000 UPDATEs without an index | 167.9 / 167.4 / 169.4 / 167.9 | 173.4 / 179.4 / 169.9 / 170.7 | 207.9 / 215.0 / 213.1 / 208.6 |
| 9: 25000 UPDATEs with an index | 1346.7 / 1334.0 / 1369.3 / 1353.1 | 1995.8 / 2007.9 / 1974.7 / 1985.5 | 2983.2 / 3007.6 / 3007.6 / 2993.9 |
| 10: 25000 text UPDATEs with an index | 1711.0 / 1698.2 / 1736.5 / 1716.2 | 2964.0 / 2941.6 / 2971.8 / 2923.1 | 4366.7 / 4282.7 / 4252.3 / 4244.3 |
| **11: INSERTs from a SELECT** | 293.3 / 282.4 / 285.1 / 283.2 | 1360.4 / 1367.2 / 1372.5 / 1370.3 | 1973.4 / 1958.7 / 1939.2 / 1933.3 |
| 12: DELETE without an index | 23.1 / 24.0 / 29.7 / 23.6 | 33.2 / 27.7 / 27.3 / 27.9 | 49.5 / 53.9 / 49.8 / 54.4 |
| 13: DELETE with an index | 28.9 / 31.7 / 31.9 / 31.6 | 50.7 / 43.3 / 42.1 / 41.5 | 123.5 / 112.9 / 116.4 / 114.6 |
| **14: A big INSERT after a big DELETE** | 164.1 / 167.8 / 165.0 / 162.0 | 534.5 / 509.3 / 517.9 / 515.1 | 755.8 / 757.3 / 758.9 / 746.3 |
| 15: A big DELETE followed by many small INSERTs | 239.2 / 242.6 / 237.8 / 238.4 | 319.9 / 306.8 / 309.6 / 304.6 | 519.6 / 526.8 / 526.1 / 522.5 |
| 16: DROP TABLE | 4.8 / 4.9 / 5.5 / 4.7 | 27.6 / 27.9 / 27.8 / 27.3 | 22.6 / 23.4 / 22.1 / 23.7 |
| **Suite total** | 7219.9 / 7304.4 / 7296.8 / 7311.0 | 12396.6 / 12259.5 / 12275.7 / 12257.1 | 18537.1 / 18457.2 / 18401.8 / 18308.5 |

### The new lane (persistent, the default)

| Benchmark | PGlite Memory | PGlite OPFS repacked (relaxed) | pgrust Postmaster OPFS repacked (relaxed) |
| --- | --- | --- | --- |
| **1: 1000 INSERTs** | 63.4 / 58.0 / 61.0 / 60.7 | 66.2 / 66.7 / 63.6 / 64.3 | 250.8 / 270.9 / 245.9 / 277.9 |
| **2: 25000 INSERTs in a transaction** | 580.4 / 583.0 / 583.5 / 564.4 | 599.1 / 592.8 / 578.3 / 583.2 | 1082.3 / 1090.3 / 1075.9 / 1069.5 |
| 2.1: 25000 INSERTs in single statement | 143.0 / 140.1 / 143.9 / 139.5 | 158.3 / 179.5 / 163.2 / 154.4 | 233.6 / 236.6 / 243.7 / 228.3 |
| 3: 25000 INSERTs into an indexed table | 759.2 / 753.6 / 746.5 / 743.6 | 793.9 / 780.8 / 758.4 / 762.4 | 1279.2 / 1340.5 / 1289.1 / 1271.0 |
| 3.1: 25000 INSERTs into an indexed table in single statement | 169.6 / 160.2 / 159.7 / 161.6 | 180.4 / 174.0 / 171.2 / 173.2 | 263.9 / 251.8 / 267.1 / 233.0 |
| 4: 100 SELECTs without an index | 366.8 / 311.4 / 310.9 / 319.4 | 320.9 / 310.9 / 313.6 / 311.5 | 417.7 / 402.0 / 403.7 / 400.3 |
| 5: 100 SELECTs on a string comparison | 852.4 / 795.9 / 799.8 / 811.1 | 812.5 / 820.3 / 803.5 / 800.2 | 767.9 / 742.5 / 761.5 / 739.5 |
| **6: Creating an index** | 29.3 / 28.6 / 28.9 / 28.4 | 32.4 / 33.6 / 33.2 / 31.3 | 45.2 / 45.7 / 36.9 / 51.4 |
| 7: 5000 SELECTs with an index | 456.9 / 449.6 / 451.1 / 458.5 | 466.9 / 471.3 / 471.5 / 481.0 | 848.1 / 1080.8 / 839.2 / 852.8 |
| 8: 1000 UPDATEs without an index | 174.0 / 167.6 / 163.4 / 166.2 | 171.1 / 164.6 / 167.4 / 167.1 | 202.7 / 256.9 / 208.8 / 203.9 |
| 9: 25000 UPDATEs with an index | 1375.1 / 1369.2 / 1377.0 / 1351.6 | 1495.0 / 1479.9 / 1494.2 / 1483.2 | 2542.3 / 3040.5 / 2450.3 / 2491.4 |
| 10: 25000 text UPDATEs with an index | 1710.8 / 1694.0 / 1714.6 / 1707.9 | 1816.9 / 1814.9 / 1824.6 / 1816.0 | 2951.2 / 4460.1 / 2817.7 / 2901.3 |
| **11: INSERTs from a SELECT** | 293.6 / 278.5 / 279.5 / 284.1 | 269.8 / 278.6 / 280.2 / 292.1 | 485.0 / 799.2 / 454.8 / 486.8 |
| 12: DELETE without an index | 23.4 / 27.6 / 23.5 / 23.4 | 23.1 / 23.7 / 23.2 / 23.1 | 31.3 / 66.7 / 31.1 / 29.7 |
| 13: DELETE with an index | 30.6 / 33.1 / 32.6 / 29.9 | 32.7 / 31.5 / 28.9 / 29.3 | 51.0 / 109.5 / 48.5 / 52.3 |
| **14: A big INSERT after a big DELETE** | 167.1 / 163.0 / 167.3 / 169.0 | 197.0 / 194.5 / 198.4 / 198.4 | 263.0 / 499.2 / 279.4 / 258.1 |
| 15: A big DELETE followed by many small INSERTs | 244.5 / 239.8 / 246.5 / 253.1 | 238.3 / 246.5 / 244.6 / 247.0 | 386.1 / 515.4 / 377.8 / 351.4 |
| 16: DROP TABLE | 5.6 / 4.7 / 5.6 / 4.6 | 23.3 / 29.5 / 23.5 / 23.0 | 16.2 / 18.1 / 17.2 / 16.3 |
| **Suite total** | 7445.8 / 7257.8 / 7295.3 / 7277.0 | 7697.5 / 7693.9 / 7641.7 / 7640.6 | 12117.3 / 15226.5 / 11848.6 / 11914.9 |

The old lane holds every Suite total to within 1.3% across four Runs. The new lane holds the two
PGlite columns to 2.6% and 0.7%, and pgrust to 2.3% in three Runs of four.

## 4. Suite totals per Run, and the outlier

| Run | lane | PGL-MEM | PGL-OPFS | pgrust | PGL-OPFS ÷ PGL-MEM | pgrust ÷ PGL-MEM | pgrust ÷ PGL-OPFS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| r1 | ephemeral | 7219.9 | 12396.6 | 18537.1 | 1.72× | 2.57× | 1.50× |
| r1 | persistent | 7445.8 | 7697.5 | 12117.3 | 1.03× | 1.63× | 1.57× |
| r2 | persistent | 7257.8 | 7693.9 | 15226.5 | 1.06× | 2.10× | 1.98× |
| r2 | ephemeral | 7304.4 | 12259.5 | 18457.2 | 1.68× | 2.53× | 1.51× |
| r3 | ephemeral | 7296.8 | 12275.7 | 18401.8 | 1.68× | 2.52× | 1.50× |
| r3 | persistent | 7295.3 | 7641.7 | 11848.6 | 1.05× | 1.62× | 1.55× |
| r4 | persistent | 7277.0 | 7640.6 | 11914.9 | 1.05× | 1.64× | 1.56× |
| r4 | ephemeral | 7311.0 | 12257.1 | 18308.5 | 1.68× | 2.50× | 1.49× |

**Round 2's persistent pgrust Run is the outlier.** Rows 1 to 6 match the other three persistent
Runs; from row 7 to row 15 every pgrust row is 1.2–2.3× theirs (row 10 4460 ms against 2818–2951,
row 11 799 against 455–487, row 14 499 against 258–279), while the two PGlite columns in the same
page are in line. The 1-minute load went from 2.23 to 3.58 across that Run, the next Run had to wait
90 s for it to fall, and nothing else in the twelve Runs moved like it. It is reported, not dropped, and it is
not explained: this Run had no `vmstat` beside it (rounds 3 and 4 did, §1), so whether the disk or
another process took the time is unknown. Rounds 3 and 4 put the persistent pgrust total at 11 849
and 11 915 ms, beside round 1's 12 117.

## 5. Ratios, from each cell's median of four Runs

| Benchmark | ephemeral: PGL-OPFS ÷ PGL-MEM | ephemeral: pgrust ÷ PGL-MEM | ephemeral: pgrust ÷ PGL-OPFS | persistent: PGL-OPFS ÷ PGL-MEM | persistent: pgrust ÷ PGL-MEM | persistent: pgrust ÷ PGL-OPFS |
| --- | --- | --- | --- | --- | --- | --- |
| **1: 1000 INSERTs** | 1.48× | 8.96× | 6.07× | 1.07× | 4.29× | 4.00× |
| **2: 25000 INSERTs in a transaction** | 1.26× | 1.88× | 1.50× | 1.01× | 1.86× | 1.84× |
| 2.1: 25000 INSERTs in single statement | 1.79× | 3.20× | 1.79× | 1.14× | 1.66× | 1.46× |
| 3: 25000 INSERTs into an indexed table | 2.38× | 3.65× | 1.54× | 1.03× | 1.71× | 1.66× |
| 3.1: 25000 INSERTs into an indexed table in single statement | 2.00× | 3.54× | 1.77× | 1.08× | 1.60× | 1.48× |
| 4: 100 SELECTs without an index | 1.00× | 1.22× | 1.22× | 0.99× | 1.28× | 1.29× |
| 5: 100 SELECTs on a string comparison | 1.01× | 0.94× | 0.94× | 1.00× | 0.93× | 0.93× |
| **6: Creating an index** | 2.88× | 4.84× | 1.68× | 1.14× | 1.58× | 1.39× |
| 7: 5000 SELECTs with an index | 1.09× | 1.91× | 1.74× | 1.04× | 1.87× | 1.80× |
| 8: 1000 UPDATEs without an index | 1.02× | 1.26× | 1.23× | 1.00× | 1.24× | 1.23× |
| 9: 25000 UPDATEs with an index | 1.47× | 2.22× | 1.51× | 1.08× | 1.83× | 1.69× |
| 10: 25000 text UPDATEs with an index | 1.72× | 2.49× | 1.45× | 1.06× | 1.71× | 1.61× |
| **11: INSERTs from a SELECT** | 4.82× | 6.86× | 1.42× | 0.99× | 1.72× | 1.74× |
| 12: DELETE without an index | 1.17× | 2.18× | 1.87× | 0.99× | 1.33× | 1.35× |
| 13: DELETE with an index | 1.35× | 3.65× | 2.70× | 0.96× | 1.63× | 1.70× |
| **14: A big INSERT after a big DELETE** | 3.14× | 4.60× | 1.46× | 1.18× | 1.62× | 1.37× |
| 15: A big DELETE followed by many small INSERTs | 1.29× | 2.20× | 1.70× | 1.00× | 1.56× | 1.56× |
| 16: DROP TABLE | 5.69× | 4.73× | 0.83× | 4.53× | 3.24× | 0.72× |
| **Suite total** | 1.68× | 2.52× | 1.50× | 1.05× | 1.65× | 1.57× |

On disk PGlite OPFS is within 8% of PGlite Memory on every row but 2.1 (1.14×), 6 (1.14×), 14
(1.18×) and 16 (4.53×, DROP TABLE: 23 ms against 5). The pgrust multiple over PGlite OPFS is now also
the multiple over PGlite Memory, to within 5% on the Suite (1.57× and 1.65×), which the store-levers
note §8 already found in its own disk lane (1.56× and 1.61–1.66× for its unmodified arm).

## 6. What the lane changed, per column

The same column's median in the new lane over its median in the old one:

| Benchmark | PGlite Memory | PGlite OPFS repacked (relaxed) | pgrust Postmaster OPFS repacked (relaxed) |
| --- | --- | --- | --- |
| **1: 1000 INSERTs** | 1.03× | 0.75× | 0.49× |
| **2: 25000 INSERTs in a transaction** | 1.00× | 0.80× | 0.98× |
| 2.1: 25000 INSERTs in single statement | 1.03× | 0.65× | 0.53× |
| 3: 25000 INSERTs into an indexed table | 1.01× | 0.44× | 0.47× |
| 3.1: 25000 INSERTs into an indexed table in single statement | 0.99× | 0.53× | 0.45× |
| 4: 100 SELECTs without an index | 0.98× | 0.98× | 1.03× |
| 5: 100 SELECTs on a string comparison | 1.00× | 1.00× | 0.99× |
| **6: Creating an index** | 1.00× | 0.40× | 0.33× |
| 7: 5000 SELECTs with an index | 1.00× | 0.95× | 0.98× |
| 8: 1000 UPDATEs without an index | 0.99× | 0.97× | 0.98× |
| 9: 25000 UPDATEs with an index | 1.02× | 0.75× | 0.84× |
| 10: 25000 text UPDATEs with an index | 1.00× | 0.62× | 0.69× |
| **11: INSERTs from a SELECT** | 0.99× | 0.20× | 0.25× |
| 12: DELETE without an index | 0.99× | 0.83× | 0.60× |
| 13: DELETE with an index | 1.00× | 0.71× | 0.45× |
| **14: A big INSERT after a big DELETE** | 1.02× | 0.38× | 0.36× |
| 15: A big DELETE followed by many small INSERTs | 1.03× | 0.80× | 0.73× |
| 16: DROP TABLE | 1.06× | 0.85× | 0.73× |
| **Suite total** | 1.00× | 0.63× | 0.65× |

PGlite Memory does not move (0.98–1.06× on every row), which is the control: the lane changed
nothing but OPFS. Every OPFS row that moves, moves the same way for both engines, and by roughly the
same amount (0.63× and 0.65× of the Suite). The pgrust column gains more than PGlite on rows 1, 2.1,
3.1, 6, 12, 13, 15 and 16 and less on 2, 9, 10 and 11. Row 2 (one transaction of 25 000 INSERTs)
hardly moves for pgrust (0.98×) against 0.80× for PGlite; this note did not look at why.

## 7. RTT and Concurrency, one Run per lane

`--configurations pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed --baseline
pglite-opfs-repacked-relaxed`, because a flush only shows on commit-heavy Suites. RTT at the defined
100 iterations, milliseconds per statement:

| Statement | ephemeral: PGL-OPFS | ephemeral: pgrust | ÷ | persistent: PGL-OPFS | persistent: pgrust | ÷ |
| --- | --- | --- | --- | --- | --- | --- |
| 1: insert small row | 0.726 | 1.595 | 2.20× | 0.340 | 1.172 | 3.45× |
| 2: select small row | 0.266 | 0.335 | 1.26× | 0.313 | 0.396 | 1.27× |
| 3: update small row | 0.375 | 0.510 | 1.36× | 0.404 | 0.484 | 1.20× |
| 4: delete small row | 0.844 | 2.358 | 2.79× | 0.569 | 2.194 | 3.86× |
| 5: insert 1kb row | 0.745 | 0.947 | 1.27× | 0.295 | 0.787 | 2.67× |
| 6: select 1kb row | 0.449 | 1.082 | 2.41× | 0.424 | 1.027 | 2.42× |
| 7: update 1kb row | 0.757 | 1.121 | 1.48× | 0.327 | 0.853 | 2.61× |
| 8: delete 1kb row | 0.808 | 1.365 | 1.69× | 0.530 | 1.143 | 2.16× |
| 9: insert 10kb row | 0.777 | 0.879 | 1.13× | 0.430 | 0.789 | 1.83× |
| 10: select 10kb row | 0.405 | 0.773 | 1.91× | 0.456 | 0.705 | 1.55× |
| 11: update 10kb row | 0.323 | 0.330 | 1.02× | 0.323 | 0.345 | 1.07× |
| 12: delete 10kb row | 0.755 | 1.082 | 1.43× | 0.417 | 1.030 | 2.47× |
| **sum of the 12** | 7.23 | 12.38 | 1.71× | 4.83 | 10.93 | 2.26× |

The statements that were under 0.5 ms in the old lane — the three selects and the small- and
10 kB-row updates — stay where they were, in both columns. The inserts, the deletes and the 1 kB
update, 0.73–0.84 ms on PGlite OPFS in the old lane, are where it moved: PGlite gains 0.28–0.45 ms on
each (its inserts and 1 kB update halve, 0.73–0.78 → 0.30–0.43 ms), pgrust 0.05–0.42 ms. pgrust's
commits reach the store through the broker, and on disk a store flush is an `fdatasync` of
1.3–1.5 ms (store-levers §3); relaxed PGlite amortises its flushes. The store-levers note §8 measured
the same thing from the other side: in its disk lane `fsync=off` took the pgrust RTT sum from 11.62
to 8.89 ms.

Concurrency, four Clients (Test 4 in transactions/s, higher is better; the rest in ms):

| Test | ephemeral: PGL-OPFS | ephemeral: pgrust | persistent: PGL-OPFS | persistent: pgrust |
| --- | --- | --- | --- | --- |
| 1: Read fan-out — 4 clients x 500 point SELECTs, total wall | 658.6 | 792.7 | 663.1 | 763.2 |
| 2: Reader under a bulk write — reader p95 while 25000 rows are inserted | 1452.1 | 0.420 | 698.5 | 0.430 |
| 3: Short queries beside a long one — short p95 during one long query | 277.7 | 0.485 | 281.3 | 0.530 |
| 4: Writers on disjoint rows — transactions/s (higher is better) | 930.8 | 2233.4 | 1654.2 | 2973.1 |
| 5: Writers on the same row — p95 of 200 short transactions each | 4.590 | 4.735 | 2.970 | 3.755 |

Test 2's PGlite reader p95 halves because it is the whole 25 000-row bulk write (a PGlite reader waits
for the writer's transaction), and that write got faster. Test 4 is the commit-heavy one: both columns
gain (PGlite 1.78×, pgrust 1.33×), so pgrust's lead there shrinks from 2.40× to 1.80×. Test 5's p95
falls in both. Test 1 is reads and moves by under 4%. One Run per lane, so only the direction of
Tests 2, 4 and 5 is claimed, and their size loosely.

## 8. Which notes quote the old lane

A dated pointer to this note went under the H1 of every note that states a headless Chromium OPFS
figure as a result, and of `README.md` once, under **Results**; no number in any of them was changed:

- the four `2026-09-06-chromium-152-linux-{eight,ten,twelve,fourteen}-columns.md` Runs;
- the three probes of 7 September — `2026-09-07-prepared-store.md`,
  `2026-09-07-memory-chromium-152-linux.md` and `2026-09-07-idle-cpu-chromium-linux.md` — whose
  probes now default to the persistent context too and were not re-run;
- `2026-09-16-pgrust-v0.3-rebase.md`, `2026-09-16-wasm-opt-pass.md`,
  `2026-09-18-speed-first-profile.md`, `2026-09-18-portal-source-text-share.md` and
  [`findings/0002`](../findings/0002-pgrust-autocommit-insert-regression.md), whose module A/Bs are
  within one lane but whose totals and ratios carry the per-call bill;
- `2026-09-24-where-the-multiple-lives.md`, whose OPFS rung is that bill, and
  `2026-09-24-store-levers.md`, whose bench lane is now `--ephemeral-context`;
- the three Safari notes, `2026-09-08-webkit-memory-diet.md`, `2026-09-08-safari-concurrency.md` and
  `2026-09-19-safari-27-visible-window.md`, because each also quotes a headless Chromium OPFS figure
  (§3/§6's postmaster totals, the Chromium control lane of §6, and §1's comparison). The last one's
  pointer says the comparison reverses: on disk the Chromium postmaster is 1.62–1.64× PGlite Memory,
  closer to PGlite than Safari's 1.96×. Their Safari figures themselves are untouched by this note.

Left without a pointer: the two `2026-08-29` Runs (Memory columns only), `2026-09-07-datadir-portability.md`,
`2026-09-07-notify-latency-bun.md`, `2026-09-07-pg-dump-over-wire-bun.md`,
`2026-09-07-pgxsinkit-unit-suite-on-pgrust.md`, `2026-09-07-idle-cpu-android-s22.md` (a phone's own
Chrome and profile), `2026-09-08-pgrust-bug-reproductions.md`, `2026-09-08-wasm-size-map.md`,
`2026-09-16-browser-profile.md` (an RTT Run of `pgrust-memory` only) and
[`findings/0001`](../findings/0001-pgrust-multi-statement-memory.md): none states a headless Chromium
OPFS number.

## 9. What this does not show

- **Other browsers.** Only Chromium was measured. `--browser firefox` takes the same path (Firefox's
  own `launchPersistentContext`, with `FIREFOX_USER_PREFS`), but Playwright's Firefox build
  (`firefox-1532`) is not installed on this box, so that lane has not run; WebKit is still skipped
  before launch. Firefox and WebKit implement OPFS separately and nothing here says what their
  private or automation contexts do with it.
- **The published site.** The GitHub Pages page runs in the visitor's own browser profile, so its
  numbers were never taken in an off-the-record context — unless the visitor opened it in a private
  window, which by §1's reading is exactly the old lane.
- **Safari.** The Safari notes were driven by `safaridriver`. Whether a WebDriver session's website
  data is ephemeral, and whether an ephemeral Safari session keeps OPFS in memory, is unknown; nothing
  here was measured on Safari.
- **The mechanism, fully.** §1 read Chromium main, not the 149 branch, skipped one link
  (`StoragePartitionConfig`) and did not trace the browser process; what ties it to 149 is the empty
  profile and the timings.
- **Round 2's persistent pgrust Run** (§4) is unexplained.
- **Any Configuration beyond these three,** and the probes. The four other OPFS columns, the memory
  probe, the idle-CPU probe and the prepared-store probe were not re-run in the new lane (one
  untimed `probe:memory` smoke of PGlite OPFS aside).
- **Another machine or disk.** One i7-1165G7, one ext4 volume on one SSD. The on-disk cost of a flush
  is a property of the disk; a phone's is not this.
- **Every earlier conclusion.** The pointers say which notes quoted a number from the old lane; none
  of their conclusions was re-derived here.

## Reproduction

In this repo, from the root, with the published modules in `dist/pgrust/`:

```
# the old lane and the new one, one Run each (the brief's Speedtest arm)
bun run bench --no-build --suite speedtest \
  --configurations pglite-memory,pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed \
  --baseline pglite-memory --ephemeral-context
bun run bench --no-build --suite speedtest \
  --configurations pglite-memory,pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed \
  --baseline pglite-memory
# RTT and Concurrency, per lane (add --ephemeral-context for the old one)
bun run bench --no-build --suite rtt \
  --configurations pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed \
  --baseline pglite-opfs-repacked-relaxed
bun run bench --no-build --suite concurrency \
  --configurations pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed \
  --baseline pglite-opfs-repacked-relaxed

# the gated, interleaved campaign and its tables (scratch, untracked)
tmp/agents/persist/ab.sh      # r1 eph, per; r2 per, eph; RTT eph, per; Concurrency per, eph
tmp/agents/persist/ab2.sh r3-eph-speedtest r3-per-speedtest r4-per-speedtest r4-eph-speedtest
bun tmp/agents/persist/tables.ts
# section 1's profile watch: run a bench in the background and pass its pid
tmp/agents/persist/poll-fs.sh <bench pid> <out file>
```
