# The absent-fork cache: a never-vacuumed index's free space map is no longer asked for at every page split, 868 guest opens a Speedtest become 114

- Date: 2026-09-26
- pgrust: `spike/wasip1-threads` at `be79c78758`, two commits on `a230ad7d08` (the host JS the bench
  vendors): `ea6c68b2e4` (md: `mdexists` remembers a fork it found absent until any file is created
  in the process) and `be79c78758` (memwatchdog: no watchdog thread on WASI)
- Module: the profile-guided threads module of `e2e7a2f9`, rebuilt at `be79c78758`, release
  `pgrust-assets/be79c787`: `postgres-threads.wasm`
  `c9758ec7a4a8c0654d3d8ed4acba2a62343476b1d7ecb5dcf4fd608c6663f4a3`, 39 737 405 B raw, 14 014 362 B
  gzip. The profile-use build printed 21 "no profile data" warnings (the same spill-set functions as
  the published `c499994c…`) and 9 profile hash mismatches, in the functions the two commits edit.
- Bench: `a2edf4b` carries it as `?pgrustModule=be79c787` beside the published default, which is
  pinned to release `e2e7a2f9` (threads `c499994c…`) until this A/B says otherwise
- Desktop: headless Chromium in the bench's persistent context (a fresh profile on disk, OPFS on disk)
- Phone: Samsung Galaxy S22+ (SM-S9060, Snapdragon 8 Gen 1), Android 16, Chrome 153.0.8010.53, the
  published page at `a2edf4b`

## What this answers

