# Store levers: in the bench's off-the-record context every OPFS call is an IPC, and making fewer of them takes pgrust to 0.96× PGlite OPFS; on a disk-backed profile the 1.5× is not the store's

> **2026-09-24 (later): `bun run bench` now runs §8's disk lane by default.** §3's off-the-record
> context is kept as `--ephemeral-context`, so this note's "bench lane" figures (§4–§7, §10–§12) are
> that lane's, and the owner's target was set in it. What the move changes on the three columns this
> note used: [2026-09-24, the persistent context](2026-09-24-persistent-context.md). No number here
> was changed.

- Date: 2026-09-24
- Machine: i7-1165G7 (8 logical cores), 30 GiB, Linux 7.0.0-34-generic, as in
  [the note this follows](2026-09-24-where-the-multiple-lives.md). A qemu VM took about one core
  throughout and other agents' Playwright and vite runs came and went; every timed Run waited for a
  1-minute load under 2.5 (§1).
- Browser: headless **Chromium 149.0.7827.55** (Playwright 1.61.1), the page and static server
  `bun run bench` uses (`serveDist` from `scripts/bench.ts`), driven one Configuration per Run by
  `tmp/agents/levers/arms.ts`, which also reads the page's engine stats (the wasm memory high-water
  mark) and, with the scratch switch on, the store counts.
- Engines: the published pgrust modules (threads `df17f7e24a33…`, single-session `0d772984de72…`,
  `spike/wasip1-threads@569d16128c`), sha-verified before and after every Run and never replaced;
  `@pgxsinkit/pglite 0.5.5-pgx.3` (PostgreSQL 18.3); the pgrust broker columns load the pre-release
  store bundle (pgxsinkit `06ba3690`), the PGlite OPFS column the published
  `@pgxsinkit/pglite-opfs-repacked 0.3.0`.
- Instrumentation and prototypes: an uncommitted patch to this repo's `src/`
  (`tmp/agents/levers/instrumentation.patch`), behind `?brokerCounts=1` and `?storeLevers=`; without
  them the page runs what `main` runs. No pgrust file was edited. Raw artefacts, drivers and every
  table's generator: `tmp/agents/levers/` (untracked).
- Nothing was adopted. The one tracked change is `bun run bench --postmaster-tuning`, which puts the
  page's own `?postmasterTuning=` on the URL.

## What this answers

[The previous note](2026-09-24-where-the-multiple-lives.md) found that on the worst Speedtest rows the
multiple over PGlite is paid in the OPFS store: the OPFS rung cost 3.1–6.7×, and inside the guest the
largest single item was the backend waiting on the store broker, mostly zero-filling new 16 MB WAL
segments and zero-extending relations. It also found the two guests run different settings. This note
measures the levers that points at, one arm at a time, then in combination, and ranks them against
the owner's target: the Speedtest Suite total of `pgrust-postmaster-opfs-repacked-relaxed` at or
below `pglite-opfs-repacked-relaxed` in headless Chromium on this box, with the pgrust shared memory
under 300 MiB and RTT and Concurrency not regressing.

**Three findings.**

1. **The bench lane runs OPFS in an off-the-record browser context, where one synchronous access
   handle call costs 0.2–0.4 ms and a flush costs microseconds.** `bun run bench` opens its page with
   Playwright's `browser.newContext()`. The same page in a persistent (disk-backed) context pays
   12–16 µs per call and 1.3–1.5 ms per flush (§3). So the OPFS rung the previous note measured is a
   per-call bill: what the store costs is how many calls it makes, not how many bytes or fsyncs.
2. **In that lane the target is reachable, and store-side levers are what reach it.** Two settings
   (`wal_init_zero=off,wal_buffers=4MB`, arm **S6**) take pgrust from 1.53–1.56× to 1.25–1.28× PGlite
   OPFS. Four prototype changes to how the store talks to OPFS, on top of S6 (arm **S6H4**), take it to
   **0.962–0.967× in four rounds**, at 266.4 MiB, with all 18 rows, and without an RTT or Concurrency
   regression beyond the default's own spread (§4, §10). S6H4 is within 3% of the same server with its
   store on the coordinator's heap (MB6, other rounds): those levers remove the OPFS rung almost
   entirely.
3. **Neither the stretch target nor a disk-backed profile moves with these levers.** Against PGlite
   Memory S6H4 is 1.59–1.63×, and the heap-store floor is 1.58×. On a disk-backed profile OPFS costs
   PGlite 3–7% and every pgrust arm is 1.46–1.59× PGlite OPFS (§8). What is left is the guest: rows
   1, 2, 4, 7, 9 and 10, where under S6H4 the backend waits on the store for 2–5% of the row (24% on
   row 1).

## Method

- **Arms** (§2) are `?postmasterTuning=` strings on the one pgrust column (settings, S0–S7) and
  `?storeLevers=` prototypes (H1, U1–U4), each a URL on the same build, one Configuration per Run.
- **Controls**: `pglite-opfs-repacked-relaxed` (PGL-OPFS) and `pglite-memory` (PGL-MEM) in every round.
- **Rounds**: 1 and 2 ran every single arm, round 2 in reverse order. S6 was then defined from them
  (the settings that won on their own and fit the memory ceiling together), and rounds 3–8 ran the
  combinations beside their own controls and S0, each pair of rounds in opposite orders. Rounds 7
  and 8 hold every headline arm together.
- **Counts** (Part B): with `?brokerCounts=1` every agent's broker client counts its requests by kind,
  bytes and round-trip time into the broker's own doorbell SharedArrayBuffer (one slot per channel),
  the coordinator times every store call and every synchronous access handle call by the store's own
  label, and the Engine worker snapshots all of it around each `measure`. PGlite's in-process store
  is counted at the access-handle level. Every pgrust arm Run carries counts; S0p is S0 without them.
- **Coordinator profile**: V8's sampling profiler at 100 µs on the storage coordinator worker (a
  nested worker, reached through a raw CDP session), sliced by the rows' windows (§6).
- **Disk lane**: the same arms in a persistent Playwright context on a fresh user-data directory,
  two rounds (§8).
- **Load gate**: every timed Run started only with the 1-minute load under 2.5, checked every 15 s
  for at most 10 minutes. Profiled Runs are not timed Runs and are reported only as profiles.

## 1. Environment and load

117 timed Runs. None hit the 10-minute cap; the longest wait was 390 s. The 1-minute load before →
after every timed Run (`tables-*.md`, "Load"): median 2.18 before, highest 2.48 before and 3.93 after.

| rounds | Runs (load before → after) |
| --- | --- |
| r1 | PGL-OPFS 2.18 → 2.39 (waited 225 s), PGL-MEM 2.39 → 2.33, S0 2.33 → 2.92, S0p 2.46 → 2.46, S1 2.46 → 3.57, S2 2.42 → 2.91, S3 2.41 → 2.42, S4 2.42 → 2.68, S5 2.31 → 2.37 (failed to boot, §9), S7 2.37 → 1.87, H1 1.87 → 1.95, U1 1.95 → 2.08, U2 2.08 → 2.34, U3 2.34 → 2.84, HALL 2.37 → 2.53, PGL-OPFS-Ux 2.04 → 1.88, MB 1.88 → 2.13, S4b 2.13 → 2.01 |
| r2 | MB 1.78 → 2.21, PGL-OPFS-Ux 2.21 → 2.78, HALL 2.39 → 3.08, U3 2.38 → 2.30, U2 2.30 → 2.31, U1 2.31 → 2.68, H1 2.12 → 2.20, S7 2.20 → 1.98, S4 1.98 → 2.47, S3 2.47 → 2.68, S2 2.09 → 2.69, S1 2.17 → 2.35, S0p 2.35 → 2.58, S0 2.38 → 2.59, PGL-MEM 2.09 → 2.00, PGL-OPFS 2.00 → 1.80 |
| r3 / r4 | PGL-OPFS 1.30 → 1.89 / 2.37 → 2.53, S0 1.89 → 1.88 / 2.39 → 2.37, S6 1.81 → 1.86 / 2.19 → 2.39, S6H 1.86 → 2.36 / 1.90 → 2.19, HALL 2.25 → 1.97 / 2.16 → 1.90, PGL-OPFS-U 1.97 → 2.83 / 2.41 → 2.16, MB6 2.40 → 2.86 / 1.83 → 2.41, PGL-MEM 2.39 → 2.33 / 1.89 → 1.83 |
| r5 / r6 | PGL-OPFS 1.20 → 1.73 / 2.15 → 2.03, U4 1.73 → 2.75 / 2.13 → 2.15, S6H 2.29 → 2.70 / 2.25 → 2.13, S6H4 2.18 → 2.00 / 1.64 → 2.25, PGL-OPFS-U4 2.00 → 1.92 / 1.73 → 1.64, PGL-MEM 1.92 → 1.78 / 1.78 → 1.73 |
| r7 / r8 | PGL-OPFS 1.85 → 2.26 / 2.05 → 2.00, S0 2.26 → 2.22 / 2.27 → 2.05, S6 2.22 → 2.44 / 2.07 → 2.82, S6H1 2.44 → 2.88 / 2.04 → 2.07, S6H4 2.32 → 2.11 / 2.21 → 2.62, PGL-MEM 2.11 → 2.01 / 2.01 → 3.34 |
| disk d1 / d2 | PGL-OPFS 1.98 → 1.91 / 2.14 → 2.26, PGL-MEM 1.91 → 2.39 / 2.17 → 2.14, S0 2.39 → 2.16 / 2.46 → 2.79, S1 2.16 → 2.05 / 2.26 → 2.46, S6 2.05 → 2.50 / 1.98 → 2.26, S6F 2.09 → 2.46 / 2.18 → 1.98, S6H1 2.46 → 3.93 / 2.24 → 2.18, S6H4 2.45 → 2.33 / 2.23 → 2.24, S6HF4 2.33 → 3.14 / 2.40 → 2.23, PGL-OPFS-U4 2.48 → 3.28 (waited 390 s) / 2.42 → 2.40 |
| gate, bench | RTT r1: PGL-OPFS 1.65 → 1.83, S0 1.83 → 1.85, S6 1.85 → 2.35, S6H4 2.35 → 2.24; RTT r2: S6H4 2.00 → 2.00, S0 2.00 → 2.32; Concurrency r1: S6H4 2.24 → 2.80, S6 2.26 → 2.35, S0 2.35 → 2.82, PGL-OPFS 2.27 → 2.35; r2: S0 2.37 → 2.91, S6H4 2.26 → 2.15; r3: S0 1.46 → 1.69, S6H4 1.69 → 1.91 |
| gate, disk | RTT: PGL-OPFS 2.05 → 2.29, S0 2.29 → 2.74, S6H4 2.14 → 2.61, S6HF4 2.31 → 2.85; Concurrency: S6HF4 2.28 → 2.10, S6H4 2.10 → 2.33, S0 2.33 → 2.52, PGL-OPFS 2.10 → 2.25 |
| counts | PGL-OPFS with counts (r1): 1.89 → 2.12 |

**S0 reproduces the previous note's column within its own spread.** S0 ran 20 473–20 617 ms in rounds
2–8 and 24 392 ms in round 1 (S0p 21 617 and 20 359); the previous note measured 28 397 and 22 280 ms
and the 19 September note 19 061 and 19 012. Round 1's S0 is the one outlier of the campaign (its row 6
is 296 ms against 141–185 everywhere else), so single arms are compared with the mean of S0 and S0p of
their own round, and round 2 alone is the conservative reading.

**The counts cost at most 2% of the coordinator's time** (the counting wrapper's self time is 1.5–2.2%
of the coordinator's row windows in the profile, §6), and S0 against S0p in round 2 is 20 617 against
20 359 ms.

## 2. The arms

| arm | what it moves | where it would live |
| --- | --- | --- |
| S0 | nothing (counts on); S0p: nothing, counts off | – |
| S1 | `fsync=off` | host settings (the strict column would keep fsync) |
| S2 | `wal_init_zero=off` | host settings |
| S3 | `wal_buffers=4MB` | host settings |
| S4 / S4b | `shared_buffers=64MB` / `shared_buffers=128MB` | host settings |
| S5 | `file_extend_method=posix_fallocate` | cannot be set (§9) |
| S7 | `wal_recycle=off,min_wal_size=32MB` | host settings |
| **S6** | `wal_init_zero=off,wal_buffers=4MB`: the settings that won alone (S2, S3); S1 and S7 did not win, S5 cannot be set, and S4 at 64 MB would take S3's 6 MiB past the 300 MiB ceiling for a smaller gain | host settings |
| H1 | `gather,payload:262144`: one broker write per `fd_pwrite` instead of one per iovec, and 256 KiB channel payloads instead of 64 KiB | host (`wasm/broker-fs.js`, the engine's channels) |
| U1 | `grow:4194304`: the arena file grows by truncate in 4 MiB chunks, not one 8 KiB extent at a time; the store is told its own logical size | store |
| U2 | `coalesce`: contiguous arena writes inside one store call go out as one access-handle write | store |
| U3 | `zeroskip`: an all-zero arena write past everything ever written to the file is dropped (those bytes are zero already: the file only grew there by truncate) | store |
| U4 | `metacoalesce`: contiguous metadata-log appends are held across store calls and written as one, always after every held arena write, and before anything else touches the metadata file | store |
| HALL | H1 + U1 + U2 + U3 on the defaults | host + store |
| S6H1 | S6 + H1: everything that is ours alone | host |
| S6H | S6 + H1 + U1 + U2 + U3 | host + store |
| **S6H4** | S6 + H1 + U1 + U2 + U3 + U4: the final combined arm | host + store |
| S6F, S6HF4 | S6 and S6H4 plus `fsync=off` (disk lane) | |
| MB, MB6 | `pgrust-postmaster-memory-broker` (store on the coordinator's heap), with nothing moved / with S6 + H1 | the floor under the OPFS column |
| PGL-OPFS-U, PGL-OPFS-U4 | PGlite OPFS with U1–U3 / U1–U4 applied to its own access handles (the store is shared: an upstream change moves both columns) | store |

The store levers are prototypes in the broker's host: a wrapper module that re-exports the store bundle
and wraps its OPFS port and WASI adapter (`src/client/store-counters.ts` in the patch). PGlite's column
gets the same arena shim around its access handles. PGL-OPFS-Ux (rounds 1–2 only) held PGlite's arena
writes across store calls rather than within one, which pgrust's coordinator does not; it is kept for
the record and not used.

## 3. What one OPFS call costs: the bench lane is an off-the-record context

Whole Suite, every row summed (`perop.md`, `perop.ts`). The disk lane is the same page in a persistent
Playwright context, which puts OPFS on disk.

| Run | arena write, per call | arena grow (truncate) | metadata write | flush | arena read | broker requests | mean round trip | coordinator service per request |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S0, bench r7 | **334 µs** (7.7 KiB, 16 965×) | 215 µs (9 590×) | 369 µs (1 161×) | **5 µs** (153×) | 292 µs | 13 458 | 719 µs | 649 µs |
| S0, bench r8 | 338 µs (16 959×) | 219 µs | 353 µs | 4 µs | 338 µs | 13 511 | 720 µs | 655 µs |
| S0, disk d1 | **14 µs** (7.8 KiB, 16 874×) | 13 µs | 13 µs | **1 459 µs** (132×) | 16 µs | 14 133 | 98 µs | 67 µs |
| S0, disk d2 | 14 µs | 14 µs | 13 µs | 1 331 µs | 15 µs | 14 192 | 98 µs | 65 µs |
| S6H4, bench r7 | 497 µs (61.1 KiB, 929×) | 7 100 µs (10×, 4 MiB each) | 863 µs (62×) | 3 µs | 371 µs | 5 501 | 245 µs | 183 µs |
| S6H4, disk d1 | 34 µs (52.0 KiB, 1 092×) | 93 µs (10×) | 37 µs (65×) | 1 263 µs | 14 µs | 5 663 | 144 µs | 94 µs |
| PGlite OPFS, bench r1 (counts) | 364 µs (10.6 KiB, 12 418×) | 321 µs (1 202×) | 354 µs (1 133×) | 3 µs | 252 µs | in process | – | – |

A write of 61 KiB costs 1.5× a write of 7.7 KiB in the bench lane, so the cost is per call. A flush
costs 3–5 µs there and 1.3–1.5 ms on disk. This is consistent with an off-the-record profile keeping
OPFS in memory in the browser process and serving each access-handle call as a round trip to it, and
with a persistent profile handing the renderer a real file. The mechanism is inferred from these
timings. Neither Chromium's source nor a trace of the browser process was read.

Two consequences run through the rest of this note. In the bench lane, the store's cost is its number
of calls, and `fsync` costs nothing. On disk, an access-handle call costs 12–16 µs, a broker request's
round trip ~100 µs (two thirds of it the coordinator's own service), and a flush over a millisecond.

## 4. Results in the bench lane

### 4.1 All 18 rows: the controls, S0, S6, S6H1 and S6H4 in rounds 7 and 8

Milliseconds, r7 / r8; round 7 ran the columns left to right, round 8 right to left.

| Benchmark | PGL-MEM | PGL-OPFS | S0 | S6 | S6H1 | S6H4 |
| --- | --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 61.5 / 58.6 | 100.9 / 95.6 | 578.6 / 618.8 | 606.5 / 599.7 | 602.0 / 632.9 | 353.2 / 347.7 |
| 2: 25000 INSERTs in a transaction | 630.4 / 602.4 | 815.5 / 778.8 | 1140.6 / 1174.2 | 1105.9 / 1145.7 | 1321.2 / 1138.2 | 1074.7 / 1060.0 |
| 2.1: 25000 INSERTs in single statement | 150.8 / 143.4 | 288.3 / 271.0 | 509.7 / 483.4 | 484.3 / 484.9 | 467.7 / 500.4 | 234.3 / 261.0 |
| 3: 25000 INSERTs into an indexed table | 817.3 / 772.7 | 1975.5 / 1910.5 | 3082.0 / 3003.1 | 1950.9 / 1803.0 | 1956.8 / 1899.4 | 1291.0 / 1252.8 |
| 3.1: 25000 INSERTs into an indexed table in single statement | 180.4 / 179.3 | 344.8 / 340.7 | 663.2 / 623.0 | 599.0 / 643.2 | 640.6 / 635.1 | 316.4 / 298.8 |
| 4: 100 SELECTs without an index | 328.5 / 340.3 | 351.1 / 321.9 | 453.8 / 441.9 | 445.3 / 457.5 | 472.1 / 478.6 | 424.3 / 466.1 |
| 5: 100 SELECTs on a string comparison | 844.3 / 885.8 | 877.3 / 878.2 | 808.7 / 835.3 | 780.7 / 833.5 | 852.5 / 854.8 | 854.7 / 758.6 |
| **6: Creating an index** | 39.6 / 31.2 | 86.9 / 123.7 | 148.1 / 170.4 | 184.8 / 151.7 | 152.7 / 156.3 | 83.5 / 83.9 |
| 7: 5000 SELECTs with an index | 504.5 / 524.3 | 587.3 / 543.2 | 921.1 / 968.6 | 979.6 / 962.6 | 983.3 / 1003.6 | 936.2 / 909.8 |
| 8: 1000 UPDATEs without an index | 174.9 / 204.8 | 184.1 / 180.5 | 233.0 / 227.9 | 226.5 / 221.8 | 250.2 / 249.6 | 225.7 / 223.6 |
| 9: 25000 UPDATEs with an index | 1467.5 / 1477.5 | 2095.3 / 2094.7 | 3299.2 / 3385.8 | 3255.8 / 3227.1 | 3253.3 / 3344.2 | 2786.8 / 2771.6 |
| 10: 25000 text UPDATEs with an index | 1911.2 / 1902.3 | 3206.6 / 3193.0 | 4865.8 / 4748.3 | 3616.4 / 3644.5 | 3688.4 / 3695.1 | 3079.6 / 3069.1 |
| **11: INSERTs from a SELECT** | 300.0 / 307.8 | 1521.5 / 1491.5 | 2217.8 / 2263.2 | 1047.2 / 1104.4 | 1063.7 / 1038.4 | 455.8 / 424.5 |
| 12: DELETE without an index | 24.8 / 24.1 | 28.0 / 27.4 | 57.4 / 51.6 | 53.7 / 55.7 | 51.9 / 44.8 | 43.8 / 35.0 |
| 13: DELETE with an index | 33.3 / 32.2 | 41.4 / 44.5 | 122.5 / 128.6 | 104.9 / 147.6 | 119.9 / 113.4 | 65.5 / 52.0 |
| **14: A big INSERT after a big DELETE** | 172.7 / 171.7 | 564.2 / 570.7 | 841.2 / 847.5 | 856.0 / 835.3 | 825.1 / 809.5 | 313.2 / 347.2 |
| 15: A big DELETE followed by many small INSERTs | 273.3 / 276.0 | 346.9 / 334.7 | 555.4 / 593.9 | 508.6 / 541.6 | 548.4 / 558.7 | 372.7 / 378.4 |
| 16: DROP TABLE | 5.4 / 5.3 | 25.9 / 25.8 | 24.8 / 27.5 | 23.9 / 25.5 | 29.5 / 23.9 | 17.0 / 22.3 |
| **Suite total** | 7920.3 / 7939.9 | 13441.6 / 13226.2 | 20522.8 / 20593.2 | 16830.1 / 16885.0 | 17279.4 / 17176.9 | **12928.4 / 12762.5** |

S0 and S6 against both controls, per round (the brief's comparison), and S6H4 beside them:

| Benchmark | S0 ÷ PGL-OPFS | S0 ÷ PGL-MEM | S6 ÷ PGL-OPFS | S6 ÷ PGL-MEM | S6H4 ÷ PGL-OPFS | S6H4 ÷ PGL-MEM |
| --- | --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 5.74× / 6.47× | 9.40× / 10.56× | 6.01× / 6.27× | 9.85× / 10.23× | 3.50× / 3.64× | 5.74× / 5.93× |
| 2: 25000 INSERTs in a transaction | 1.40× / 1.51× | 1.81× / 1.95× | 1.36× / 1.47× | 1.75× / 1.90× | 1.32× / 1.36× | 1.70× / 1.76× |
| 2.1: 25000 INSERTs in single statement | 1.77× / 1.78× | 3.38× / 3.37× | 1.68× / 1.79× | 3.21× / 3.38× | 0.81× / 0.96× | 1.55× / 1.82× |
| 3: 25000 INSERTs into an indexed table | 1.56× / 1.57× | 3.77× / 3.89× | 0.99× / 0.94× | 2.39× / 2.33× | 0.65× / 0.66× | 1.58× / 1.62× |
| 3.1: 25000 INSERTs into an indexed table in single statement | 1.92× / 1.83× | 3.68× / 3.48× | 1.74× / 1.89× | 3.32× / 3.59× | 0.92× / 0.88× | 1.75× / 1.67× |
| 4: 100 SELECTs without an index | 1.29× / 1.37× | 1.38× / 1.30× | 1.27× / 1.42× | 1.36× / 1.34× | 1.21× / 1.45× | 1.29× / 1.37× |
| 5: 100 SELECTs on a string comparison | 0.92× / 0.95× | 0.96× / 0.94× | 0.89× / 0.95× | 0.92× / 0.94× | 0.97× / 0.86× | 1.01× / 0.86× |
| **6: Creating an index** | 1.70× / 1.38× | 3.74× / 5.46× | 2.13× / 1.23× | 4.67× / 4.86× | **0.96× / 0.68×** | 2.11× / 2.69× |
| 7: 5000 SELECTs with an index | 1.57× / 1.78× | 1.83× / 1.85× | 1.67× / 1.77× | 1.94× / 1.84× | 1.59× / 1.68× | 1.86× / 1.74× |
| 8: 1000 UPDATEs without an index | 1.27× / 1.26× | 1.33× / 1.11× | 1.23× / 1.23× | 1.29× / 1.08× | 1.23× / 1.24× | 1.29× / 1.09× |
| 9: 25000 UPDATEs with an index | 1.57× / 1.62× | 2.25× / 2.29× | 1.55× / 1.54× | 2.22× / 2.18× | 1.33× / 1.32× | 1.90× / 1.88× |
| 10: 25000 text UPDATEs with an index | 1.52× / 1.49× | 2.55× / 2.50× | 1.13× / 1.14× | 1.89× / 1.92× | 0.96× / 0.96× | 1.61× / 1.61× |
| **11: INSERTs from a SELECT** | 1.46× / 1.52× | 7.39× / 7.35× | 0.69× / 0.74× | 3.49× / 3.59× | **0.30× / 0.28×** | 1.52× / 1.38× |
| 12: DELETE without an index | 2.05× / 1.89× | 2.32× / 2.14× | 1.92× / 2.04× | 2.17× / 2.31× | 1.56× / 1.28× | 1.77× / 1.45× |
| 13: DELETE with an index | 2.96× / 2.89× | 3.67× / 3.99× | 2.53× / 3.31× | 3.15× / 4.58× | 1.58× / 1.17× | 1.96× / 1.61× |
| **14: A big INSERT after a big DELETE** | 1.49× / 1.49× | 4.87× / 4.93× | 1.52× / 1.46× | 4.96× / 4.86× | **0.56× / 0.61×** | 1.81× / 2.02× |
| 15: A big DELETE followed by many small INSERTs | 1.60× / 1.77× | 2.03× / 2.15× | 1.47× / 1.62× | 1.86× / 1.96× | 1.07× / 1.13× | 1.36× / 1.37× |
| 16: DROP TABLE | 0.96× / 1.07× | 4.63× / 5.23× | 0.92× / 0.99× | 4.46× / 4.84× | 0.66× / 0.86× | 3.17× / 4.23× |
| **Suite total** | **1.53× / 1.56×** | 2.59× / 2.59× | **1.25× / 1.28×** | 2.12× / 2.13× | **0.96× / 0.96×** | 1.63× / 1.61× |

S0 and S6 also met in rounds 3 and 4: S0 20 568 / 20 473 ms (1.53× / 1.54× PGL-OPFS), S6 16 903 /
16 858 ms (1.26× / 1.27×), and S6 was 0.82× S0 in all four rounds it shared with S0.

### 4.2 Every arm: rows 11, 6, 14 and the Suite

Milliseconds in two rounds, and the ratio to each control of the same round. Single arms ran in
rounds 1 and 2; the combinations in the rounds named.

| arm (rounds) | row 11 | ÷ OPFS | ÷ Mem | row 6 | ÷ OPFS | ÷ Mem | row 14 | ÷ OPFS | ÷ Mem | Suite | ÷ OPFS | ÷ Mem |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PGL-MEM (r1/r2) | 315.6 / 308.5 | 0.16× / 0.20× | 1 | 33.6 / 31.4 | 0.30× / 0.36× | 1 | 186.0 / 167.5 | 0.24× / 0.30× | 1 | 8360.6 / 8064.9 | 0.52× / 0.60× | 1 |
| PGL-OPFS (r1/r2) | 1917.5 / 1512.0 | 1 | 6.08× / 4.90× | 110.2 / 88.3 | 1 | 3.28× / 2.81× | 782.8 / 564.3 | 1 | 4.21× / 3.37× | 15944.3 / 13363.2 | 1 | 1.91× / 1.66× |
| S0 (r1/r2) | 2352.7 / 2334.2 | 1.23× / 1.54× | 7.45× / 7.57× | 296.3 / 148.3 | 2.69× / 1.68× | 8.82× / 4.72× | 899.9 / 841.7 | 1.15× / 1.49× | 4.84× / 5.02× | 24391.7 / 20617.3 | 1.53× / 1.54× | 2.92× / 2.56× |
| S0p (r1/r2) | 2406.2 / 2248.2 | 1.25× / 1.49× | 7.62× / 7.29× | 160.3 / 141.2 | 1.45× / 1.60× | 4.77× / 4.50× | 1096.8 / 828.5 | 1.40× / 1.47× | 5.90× / 4.95× | 21616.5 / 20359.0 | 1.36× / 1.52× | 2.59× / 2.52× |
| S1 (r1/r2) | 3248.9 / 2366.3 | 1.69× / 1.57× | 10.29× / 7.67× | 191.8 / 153.1 | 1.74× / 1.73× | 5.71× / 4.88× | 1105.4 / 827.8 | 1.41× / 1.47× | 5.94× / 4.94× | 24441.3 / 20593.6 | 1.53× / 1.54× | 2.92× / 2.55× |
| S2 (r1/r2) | 1109.8 / 1080.3 | 0.58× / 0.71× | 3.52× / 3.50× | 151.7 / 160.6 | 1.38× / 1.82× | 4.51× / 5.11× | 871.1 / 930.6 | 1.11× / 1.65× | 4.68× / 5.56× | 17586.3 / 17202.4 | 1.10× / 1.29× | 2.10× / 2.13× |
| S3 (r1/r2) | 2241.3 / 2289.1 | 1.17× / 1.51× | 7.10× / 7.42× | 150.9 / 144.4 | 1.37× / 1.64× | 4.49× / 4.60× | 1028.4 / 842.9 | 1.31× / 1.49× | 5.53× / 5.03× | 19493.4 / 19191.9 | 1.22× / 1.44× | 2.33× / 2.38× |
| S4 (r1/r2) | 2206.7 / 2231.8 | 1.15× / 1.48× | 6.99× / 7.23× | 156.1 / 155.6 | 1.42× / 1.76× | 4.65× / 4.96× | 903.1 / 883.3 | 1.15× / 1.57× | 4.86× / 5.27× | 21015.5 / 19810.9 | 1.32× / 1.48× | 2.51× / 2.46× |
| S4b (r1 only) | 2266.1 | 1.18× | 7.18× | 150.4 | 1.36× | 4.47× | 851.8 | 1.09× | 4.58× | 19309.8 | 1.21× | 2.31× |
| S5 (r1) | failed | | | | | | | | | the server refused the setting (§9) | | |
| S7 (r1/r2) | 2413.1 / 2227.6 | 1.26× / 1.47× | 7.65× / 7.22× | 147.9 / 154.7 | 1.34× / 1.75× | 4.40× / 4.93× | 967.9 / 852.3 | 1.24× / 1.51× | 5.20× / 5.09× | 21264.8 / 20448.6 | 1.33× / 1.53× | 2.54× / 2.54× |
| H1 (r1/r2) | 1886.7 / 1788.2 | 0.98× / 1.18× | 5.98× / 5.80× | 177.5 / 167.1 | 1.61× / 1.89× | 5.28× / 5.32× | 912.6 / 829.0 | 1.17× / 1.47× | 4.91× / 4.95× | 19825.9 / 19377.3 | 1.24× / 1.45× | 2.37× / 2.40× |
| U1 (r1/r2) | 1892.8 / 1782.4 | 0.99× / 1.18× | 6.00× / 5.78× | 128.9 / 126.1 | 1.17× / 1.43× | 3.83× / 4.01× | 857.5 / 807.6 | 1.10× / 1.43× | 4.61× / 4.82× | 19609.6 / 18662.1 | 1.23× / 1.40× | 2.35× / 2.31× |
| U2 (r1/r2) | 2081.6 / 2096.6 | 1.09× / 1.39× | 6.60× / 6.80× | 117.4 / 116.5 | 1.07× / 1.32× | 3.49× / 3.71× | 790.9 / 730.5 | 1.01× / 1.29× | 4.25× / 4.36× | 19829.2 / 19507.6 | 1.24× / 1.46× | 2.37× / 2.42× |
| U3 (r1/r2) | 1646.1 / 1375.8 | 0.86× / 0.91× | 5.22× / 4.46× | 150.7 / 150.7 | 1.37× / 1.71× | 4.48× / 4.80× | 792.9 / 731.6 | 1.01× / 1.30× | 4.26× / 4.37× | 18704.4 / 17605.1 | 1.17× / 1.32× | 2.24× / 2.18× |
| HALL (r1/r2) | 1071.2 / 855.6 | 0.56× / 0.57× | 3.39× / 2.77× | 99.5 / 85.7 | 0.90× / 0.97× | 2.96× / 2.73× | 652.0 / 584.8 | 0.83× / 1.04× | 3.51× / 3.49× | 15039.3 / 14507.4 | 0.94× / 1.09× | 1.80× / 1.80× |
| HALL (r3/r4) | 771.0 / 846.2 | 0.51× / 0.56× | 2.49× / 2.82× | 90.3 / 102.4 | 1.00× / 1.18× | 2.95× / 3.20× | 566.3 / 583.2 | 1.06× / 1.02× | 3.25× / 3.39× | 14322.3 / 14375.7 | 1.07× / 1.08× | 1.80× / 1.80× |
| S6 (r3/r4) | 1044.6 / 1046.4 | 0.69× / 0.69× | 3.37× / 3.48× | 150.8 / 143.9 | 1.67× / 1.65× | 4.92× / 4.50× | 824.1 / 794.7 | 1.55× / 1.39× | 4.73× / 4.62× | 16902.6 / 16857.8 | 1.26× / 1.27× | 2.13× / 2.11× |
| S6H (r3/r4) | 481.7 / 453.7 | 0.32× / 0.30× | 1.55× / 1.51× | 82.6 / 85.7 | 0.92× / 0.98× | 2.69× / 2.68× | 384.4 / 368.2 | 0.72× / 0.64× | 2.21× / 2.14× | 13580.7 / 14013.8 | 1.01× / 1.05× | 1.71× / 1.75× |
| S6H (r5/r6) | 465.3 / 418.0 | 0.29× / 0.28× | 1.57× / 1.39× | 86.1 / 85.7 | 1.00× / 0.99× | 2.73× / 2.54× | 392.7 / 392.2 | 0.68× / 0.74× | 1.93× / 2.21× | 13553.7 / 13441.4 | 1.01× / 1.02× | 1.67× / 1.70× |
| U4 (r5/r6) | 2169.7 / 2166.5 | 1.36× / 1.46× | 7.32× / 7.20× | 154.5 / 158.5 | 1.79× / 1.84× | 4.90× / 4.70× | 783.9 / 810.3 | 1.36× / 1.53× | 3.85× / 4.57× | 20142.5 / 20070.9 | 1.50× / 1.53× | 2.48× / 2.54× |
| **S6H4 (r5/r6)** | 443.3 / 418.4 | 0.28× / 0.28× | 1.49× / 1.39× | 141.1 / 83.4 | 1.63× / 0.97× | 4.47× / 2.47× | 344.6 / 314.4 | 0.60× / 0.60× | 1.69× / 1.77× | **12927.3 / 12701.3** | **0.96× / 0.97×** | 1.59× / 1.61× |
| S6H1 (r7/r8) | 1063.7 / 1038.4 | 0.70× / 0.70× | 3.55× / 3.37× | 152.7 / 156.3 | 1.76× / 1.26× | 3.85× / 5.01× | 825.1 / 809.5 | 1.46× / 1.42× | 4.78× / 4.71× | 17279.4 / 17176.9 | 1.29× / 1.30× | 2.18× / 2.16× |
| MB6 (r3/r4) | 352.5 / 360.6 | 0.23× / 0.24× | 1.14× / 1.20× | 46.8 / 39.7 | 0.52× / 0.46× | 1.53× / 1.24× | 252.6 / 261.2 | 0.47× / 0.46× | 1.45× / 1.52× | 12525.5 / 12675.0 | 0.93× / 0.95× | 1.58× / 1.59× |
| MB (r1/r2) | 487.4 / 483.4 | 0.25× / 0.32× | 1.54× / 1.57× | 44.2 / 35.8 | 0.40× / 0.41× | 1.32× / 1.14× | 258.7 / 271.8 | 0.33× / 0.48× | 1.39× / 1.62× | 12850.2 / 12846.6 | 0.81× / 0.96× | 1.54× / 1.59× |
| PGL-OPFS-U (r3/r4) | 592.8 / 651.9 | 0.39× / 0.43× | 1.91× / 2.17× | 78.7 / 77.6 | 0.87× / 0.89× | 2.57× / 2.42× | 433.0 / 431.0 | 0.81× / 0.75× | 2.49× / 2.51× | 10163.2 / 10135.3 | 0.76× / 0.76× | 1.28× / 1.27× |
| PGL-OPFS-U4 (r5/r6) | 513.4 / 502.2 | 0.32× / 0.34× | 1.73× / 1.67× | 82.7 / 83.2 | 0.96× / 0.97× | 2.62× / 2.47× | 319.7 / 311.7 | 0.56× / 0.59× | 1.57× / 1.76× | 9703.1 / 9525.6 | 0.72× / 0.73× | 1.20× / 1.21× |

Single arms against the mean of S0 and S0p of their own round (23 004 ms in round 1, 20 488 in round 2):

| arm | Suite r1 / r2 | row 11 | row 6 | row 14 | Suite saved, mean of rounds |
| --- | --- | --- | --- | --- | --- |
| S2 `wal_init_zero=off` | 0.76× / 0.84× | 0.47× / 0.47× | 0.66× / 1.11× | 0.87× / 1.11× | 4 352 ms |
| U3 zeroskip | 0.81× / 0.86× | 0.69× / 0.60× | 0.66× / 1.04× | 0.79× / 0.88× | 3 591 ms |
| U1 chunked arena growth | 0.85× / 0.91× | 0.80× / 0.78× | 0.56× / 0.87× | 0.86× / 0.97× | 2 610 ms |
| S3 `wal_buffers=4MB` | 0.85× / 0.94× | 0.94× / 1.00× | 0.66× / 1.00× | 1.03× / 1.01× | 2 403 ms |
| H1 gather + 256 KiB payload | 0.86× / 0.95× | 0.79× / 0.78× | 0.78× / 1.15× | 0.91× / 0.99× | 2 144 ms |
| U2 coalesce | 0.86× / 0.95× | 0.87× / 0.92× | 0.51× / 0.80× | 0.79× / 0.87× | 2 078 ms |
| S4 `shared_buffers=64MB` | 0.91× / 0.97× | 0.93× / 0.97× | 0.68× / 1.08× | 0.90× / 1.06× | 1 333 ms |
| S7 `wal_recycle=off,min_wal_size=32MB` | 0.92× / 1.00× | 1.01× / 0.97× | 0.65× / 1.07× | 0.97× / 1.02× | 889 ms |
| S1 `fsync=off` | 1.06× / 1.01× | 1.37× / 1.03× | 0.84× / 1.06× | 1.11× / 0.99× | −771 ms |
| HALL (H1 + U1–U3) | 0.65× / 0.71× | 0.45× / 0.37× | 0.44× / 0.59× | 0.65× / 0.70× | 6 973 ms |

Round 1's default was slow, which flatters every round-1 ratio; round 2 is the conservative column.
Everything round 2 puts within 0.94–1.01× (S3, S4, S7, S1, H1, U2) is within the spread the default
itself shows between Runs.

### 4.3 Memory

The pgrust shared memory at the end of each Run, the high-water mark the page publishes (MiB); the
PGlite columns report PGlite's heap.

| Run | MiB |
| --- | --- |
| PGL-MEM, PGL-OPFS, PGL-OPFS-U, PGL-OPFS-U4 | 226.3 (every Run) |
| S0, S0p, S1, S2, S7, H1, U1, U2, U3, U4, HALL, MB | 260.4–260.6 (every Run) |
| S3, S6, S6H1, S6H, **S6H4**, MB6 | **266.4–266.6** (every Run) |
| S4 (`shared_buffers=64MB`) | 296.8 / 296.8 |
| S4b (`shared_buffers=128MB`) | **368.2** (one Run; breaks the 300 MiB ceiling, as expected) |
| RTT Suite: S0, S6, S6H4 | 256.0 |
| Concurrency Suite: S0 / S6 / S6H4 | 264.0 / 270.0 / 270.0–270.3 |

`wal_buffers=4MB` costs 6 MiB, and `shared_buffers=64MB` costs 36.4 MiB; the two together would be
about 303 MiB. H1's 256 KiB channel payloads add 1.9 MiB of SharedArrayBuffer outside the wasm memory
(ten guest channels for one session; 2.4 MiB for four); U2 and U4 hold at most 1 MiB of JS buffer per
file.

## 5. What the OPFS store does per row

Every agent's broker requests in each row's window, counted in the agents themselves; "zero" is the
subset of writes that carried only zero bytes. "Backend's round trip" is the busiest channel's
(the backend's, channel 10, on every row but row 3 of S0, where it is channel 4). OPFS calls are the coordinator's access-handle calls,
grouped by what the store was doing. Tables for every row of S0 r7, S6H4 r7, S0 on disk and
PGlite: `counts-*.md`.

**S0, round 7, all 18 rows** (bench lane):

| row | ms | requests | writes (bytes; of which zero-fill) | reads | fsyncs | open + close | backend's round trip ms (% of row) | coordinator busy ms | OPFS calls | OPFS ms | OPFS calls by kind (count / ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 578.6 | 147 | 18 (0.3 MB; zero 13) | 59 | 2 | 53 | 294 (51%) | 311 | 129 | 304 | arena write 47/252; metadata 6/26; grow 13/14; read 59/11 |
| 2 | 1140.6 | 317 | 295 (4.6 MB; zero 250, 2.0 MB) | 0 | 5 | 12 | 261 (23%) | 311 | 892 | 290 | arena write 623/211; grow 250/75 |
| 2.1 | 509.7 | 412 | 392 (4.6 MB; zero 251) | 0 | 3 | 12 | 269 (53%) | 273 | 875 | 255 | arena write 610/194; grow 251/57 |
| 3 | 3082.0 | 3069 | 2744 (25.8 MB; zero 2544, 19.9 MB) | 9 | 13 | 288 | 1314 (43%) | 1837 | 6280 | 1715 | arena write 3386/1080; grow 2545/509; metadata 320/125 |
| 3.1 | 663.2 | 681 | 653 (7.3 MB; zero 254) | 0 | 3 | 16 | 409 (62%) | 441 | 1411 | 420 | arena write 966/327; grow 431/91 |
| 4 | 453.8 | 60 | 0 | 35 | 0 | 25 | 11 (2%) | 9 | 35 | 8 | read 35/8 |
| 5 | 808.7 | 10 | 0 | 4 | 0 | 6 | 2 (0%) | 2 | 4 | 1 | read 4/1 |
| **6** | 148.1 | 178 | 161 (2.1 MB; zero 4) | 0 | 1 | 8 | 122 (**82%**) | 117 | 432 | 111 | arena write 286/85; grow 140/25 |
| 7 | 921.1 | 82 | 0 | 74 | 0 | 8 | 53 (6%) | 39 | 74 | 36 | read 74/36 |
| 8 | 233.0 | 26 | 14 (0.3 MB) | 2 | 2 | 7 | 10 (4%) | 18 | 51 | 17 | arena write 35/13 |
| 9 | 3299.2 | 768 | 532 (10.9 MB; zero 381) | 73 | 16 | 147 | 471 (14%) | 737 | 2181 | 693 | arena write 1517/497; grow 381/119; metadata 178/61 |
| 10 | 4865.8 | 2765 | 2579 (27.3 MB; zero 2434, 19.0 MB) | 0 | 21 | 161 | 1681 (35%) | 1943 | 6311 | 1829 | arena write 3617/1194; grow 2434/559; metadata 224/76 |
| **11** | 2217.9 | **3370** | **3267 (29.3 MB; zero 2618, 20.5 MB)** | 3 | 10 | 86 | 1765 (**80%**) | 1819 | **6590** | **1722** | arena write **3817**/1184; grow **2618**/494; metadata 138/43; flush 14/0 |
| 12 | 57.4 | 10 | 9 (0.5 MB) | 0 | 1 | 0 | 22 (39%) | 22 | 76 | 21 | arena write 75/21 |
| 13 | 122.5 | 118 | 117 (1.8 MB) | 0 | 1 | 0 | 75 (61%) | 72 | 244 | 69 | arena write 243/69 |
| **14** | 841.2 | 1083 | 932 (9.5 MB; zero 399, 3.1 MB) | 0 | 5 | 146 | 559 (**67%**) | 596 | 1919 | 562 | arena write 1261/396; grow 399/85; metadata 249/80 |
| 15 | 555.4 | 272 | 268 (3.6 MB; zero 118) | 0 | 4 | 0 | 134 (24%) | 178 | 608 | 171 | arena write 480/142; grow 118/28 |
| 16 | 24.8 | 90 | 1 | 6 | 1 | 68 | 13 (54%) | 11 | 22 | 7 | metadata 13/5 |

**Row 11 issues 3 370 broker requests, 3 267 of them writes of 29.3 MB, 2 618 of which (20.5 MB) are
zero-fills: one 16 MiB WAL segment in 2 048 writes of 8 KiB and 570 single-block relation
extensions; 10 fsyncs.** The store turns them into 6 590 OPFS calls, because every write that lands
past the end of a file allocates a fresh extent and grows the arena by one extent with its own
truncate: 3 817 arena writes and 2 618 arena grows. Those calls are 1 722 ms of a 2 218 ms row.

The zero-fills are the WAL segment and relation extensions of one block: with the host gathering each
`fd_pwrite` into one request (H1), row 11's zero writes become 650 requests for the same 20.5 MB,
i.e. 64 of 256 KiB for the segment and 586 averaging 7.97 KiB. Across the whole Suite under H1 the
non-WAL zero-fills average 7.9–8.3 KiB per request in every row, and no row's block count leaves room
for a request of more than 3 blocks (row 1: 13 blocks in 11 requests; row 2: 250 in 248).

Row 11 across the arms (bench lane unless marked):

| Run | ms | requests | zero-fill writes | backend's round trip (% of row) | coordinator busy ms | OPFS calls | OPFS ms | largest OPFS items |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S0 r7 | 2217.9 | 3370 | 2618 (20.5 MB) | 1765 (80%) | 1819 | 6590 | 1722 | arena write 3817 / 1184 ms; grow 2618 / 494 ms |
| S2 r1 | 1109.8 | 1444 | 571 (4.5 MB) | 728 (66%) | 780 | 2477 | 737 | arena write 1753 / 562 ms; grow 571 / 132 ms |
| S6 r7 | 1047.2 | 823 | 571 (4.5 MB) | 580 (55%) | 781 | 2566 | 745 | arena write 1842 / 566 ms; grow 571 / 132 ms |
| H1 r2 | 1788.1 | 1535 | 650 (20.5 MB) | 1414 (79%) | 1411 | 4614 | 1357 | arena write 3824 / 1170 ms; grow 634 / 144 ms |
| U1 r2 | 1782.4 | 3380 | 2618 | 1311 (74%) | 1384 | 3975 | 1284 | arena write 3818 / 1226 ms; grow 5 / 12 ms |
| U2 r2 | 2096.6 | 3424 | 2618 | 1762 (84%) | 1707 | 6095 | 1580 | arena write 3323 / 1029 ms; grow 2618 / 501 ms |
| U3 r2 | 1375.8 | 3581 | 2618 | 999 (73%) | 987 | 3940 | 877 | grow 2618 / 470 ms; arena write 1170 / 364 ms |
| U4 r5 | 2169.7 | 3507 | 2618 | 1772 (82%) | 1777 | 6440 | 1681 | arena write 3798 / 1168 ms; grow 2618 / 510 ms; metadata 7 / 2 ms |
| S6H1 r7 | 1063.7 | 817 | 571 | 660 (62%) | 762 | 2456 | 727 | arena write 1733 / 537 ms; grow 571 / 146 ms |
| **S6H4 r7** | **455.8** | 938 | 571 | 167 (37%) | 165 | **288** | **124** | arena write 271 / 110 ms; grow 2 / 11 ms; metadata 4 / 3 ms |
| MB r1 (heap store) | 487.4 | 3670 | 2618 | 181 (37%) | 116 | – | – | – |
| MB6 r3 (heap store) | 352.5 | 1018 | 571 | 90 (25%) | 72 | – | – | – |
| PGlite OPFS r1 (in process) | 1578.1 | – | – | – | – | 3769 | 1287 | arena write 3305 / 1086 ms; grow 328 / 158 ms; metadata 134 / 42 ms |
| PGlite OPFS + U1–U4 r5 | 513.4 | – | – | – | – | 638 | 226 | arena write 631 / 214 ms |
| S0 disk d1 | 552.4 | 3599 | 2618 | 239 (43%) | 163 | 6551 | 101 | arena write 3785 / 55 ms; grow 2618 / 29 ms; flush 10 / 16 ms |
| S6H4 disk d1 | 336.6 | 1039 | 571 | 76 (22%) | 54 | 393 | 17 | flush 10 / 9 ms; arena write 373 / 8 ms |

PGlite asks OPFS for 3 769 calls on the same row where pgrust asks for 6 590: 512 fewer arena
writes and 2 290 fewer arena grows. 328 grows against 2 618 say PGlite's store receives its zero-fills
in writes that span many extents, one grow each, where pgrust's host hands the store one 8 KiB write
per iovec; PGlite's store calls themselves were not counted here, only its access-handle calls.

**S6H4, round 7**, against the S0 table above (`counts-r7-S6H4.md`), requests / OPFS calls / the
backend's share of the row: row 1 142 / 67 / 24%; row 3 843 / 63 / 11%; row 6 167 / 151 / 69%; row 9
650 / 155 / 4%; row 10 613 / 96 / 2%; row 11 938 / 288 / 37%; row 14 698 / 162 / 32%. The WAL segment
zero-fills are gone (S2), the 8 KiB relation zero-extends are dropped by the store (U3), the arena
grows 4 MiB at a time (U1), contiguous extents go out together (U2), and the metadata-log appends that
were most of S6H's remaining calls on rows 3, 9, 10 and 14 (323, 178, 223 and 247 of them in S6H,
round 4) are down to 8, 14, 17 and 3 (U4).

## 6. The coordinator's profile

V8's sampling profiler (100 µs) on the storage coordinator worker in three profiled Runs, sliced by
the rows' windows (`slice-coordinator.ts`; `profile-r1-*-slices.md`). The Blink binding of a
synchronous access handle call has no frame of its own, so the call's time is the self time of the
store's one-line `OpfsRepackedFileHandle` methods (bundle lines 10213–10230). `wait` is the
coordinator parked in `Atomics.wait`, i.e. idle.

| profiled Run | row | window ms | access-handle calls | idle in `Atomics.wait` | store's JS | counting wrapper | V8 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S0 | 11 | 2472.6 | **1913.3 (77.4%)**: write 1343.6, truncate 568.8 | 405.1 (16.4%) | 97.9 (4.0%) | 53.2 (2.2%) | 2.1 |
| S0 | 6 | 184.4 | 143.4 (77.8%): write 116.7, truncate 26.7 | 32.5 (17.6%) | 5.6 (3.0%) | 2.8 (1.5%) | 0.2 |
| S0 | 14 | 976.6 | 639.1 (65.4%): write 536.7, truncate 102.4 | 275.4 (28.2%) | 42.8 (4.4%) | 18.2 (1.9%) | 1.0 |
| S6 | 11 | 1110.5 | 773.7 (69.7%): write 637.1, truncate 135.9 | 276.9 (24.9%) | 38.4 (3.5%) | 20.4 (1.8%) | 1.0 |
| S6H4 | 11 | 413.8 | 91.1 (22.0%): write 79.8, truncate 10.7 | **281.6 (68.0%)** | 19.3 (4.7%) | 21.1 (5.1%, the levers included) | 0.7 |
| S6H4 | 6 | 88.4 | 45.0 (50.9%) | 33.7 (38.1%) | 4.8 (5.4%) | 5.0 (5.7%) | 0 |
| S6H4 | 14 | 346.4 | 72.2 (20.9%) | 233.2 (67.3%) | 24.2 (7.0%) | 16.2 (4.7%) | 0.6 |

Top 20 by self time on row 11 under S0: the two access-handle methods (`write` 1343.6 ms, `truncate`
568.8 ms), `wait` (405.1), then nothing above 26 ms: the wrapper's `now` (25.4), the broker's
`#answer` (8.9) and the store's own bookkeeping (`applyResizeFile`, `checkedU64`, `PayloadReader`,
`#writeLogical`, `prepareTxnProjection`, `#prepareAllocated`, each 2.7–5.3 ms). **The access-handle
call itself is 93% of the coordinator's busy time on row 11, 94% on row 6 and 91% on row 14; the
store's and the broker's own JS are 3–5% of the row.** With S6H4 the coordinator is idle for two thirds of
rows 11 and 14.

## 7. The rings: the broker seam, with the store on the heap

On `pgrust-postmaster-memory-broker` (MB, no OPFS at all) and with S6 + H1 (MB6), per row
(`rings.md`). Mean round trip is measured in the requesting agent; coordinator service is the
coordinator's time answering; hand-off is the difference (ring, wake, wake back).

| Run | row | ms | requests | MB moved | requests per ms | mean round trip | coordinator service | hand-off | backend's round trip (% of row) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MB r1 | 11 | 487.4 | 3670 | 29.3 | 7.53 | 51 µs | 32 µs | 19 µs | 181 ms (37%) |
| MB r2 | 11 | 483.4 | 3578 | 29.3 | 7.40 | 53 µs | 32 µs | 21 µs | 181 ms (37%) |
| MB r1 | 14 | 258.7 | 1249 | 9.5 | 4.83 | 54 µs | 33 µs | 21 µs | 65 ms (25%) |
| MB r2 | 14 | 271.8 | 1245 | 9.5 | 4.58 | 53 µs | 32 µs | 21 µs | 65 ms (24%) |
| MB r1 | 6 | 44.2 | 180 | 2.1 | 4.07 | 56 µs | 36 µs | 19 µs | 10 ms (22%) |
| MB r1 | 3 | 1344.7 | 3349 | 25.9 | 2.49 | 65 µs | 40 µs | 25 µs | 210 ms (16%) |
| MB6 r3 | 11 | 352.5 | 1018 | 13.3 | 2.89 | 100 µs | 70 µs | 30 µs | 90 ms (25%) |
| MB6 r3 | 14 | 252.6 | 814 | 9.5 | 3.22 | 76 µs | 46 µs | 30 µs | 59 ms (24%) |

**The seam's cost is per request, not per byte.** The hand-off alone is 19–21 µs per request at
8 KiB a request and 30 µs when the requests are larger (MB6 gathers the WAL into 256 KiB), and the
coordinator's service on the heap store is 32–70 µs; copying 8 KiB is of the order of a microsecond
(an estimate, not measured here). Row 1's requests carry 5.4 KiB on average and cost more (101–108 µs),
not less. Row 11's 3 670 requests cost the backend
181 ms of waiting, which is about what the previous note's broker rung added to that row
(the threads module without a broker ran it in 280–288 ms). Cutting the requests (S2 takes row 11 from
3 670 to 1 018) halves the backend's wait (90 ms) even though each request carries more.

## 8. The disk lane: a persistent context, OPFS on disk

The same arms, two rounds (d1 left to right, d2 reversed), in a persistent Playwright context on a
fresh user-data directory (`tables-disk-r1r2.md`):

| arm | row 11 | row 6 | row 14 | Suite d1 / d2 | ÷ PGL-OPFS | ÷ PGL-MEM |
| --- | --- | --- | --- | --- | --- | --- |
| PGL-MEM | 298.4 / 329.4 | 38.1 / 38.6 | 176.3 / 214.2 | 7908.5 / 8243.4 | 0.94× / 0.97× | 1 |
| PGL-OPFS | 323.8 / 290.3 | 33.4 / 49.6 | 211.4 / 225.8 | 8430.7 / 8521.4 | 1 | **1.07× / 1.03×** |
| PGL-OPFS-U4 | 290.9 / 284.6 | 33.3 / 33.6 | 204.8 / 210.7 | 8701.7 / 8516.5 | 1.03× / 1.00× | 1.10× / 1.03× |
| S0 | 552.4 / 535.3 | 48.8 / 49.5 | 331.7 / 282.5 | 13167.1 / 13253.0 | **1.56× / 1.56×** | 1.66× / 1.61× |
| S1 | 516.2 / 516.0 | 38.2 / 39.9 | 299.4 / 278.3 | 13147.5 / 13370.9 | 1.56× / 1.57× | 1.66× / 1.62× |
| S6 | 385.2 / 353.2 | 43.4 / 59.3 | 269.9 / 305.5 | 12587.3 / 13283.0 | 1.49× / 1.56× | 1.59× / 1.61× |
| S6F | 354.3 / 364.7 | 48.5 / 48.5 | 267.8 / 291.1 | 12486.8 / 13043.8 | 1.48× / 1.53× | 1.58× / 1.58× |
| S6H1 | 366.5 / 391.7 | 50.0 / 49.4 | 260.4 / 299.2 | 12853.3 / 13207.4 | 1.52× / 1.55× | 1.63× / 1.60× |
| S6H4 | 336.6 / 321.3 | 45.1 / 52.7 | 254.7 / 262.4 | 12479.0 / 12898.9 | **1.48× / 1.51×** | 1.58× / 1.56× |
| S6HF4 | 317.2 / 329.7 | 37.6 / 50.4 | 257.7 / 290.9 | 12273.9 / 13539.6 | 1.46× / 1.59× | 1.55× / 1.64× |

On disk, OPFS costs PGlite 3–7% of the Suite, and every pgrust arm lands at 1.46–1.59× PGlite OPFS:
the levers still halve row 11 (S6H4 0.60× S0) but move the Suite by 0–4%. The rows that carry the
multiple on disk are the same rows that carry it against PGlite Memory in the bench lane (1, 2, 4, 7,
9, 10), where under S6H4 the backend waits on the store for 2–5% of the row, 24% on row 1 (§5).

`fsync=off` changes nothing on the Speedtest in either lane: the Suite's scripts each run as one
implicit transaction, and the whole Suite issues 88 fsync requests (S0, round 7). On disk it matters for
commit-heavy Suites. One Run each, disk lane:

| Suite | PGL-OPFS | S0 | S6H4 | S6HF4 (S6H4 + `fsync=off`) |
| --- | --- | --- | --- | --- |
| RTT, sum of the 12 per-statement ms | 5.00 | 11.81 | 11.62 | **8.89** |
| Concurrency Test 4, writers on disjoint rows (tx/s, higher is better) | 1548 | 2504 | 2527 | **3805** |
| Concurrency Test 5, writers on the same row (p95 ms) | 3.29 | 3.89 | 4.32 | **2.35** |
| Concurrency Test 1, read fan-out (wall ms) | 721 | 804 | 844 | 902 |

## 9. S5: what `posix_fallocate` needed

`file_extend_method=posix_fallocate` cannot be set on this build: the postmaster exits at boot with
`FATAL: invalid value for parameter "file_extend_method": "posix_fallocate"` and `HINT: Available
values: write_zeros.` (round 1, `results/r1-S5.json`). Three things stand in the way, all in the guest,
none in the host:

1. pgrust's `file_extend_method` options list only `write_zeros`
   (`crates/backend/utils/misc/guc_tables/src/tables.rs:561`).
2. `FileFallocate` tries `posix_fallocate` only under `#[cfg(target_os = "linux")]`
   (`crates/backend/storage/file/fd/src/io.rs:562`) and otherwise zero-fills; the VFS's `fallocate`
   returns `EOPNOTSUPP` on every non-Linux target (`crates/backend/storage/file/vfs/src/posix.rs:311`).
3. The host is already there: the store's WASI adapter (`createWasiPreview1Fs` in the store bundle,
   not `wasm/pgrust-wasi.js`) implements `fd_allocate` as `fstat` + `truncate`, and a truncate that
   extends a file in the repacked store allocates extents without a byte crossing from the guest.

And it would not fire here: `mdzeroextend` uses `FileFallocate` only for extensions of more than 8
blocks, and the relation extensions in this Suite are one block, occasionally two or three (§5). So S5 would need a guest
rebuild (the option, two `cfg` gates, about 15 + 3 minutes) and would still change nothing on the
Speedtest. It was not rebuilt. U3 is the host-side answer to the same bill: the store drops the
zero-fill instead of the guest not sending it.

## 10. The gate for S6H4

| check | result |
| --- | --- |
| all 18 rows, no failures | yes, in all 4 Speedtest rounds (r5–r8) and both disk rounds |
| wasm memory under 300 MiB | 266.4 MiB (Speedtest), 256.0 (RTT), 270.0–270.3 (Concurrency) |
| Suite ≤ 1.0× `pglite-opfs-repacked-relaxed` | **0.965×, 0.967×, 0.962×, 0.965×** (r5–r8) |
| RTT Suite does not regress | yes: sum of the 12 per-statement ms 13.35 / 12.61 against S0's 12.78 / 14.07 (two Runs each) |
| Concurrency Suite does not regress | not beyond the default's own spread (three Runs each, table below) |

Three Runs of each (bench lane), ms unless noted:

| Concurrency benchmark | S0 | S6H4 | PGL-OPFS (one Run) |
| --- | --- | --- | --- |
| 1: read fan-out, total wall | 773.5 / 801.7 / 876.8 | 900.6 / 858.6 / 895.7 | 738.4 |
| 2: reader p95 under a bulk write | 0.53 / 0.61 / 0.67 | 0.60 / 0.60 / 0.51 | 1545.8 |
| 3: short p95 beside a long query | 0.61 / 0.50 / 0.85 | 0.61 / 0.47 / 0.85 | 323.2 |
| 4: writers on disjoint rows (tx/s, higher is better) | 1662 / 2063 / 1676 | 1923 / 2098 / 1353 | 870 |
| 5: writers on the same row, p95 | 5.98 / 6.33 / 6.32 | 5.67 / 6.27 / 6.11 | 5.02 |

The one soft spot is Test 1: S6H4's three Runs sit at or above S0's slowest (885 against 817 ms on
average), with 47 store requests in the window, so the store is not what moved it. It is inside the
13% spread of S0's own three Runs and is not shown to be a regression; it is not shown not to be one
either. S6 (settings only) ran each Suite once: RTT sum 13.27, Concurrency Test 1 776 ms, Test 4
1959 tx/s.

**S6H4 passes every gate this machine can run.** It contains prototype store changes; adopting any
of it is the owner's decision, and nothing in `src/` or in pgrust was changed.

## 11. The ranked table

Suite gain is in the bench lane (headless Chromium, off-the-record context: the target's lane). Rows
are 11 / 6 / 14. "Alone" is against the mean of S0 and S0p of the same round (rounds 1 and 2);
"in S6H4" is what removing it from S6H4 would cost, where measured.

| # | lever | Suite gain | rows 11 / 6 / 14 | memory | disk lane | cost to adopt | owner | confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Store levers U1–U4 together** (on top of S6) | **−4.0 s: S6H4 0.77× / 0.76× S6** (r7/r8) | 0.41× / 0.50× / 0.39× | 0 | row 11 0.89×, Suite 0.98× (S6H4 against S6) | ~150 lines in the store; U1 and U4 change what the store promises (below) | upstream (the store); carried as a host-side port wrapper it is ours, at the price of second-guessing the store's bookkeeping | high (4 rounds of S6H4, 4 of S6) |
| 1a | U3 zeroskip: drop all-zero writes past the file's high-water mark | −3.6 s alone (0.81× / 0.86×) | 0.69× / 0.66× / 0.79× (r1) | 0 | – | small; relies on OPFS truncate zero-filling | upstream | medium |
| 1b | U1 arena grows in 4 MiB chunks | −2.6 s alone (0.85× / 0.91×) | 0.80× / 0.56× / 0.86× (r1) | 0 (4 MiB of file slack) | – | small; the store must track a logical arena size separately from the file's | upstream | medium |
| 1c | U2 coalesce contiguous extent writes within a call | −2.1 s alone (0.86× / 0.95×) | 0.87× / 0.51× / 0.79× (r1) | ≤1 MiB buffer | – | small; no semantic change (flushed before the call returns) | upstream | medium-low |
| 1d | U4 batch metadata-log appends across calls | −0.5 s alone (U4 20.1 s against S0 20.5–20.6 s, different rounds); **−0.68 s on S6H** (0.95× / 0.94×, r5/r6) | ~1.0× alone; on S6H 0.98× / 1.31× (one 141 ms Run) / 0.84× | ≤1 MiB buffer | – | small code; frames wait in memory until the next sync, which under PGlite's relaxed durability can be many queries | upstream | medium |
| 2 | **S2 `wal_init_zero=off`** | **−4.4 s alone (0.76× / 0.84×)**; the core of S6 (0.82× S0 in 4 rounds) | **0.47× / 0.47×**; row 6 and 14 unchanged | 0 | row 11 0.68× (S6), Suite 0.98× | one `-c` in the host's argv; a new WAL segment reads as zeros either way on this store (fresh extents are zero, reused ones are zeroed by the store) | ours (host settings) | **high** |
| 3 | S3 `wal_buffers=4MB` | −2.4 s alone (0.85× / 0.94×) | ~1.0× / 0.66–1.00× / ~1.0× | **+6 MiB** | – | one `-c` | ours (host settings) | low-medium |
| 4 | H1 gather `fd_pwrite` + 256 KiB channels | −2.1 s alone (0.86× / 0.95×); **+0.4 s on top of S6** (S6H1 1.03× / 1.02× S6) | 0.79× / 0.78× / 0.91× alone | +1.9 MiB SAB (not wasm) | Suite 1.01× on S6 | ~40 lines in `wasm/broker-fs.js`, one option in the engine | ours (host) | medium; redundant once S2 is in |
| 5 | S4 `shared_buffers=64MB` | −1.3 s alone (0.91× / 0.97×) | 0.93–0.97× / – / – | **+36.4 MiB** (296.8; 303 with S3) | – | one `-c` | ours (host settings) | low (noise-level) |
| 6 | S7 `wal_recycle=off,min_wal_size=32MB` | −0.9 s (0.92× / 1.00×) | ~1.0× | 0 | – | two `-c` | ours | low (noise-level) |
| 7 | S1 `fsync=off` | none (1.06× / 1.01×) | ~1.0× | 0 | Speedtest none; **RTT sum −23%, writers +51% tx/s, same-row p95 −46%** (S6HF4 against S6H4, one Run each) | one `-c` on the relaxed column only; the strict column keeps fsync | ours (host settings) | high that the Speedtest does not move; medium for the disk-lane RTT and Concurrency effect |
| 8 | S4b `shared_buffers=128MB` | −3.7 s in one round-1 Run (0.84× of the slow round-1 default) | 0.95× / 0.66× / 0.85× | **+107.8 MiB (368.2 MiB)** | – | – | ours | low; excluded by the ceiling |
| 9 | S5 `file_extend_method=posix_fallocate` | cannot be set | – | – | – | guest: GUC option + 2 `cfg` gates + rebuild, and still a no-op for one-block extensions | spike (pgrust guest) | high that it is a no-op here |

What each store lever changes, for whoever owns the store: U2 and U3 change no observable behaviour
(U2 writes before the call returns; U3 skips writes of bytes that are zero already). U1 makes the
arena file up to 4 MiB larger than the store's extents need while open; the prototype truncates it
back on close, and a reopen of such a store was not exercised. U4 holds metadata-log frames in memory
until the next flush or the next non-append use of the file, always after the arena data they name,
so the log stays a consistent prefix, but a tab that dies between syncs loses the held frames where
it would otherwise have left them in the OS's page cache. pgrust's guest fsyncs at every commit, which
bounds that window; PGlite's relaxed mode does not.

## 12. Possible or not

- **Primary target (bench lane: `pgrust-postmaster-opfs-repacked-relaxed` ≤ 1.0×
  `pglite-opfs-repacked-relaxed`): possible, and reached.** S6H4 is 0.962–0.967× in four rounds, at
  266.4 MiB, with every row and no RTT or Concurrency regression beyond S0's own spread. It needs the
  store levers: with only what is ours (settings and the host's gather, S6 and S6H1) pgrust is
  1.25–1.30×. The two settings are free; the store levers are the price.
- **The same target if the store levers go upstream: not with these levers.** The store is shared,
  so PGlite's column would get them too: PGlite OPFS with U1–U3 runs 10 135–10 163 ms, and with U1–U4
  9 526–9 703 ms. S6H4 (12 701–12 928 ms) is 1.25–1.36× that, and even the heap-store floor MB6
  (12 525–12 675 ms) is 1.23–1.33× it. Closing that gap is guest and seam work, not store work.
- **Stretch (≤ 1.0× `pglite-memory`): not possible with store or settings levers.** S6H4 is
  1.59–1.63× PGlite Memory, and the same server with no OPFS at all (MB6) is 1.58–1.59×. The remaining
  multiple sits in rows 1, 2, 4, 7, 9 and 10 (5.7×, 1.7×, 1.3×, 1.9×, 1.9× and 1.6× PGlite Memory
  under S6H4 in round 7), where the backend waits on the store for 2–5% of the row (24% on row 1):
  the guest's own work, the rows the previous note left unexplained.
- **On a disk-backed profile** (what a user's browser does): OPFS costs PGlite 3–7%, pgrust sits at
  1.46–1.59× PGlite OPFS under every arm, and the levers are worth 0–4% of the Suite. There PGlite
  OPFS is 1.03–1.07× PGlite Memory, so the primary and the stretch target are nearly the same target,
  and neither is reachable from the store.

## 13. What this does not show

- **The off-the-record mechanism itself.** That Playwright's `browser.newContext()` context keeps OPFS
  in memory in the browser process and serves each access-handle call as a round trip is inferred from
  §3's timings (a call 0.2–0.4 ms whatever its size, ~24× the persistent context's; a flush 3–5 µs,
  ~300× less than the persistent context's). No Chromium source was read and the browser process was
  not traced.
- **Crash safety of the store levers.** They are prototypes measured for speed. No crash, reopen or
  power-loss test was run; §11 lists what each one changes.
- **Every lever in every combination.** S6 was chosen from rounds 1–2, U4 was added after rounds 3–4
  showed the residual was metadata appends, and the combinations were measured as built up
  (S6 → S6H1 → S6H → S6H4), not as a full factorial. The single-arm effects of S3, S4, S7, S1, H1 and
  U2 are within the default's own Run-to-Run spread in round 2.
- **PGlite's store levers under the same boundaries as pgrust's.** PGlite's arena writes are held for
  one store call as pgrust's are, but its metadata appends (U4) wait for a flush, which relaxed PGlite
  issues rarely; PGL-OPFS-U4's 9.5–9.7 s may be optimistic by up to PGL-OPFS-U's 10.1 s.
- **Why rows 1, 2, 4, 7, 9 and 10 cost what they cost.** The counts say it is not the store; nothing
  here profiles the guest.
- **The instrumentation's exact cost.** It is ≤2.2% of the coordinator's row time in the profile and
  within noise between S0 and S0p, and every pgrust arm carries it; the controls do not.
- **Any other browser, machine or OS.** One i7-1165G7, headless Chromium 149, Linux. No Firefox, Safari
  or phone; OPFS is implemented separately in each.
- **The published Configurations' numbers.** The page's own columns were not changed. Every figure
  here is a scratch Run of one Configuration, read by a scratch driver.

## Reproduction

In this repo, from the root. The instrumentation and the levers are a scratch patch, applied only
while measuring (`git apply tmp/agents/levers/instrumentation.patch && bun run build`, and
`git checkout -- src && rm src/client/store-counters.ts` afterwards). The published modules in
`dist/pgrust/` are verified before and after every Run.

```
# rounds 1-2: single arms (round 2 reversed)
bun tmp/agents/levers/arms.ts --round 1 --runs PGL-OPFS,PGL-MEM,S0,S0p,S1,S2,S3,S4,S5,S7,H1,U1,U2,U3,HALL,PGL-OPFS-U,MB,S4b
bun tmp/agents/levers/arms.ts --round 2 --runs MB,PGL-OPFS-U,HALL,U3,U2,U1,H1,S7,S4,S3,S2,S1,S0p,S0,PGL-MEM,PGL-OPFS
#   (these two PGL-OPFS-U Runs held PGlite's writes across calls; renamed PGL-OPFS-Ux, not reproducible from the final patch)
# rounds 3-8: combinations beside their controls
bun tmp/agents/levers/arms.ts --round 3 --runs PGL-OPFS,S0,S6,S6H,HALL,PGL-OPFS-U,MB6,PGL-MEM
bun tmp/agents/levers/arms.ts --round 4 --runs PGL-MEM,MB6,PGL-OPFS-U,HALL,S6H,S6,S0,PGL-OPFS
bun tmp/agents/levers/arms.ts --round 5 --runs PGL-OPFS,U4,S6H,S6H4,PGL-OPFS-U4,PGL-MEM
bun tmp/agents/levers/arms.ts --round 6 --runs PGL-MEM,PGL-OPFS-U4,S6H4,S6H,U4,PGL-OPFS
bun tmp/agents/levers/arms.ts --round 7 --runs PGL-OPFS,S0,S6,S6H1,S6H4,PGL-MEM
bun tmp/agents/levers/arms.ts --round 8 --runs PGL-MEM,S6H4,S6H1,S6,S0,PGL-OPFS
bun tmp/agents/levers/arms.ts --round 1 --runs PGL-OPFS-counts
# disk lane
bun tmp/agents/levers/arms.ts --round 1 --persistent --runs PGL-OPFS,PGL-MEM,S0,S1,S6,S6F,S6H1,S6H4,S6HF4,PGL-OPFS-U4
bun tmp/agents/levers/arms.ts --round 2 --persistent --runs PGL-OPFS-U4,S6HF4,S6H4,S6H1,S6F,S6,S1,S0,PGL-MEM,PGL-OPFS
bun tmp/agents/levers/arms.ts --round 1 --persistent --suite rtt --runs PGL-OPFS,S0,S6H4,S6HF4
bun tmp/agents/levers/arms.ts --round 1 --persistent --suite concurrency --runs S6HF4,S6H4,S0,PGL-OPFS
# the gate (bench lane)
bun tmp/agents/levers/arms.ts --round 1 --suite rtt --runs PGL-OPFS,S0,S6,S6H4
bun tmp/agents/levers/arms.ts --round 2 --suite rtt --runs S6H4,S0
bun tmp/agents/levers/arms.ts --round 1 --suite concurrency --runs S6H4,S6,S0,PGL-OPFS
bun tmp/agents/levers/arms.ts --round 2 --suite concurrency --runs S0,S6H4
bun tmp/agents/levers/arms.ts --round 3 --suite concurrency --runs S0,S6H4
# the coordinator profile (not timed)
bun tmp/agents/levers/arms.ts --round 1 --profile --runs S0,S6,S6H4
bun tmp/agents/levers/slice-coordinator.ts results/profile-r1-S0 11,6,14 20

# every table
bun tmp/agents/levers/tables.ts --rounds 7,8                  # and 1,2 / 3,4 / 5,6; --lane disk --rounds 1,2
bun tmp/agents/levers/counts.ts r7-S0                         # r7-S6H4, disk-r1-S0, r1-PGL-OPFS-counts
bun tmp/agents/levers/counts.ts --compare r7-S0,r1-S2,r7-S6,r2-H1,r2-U1,r2-U2,r2-U3,r5-U4,r7-S6H1,r7-S6H4,r1-MB,r3-MB6,r1-PGL-OPFS-counts,r5-PGL-OPFS-U4,disk-r1-S0,disk-r1-S6H4 --row 11
bun tmp/agents/levers/counts.ts --rings r1-MB,r2-MB,r3-MB6,r7-S0,disk-r1-S0
bun tmp/agents/levers/perop.ts r7-S0 r8-S0 disk-r1-S0 disk-r2-S0 r7-S6H4 disk-r1-S6H4 r1-PGL-OPFS-counts
```

A single tuning Run needs none of the scratch: `bun run bench --suite speedtest --configurations
pgrust-postmaster-opfs-repacked-relaxed --postmaster-tuning wal_init_zero=off,wal_buffers=4MB`.