pgrust asked its store for a file that was not there, many times a Suite. An index that has never
been vacuumed has no free space map fork, and `fsm_readbuf` checks for it again at every btree page
split (PostgreSQL's `freespace.c` logic, ported as is): `mdexists` opens the fork and gets `ENOENT`.
Natively that is about a microsecond. On wasm every such open is a round trip from the guest thread
to the storage host (`ea6c68b2e4`'s message estimates 0.4 to 0.6 ms on a phone; §6 measures 0.18 to
0.32 ms). The memory watchdog did the same once a second, trying to open `/proc/self/status` and
`/proc/self/cgroup`, which a browser does not have.

**Findings.**

1. **868 guest opens a Speedtest become 114**, on the desktop and on the phone alike (874–876 → 113–114
   there): row 3 from 267 to 20, rows 10 and 14 to 3.
2. **The desktop Suite is 4% faster** (0.959× on the medians, the ranges overlapping), rows 3 and 14
   6–9% with the ranges apart, the Warm-up 10% slower and unexplained.
3. **The phone Suite does not move beyond its noise** (−0.7%): the removed opens were about 140 ms of
   guest thread time a Suite there, 1% of it, at the 200 µs broker spin that is now the default. Row
   14 is 13% faster with the ranges apart, row 6 21% slower (14 ms) with the ranges apart, and the
   Warm-up is not slower. It costs no CPU.
4. **The gate passes**, the FSM-reuse check included: a fork that `VACUUM` creates is found.

## 1. The fix

**`ea6c68b2e4`, md.** `mdexists` keeps a per-handle "absent" bit per fork, stamped with a
process-wide file-creation generation (`FILE_CREATION_GEN`, an `AtomicU64` in the vfs crate) that it
reads before the probe. The answer is reused only while the generation is unchanged. vfs bumps the
generation after every open with `O_CREAT`, every rename and every mkdir, the three operations
through which fd creates a file, so `mdcreate`, `copy_file`, the WAL segment files and everything
else fd creates invalidate it. The creation paths that bypass vfs bump it themselves: fd's `fopen`
plane (`AllocateFile` with `"w"`/`"a"`) and its macOS `copyfile` clone arm, the janitor's parallel
`FILE_COPY` workers, and the tablespace symlinks of `CREATE TABLESPACE` and of recovery's
`tablespace_map`. One counter is enough because every backend is a thread of the one process. The
state is one `u64` per smgr handle (the generation shifted over one bit per fork), because smgr pins
`SMgrRelation` at 168 bytes; it stays at 168.

**`be79c78758`, memwatchdog.** On WASI the watchdog can read nothing it measures (no
`/proc/self/status`, no cgroup, no physical-memory size, no allocator-stats hook), so its usage is
always 0 and it can never fire; all its tick did was fail two opens a second while it held one of the
host's prewarmed workers. `memwatchdog::start` now returns at once on `target_os = "wasi"`. The
`pgrust.memory_watchdog` GUC (`PGC_SIGHUP`) exists and is unchanged, and has no effect there.

## 2. Guest opens: desktop, one Run per module

Speedtest with `?brokerStats=1` on `pglite-memory,pgrust-postmaster-opfs-repacked-relaxed`, the
`pgrust guest file calls` table's open column for the pgrust column:

| Benchmark | current `c499994c` | `be79c787` |
| --- | ---: | ---: |
| Warm-up | 99 | 93 |
| Test 3: 25000 INSERTs into an indexed table | 267 | 20 |
| Test 9: 25000 UPDATEs with an index | 146 | 10 |
| Test 10: 25000 text UPDATEs with an index | 147 | 3 |
| Test 11: INSERTs from a SELECT | 74 | 7 |
| Test 14: A big INSERT after a big DELETE | 143 | 3 |
| Test 16: DROP TABLE | 39 | 39 |
| **Suite (18 rows)** | **868** | **114** |

## 3. The gate

On the `be79c787` module:

- the six pgrust lanes: PASS;
- `sab-pipe`: 6 passed, 0 failed;
- the leak probe: 0.0 B per statement on all 8 paths;
- the lifetime smoke: PASS;
- the pgxsinkit unit suite on pgrust: 2 100 passed, 0 failed, in 435.3 s;
- an FSM-reuse check, because the cache must not hide a fork that comes into being: the index's
  fork is absent, `VACUUM` creates it, a 40 000-row re-insert reuses the freed pages, and the index
  stays at 1 138 688 B on both modules;
- memory: wasm memory 256.0 MiB on both modules, renderer RSS 585.0 MiB against 589.9 MiB.

## 4. Desktop A/B

Headless Chromium, persistent context, Speedtest on
`pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed`, only
`dist/pgrust/postgres-threads.wasm` swapped between Runs, interleaved cur new new cur cur new. These
are the clean re-run set, taken behind a gate that also waited for no build and no valgrind on the
machine; the first set ran beside other work and was discarded. The PGlite OPFS control was
8 683–9 026 ms across the six Runs. pgrust ms, r1 / r2 / r3:

| Benchmark | current `c499994c` | `be79c787` | new ÷ current (medians) |
| --- | --- | --- | ---: |
| Warm-up | 879.6 / 832.7 / 862.5 | 896.2 / 964.1 / 953.0 | 1.105× |
| Test 3 | 1 056.4 / 1 071.4 / 984.1 | 964.1 / 939.9 / 958.4 | 0.907× |
| Test 9 | 2 512.2 / 2 377.4 / 2 373.5 | 2 248.4 / 2 357.4 / 2 324.7 | 0.978× |
| Test 10 | 2 850.3 / 2 798.9 / 2 703.3 | 2 610.5 / 2 772.9 / 2 736.8 | 0.978× |
| Test 11 | 306.4 / 294.8 / 282.1 | 260.8 / 281.9 / 279.4 | 0.948× |
| Test 14 | 251.4 / 239.8 / 238.5 | 225.2 / 224.8 / 211.7 | 0.938× |
| **Suite** | 11 076.3 / 10 808.2 / 10 533.1 | 10 286.6 / 10 650.4 / 10 366.7 | **0.959×** |

Rows 3 and 14 do not overlap between the modules; the Suite ranges do. The Warm-up is 10% slower on
the new module and that is not explained.

## 5. The Galaxy A/B

The published page at bench `a2edf4b`, the Speedtest on
`pglite-memory,pgrust-postmaster-opfs-repacked-relaxed` with `?brokerStats=1`, one fresh tab per Run:
**D** is the page's default (threads module `c499994c…`), **F** is `&pgrustModule=be79c787`, both on
the default 200 µs broker spin. They were interleaved with a third arm, **Z** (`&brokerSpin=0`), which is
[the phone broker-spin note](2026-09-26-phone-broker-spin.md)'s (§8 there, with the session's
conditions in full); the order was D F Z, Z F D, D F Z. Before every click the driver refused the Run
unless the environment line said `broker spin: 200 µs`, F's also `pgrust module: be79c787
(alternate)` and D's no `pgrust module:` entry, the header had the row only this build renders, and a
`HEAD` of `pgrust/alt/be79c787/postgres-threads.wasm` answered 200. The gate was thermal status 0,
the battery at or below 33.0 °C and every CPU cluster at its hardware maximum (ambient close to
30 °C, the screen at minimum brightness); every Run cleared it in 0–1 s, and no Run hit the hard cap.
r1-D was the first Run of the new build and loaded cold (44 s from click to completion against
32–33 s); its cells are timed inside the worker.

| Run | arm | pgrust total (ms) | PGlite Memory total (ms) | Warm-up pgrust (ms) | Session backend blocked ms | every thread blocked ms | guest opens (Test rows) | ms in guest opens | Chrome CPU-s | caps in the pgrust column |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1-D | D | 13 304.8 | 7 263.0 | 1 222.8 | 1 450.5 | 1 726.8 | 874 | 160.4 | (cold) | step |
| r1-F | F | 13 164.9 | 7 123.1 | 1 300.7 | 1 352.5 | 1 666.2 | 114 | 34.1 | 58.31 | step |
| r2-F | F | 13 190.1 | 7 125.1 | 1 265.4 | 1 244.7 | 1 519.1 | 114 | 24.8 | 57.81 | none |
| r2-D | D | 12 955.6 | 7 318.8 | 1 335.3 | 1 293.3 | 1 586.3 | 874 | 180.8 | 56.31 | none |
| r3-D | D | 13 611.6 | 7 212.8 | 1 330.2 | 1 365.3 | 1 670.8 | 876 | 167.6 | 58.02 | step |
| r3-F | F | 13 223.9 | 7 084.3 | 1 154.7 | 1 254.6 | 1 546.2 | 113 | 24.5 | 56.29 | step |

"ms in guest opens" is every guest thread's time inside `open` calls over the 18 rows, from the
**pgrust guest file calls** table; Chrome CPU-s is the summed CPU time of every Chrome process from
click to completion (the broker-spin note's §9 has the method).

Guest open calls per row, the same Runs:

| Run | arm | row 3 | row 9 | row 10 | row 11 | row 14 | Suite (18 rows) | Warm-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1-D | D | 267 | 148 | 147 | 76 | 143 | 874 | 99 |
| r1-F | F | 20 | 10 | 3 | 7 | 3 | 114 | 93 |
| r2-F | F | 20 | 10 | 3 | 7 | 3 | 114 | 92 |
| r2-D | D | 267 | 148 | 147 | 74 | 144 | 874 | 98 |
| r3-D | D | 269 | 148 | 149 | 74 | 142 | 876 | 98 |
| r3-F | F | 19 | 10 | 3 | 7 | 3 | 113 | 92 |

pgrust ms per row, mean of the three Runs:

| arm | row 2 | row 3 | row 6 | row 9 | row 10 | row 11 | row 14 | Warm-up | Suite |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D | 1 592 | 1 262 | 66 | 2 976 | 3 366 | 341 | 277 | 1 296 | 13 291 (12 956–13 612) |
| F | 1 594 | 1 256 | 80 | 2 939 | 3 328 | 341 | 241 | 1 240 | 13 193 (13 165–13 224) |
| F ÷ D | 1.00× | 1.00× | 1.21× | 0.99× | 0.99× | 1.00× | 0.87× | 0.96× | 0.99× |

µs per broker request, blocked / serving:

| Run | arm | row 2 | row 3 | row 9 | row 11 | row 14 |
| --- | --- | --- | --- | --- | --- | --- |
| r1-D | D | 792 / 332 | 243 / 169 | 442 / 253 | 169 / 124 | 151 / 127 |
| r1-F | F | 760 / 378 | 310 / 216 | 479 / 250 | 211 / 183 | 154 / 127 |
| r2-F | F | 680 / 366 | 295 / 206 | 449 / 228 | 134 / 110 | 145 / 121 |
| r2-D | D | 591 / 374 | 238 / 164 | 383 / 200 | 148 / 116 | 161 / 134 |
| r3-D | D | 725 / 322 | 256 / 171 | 388 / 209 | 156 / 128 | 140 / 115 |
| r3-F | F | 805 / 408 | 266 / 195 | 434 / 218 | 162 / 130 | 147 / 124 |

Row 3's requests are longer on average with the fix (266–310 against 238–256 µs blocked) because the
requests it removed were shorter than the rest: the row's broker requests fall from 889–892 to
641–643, and its every-thread blocked time only from 211–228 to 171–199 ms, about 130 µs for each
request removed against the row's 238–256 µs average.

## 6. Verdict

- **The fix removes the same work on the phone as on the desktop.** Guest opens 874–876 → 113–114 a
  Suite, row 3 267–269 → 19–20, rows 10 and 14 to 3; the Warm-up 98–99 → 92–93.
- **That work was about 140 ms of guest thread time a Suite on this phone.** The opens took 160–181 ms
  on the current module and 25–34 ms on the fix module, 0.18–0.21 ms an open at the default 200 µs
  spin. Without the spin the same opens took 251–281 ms in the interleaved `&brokerSpin=0` Runs,
  0.29–0.32 ms an open: less than the 0.4–0.6 ms `ea6c68b2e4`'s message estimates for a phone.
- **The Suite total does not move beyond the noise.** 13 165–13 224 ms against 12 956–13 612 ms,
  −0.7% on the means: 140 ms of thread time is about 1% of the Suite, and the current module's own
  spread here is 650 ms. The Session backend's blocked time is 6% lower (1 245–1 353 against
  1 293–1 451 ms), with the ranges overlapping.
- **Row 14 is faster and row 6 slower, both outside the other arm's range.** Row 14 is 236–246 ms
  against 262–291 (0.87×), as on the desktop (0.94×, the ranges apart there too). Row 6, Creating an
  index, is 79–82 ms against 61–73 (1.21×, 14 ms); the desktop A/B did not report it, and why is not
  known.
- **The Warm-up is not slower here.** 1 155–1 301 ms against 1 223–1 335 (0.96×), where the desktop
  had it 1.105× slower.
- **No CPU cost.** 56.3–58.3 Chrome CPU-s a Run on the fix module against 56.3–58.0 on the current
  one (the cold r1-D left out); the caps were the same in both arms (step caps in two Runs of each).

On this phone the module does what it says and costs nothing, and the Suite cannot see the time it
saves. Whether it becomes the page's default is the owner's call; the phone gives no speed reason
either way.

## 7. What this does not show

- **A phone speed-up.** Three Runs per module; the effect the removed opens can have is about 1% of
  the Suite, and this A/B cannot resolve 1%.
- **Why row 6 is slower on the fix module on the phone, or why the Warm-up was slower on the
  desktop.** Neither was investigated. Creating an index creates a file, which moves the
  file-creation generation and throws every cached answer away; whether that costs anything was not
  measured.
- **The two commits apart.** The watchdog change removes two failed opens a second while an Engine
  is open; no Run here separates it from the absent-fork cache.
- **Correctness beyond the gate.** The cache is invalidated by every file creation through vfs and
  by the creation paths `ea6c68b2e4` bumps by hand. A creation path that bypasses both would leave
  `mdexists` answering "absent" for a fork that exists; the gate (the six lanes, the pgxsinkit suite,
  the FSM-reuse check) found none, and nothing searched for one beyond the commit's own review.
- **Any other Suite, phone or browser on the phone side.** The Speedtest only, on one Galaxy S22+ in
  Chrome 153; no RTT, Concurrency or Prepared Suite on the phone, no OnePlus, no Safari.
- **Energy.** CPU-seconds are the proxy, not joules.

## Reproduction

```
# the fix: pgrust spike/wasip1-threads at be79c78758, the profile-guided threads module rebuilt there
# and published as pgrust-assets/be79c787; bench a2edf4b carries it as ?pgrustModule=be79c787
# the Galaxy A/B (D and F here; Z is the broker-spin note's), scratch and untracked
bun tmp/agents/spin-adopt/drive.ts --runs r1-D,r1-F,r1-Z,r2-Z,r2-F,r2-D,r3-D,r3-F,r3-Z,cpu-S500,cpu-S1000
SPIN_PER_REQUEST_ROWS=2,3,9,11,14 bun tmp/agents/spin-adopt/tables.ts galaxy
```

By hand, on any phone:
<https://pgxsinkit.github.io/pglite-v-pgrust/?brokerStats=1&configurations=pglite-memory,pgrust-postmaster-opfs-repacked-relaxed&baseline=pglite-memory>
against the same URL with `&pgrustModule=be79c787`; each export's **Store work** tables carry the
open counts.
