# pgrust wasm: `wasm-opt`'s inliner costs 2.3× on the FIRST workload after boot

Found 2026-09-19 against pgrust `spike/wasip1-threads@31b5259d22` and `723e822059` (the shipped
module), Chromium 149.0.7827.55 headless, Node 26.9.0 (V8) and bun (JavaScriptCore) on the same
machine (i7-1165G7, 8 threads).

Speedtest row 1 — 1000 single-statement autocommit `INSERT`s — is 2.1–2.3× slower on the 0.3-line
module than on the 0.2-line module, while seven other rows and the Suite total are 1.5–1.6× FASTER.
None of the four candidate differences that were suspected explains it. **The whole regression is
the `wasm-opt` pass our own build script runs after the link** (`wasm/wasm-build.sh`, spike commit
`e5f4bd9e71`, level `-Oz`): the identical cargo link without that pass runs row 1 in half the time,
and the same link through `wasm-opt -O0` or `-O1` is equally fast — `-O2` and above are the slow
ones.
The cost is not in the code Binaryen emits but in what V8 does with it: with
`--js-flags=--liftoff-only` (tier-up forbidden) the gap collapses from 2.2× to 1.3×, and with
`--js-flags=--no-liftoff` (TurboFan for everything) the optimised module is 6.4 s against the
unoptimised module's 2.6 s. Row 1 is the first thing the guest runs after boot, so it is the row
that pays for V8 compiling the module underneath it.

Inside the pass it is **one-caller inlining**, one flag (§8). `wasm-opt -Oz -ocimfs=0` runs row 1 in
513–520 ms, row 2 20 % faster, every other row level, and produces a module **122 820 bytes smaller**
than the one that ships. On a module this shape Binaryen's one-caller inliner does not pay for
itself in bytes and costs a 2.4× first workload.

**The module that ships today (`765b06fb`, adopted in `6209440`) has the defect**: it is the
fat-LTO link plus `wasm-opt -Oz`, and it runs row 1 in 1168–1310 ms against its own pre-Binaryen
link's 523–532 ms, its own `-O1` build's 520–533 ms (§7) and its own inliner-free `-Oz` build's
515–517 ms (§8).

---

## 1. The measured fact

Headless Chromium, `pgrust-postmaster-opfs-repacked-relaxed` (postmaster mode, OPFS-backed repacked
store through the broker, `synchronous_commit=off`), one connection, Speedtest row 1 = 1000 INSERTs
each as its own simple-query message:

| module      | what it is                                                             |      bytes | Test 1 (ms)                       |
| ----------- | ---------------------------------------------------------------------- | ---------: | --------------------------------- |
| `arm-A0`    | 0.2 line, release `e8e8ee06`, no Binaryen                              | 46 431 092 | 501.5 / 474.9 / 484.4             |
| `arm-D87`   | 0.3 line, FIRST publish `d87d883e`, full features, no Binaryen         | 53 414 445 | 463.8 / 477.7                     |
| `arm-B-raw` | 0.3 line `31b5259d`, browser features, **no Binaryen**                 | 50 831 423 | 469.7 / 461.3                     |
| `arm-A`     | the same link **+ `wasm-opt -Oz`** (= the published 0.3 module)        | 37 210 023 | 1057.9 / 1115.6 / 1110.8          |
| `arm-D-raw` | opt-level 3 + fat LTO link (today's settings), no Binaryen             | 45 880 406 | 531.7 / 523.2 / 531.0             |
| `arm-DO0`   | the same link **+ `wasm-opt -O0`** (round trip, no optimisation)       | 43 070 278 | 519.2 / 517.8                     |
| `arm-DO1`   | the same link **+ `wasm-opt -O1`**                                     | 41 442 596 | 532.6 / 520.0 / 519.7             |
| `arm-DO2`   | the same link **+ `wasm-opt -O2`**                                     | 41 056 758 | 1196.5 / 1243.1                   |
| `arm-D2`    | the same link **+ `wasm-opt -Oz`** = **the shipped module** `765b06fb` | 40 127 758 | 1206.0 / 1167.7 / 1234.9 / 1309.9 |
| `arm-DO2NI` | the same link **+ `-O2` with the inliner off**                         | 41 134 428 | 522.4 / 519.4                     |
| `arm-DOZNI` | the same link **+ `-Oz` with the inliner off**                         | 40 004 932 | 516.5 / 515.2                     |
| `arm-DOZC0` | the same link **+ `-Oz -ocimfs=0`** (one-caller inlining off, only)    | 40 004 938 | 519.5 / 513.2                     |

Each row is one bench invocation running that Configuration **alone** (see §2 on why that matters),
machine idle (1-minute load 0.2–1.3), module swapped into `dist/pgrust/postgres-threads.wasm` and
the published bytes restored afterwards. `arm-A-repro.wasm` is byte-identical to `arm-A.wasm`
(sha256 `7737d8b3ab83…`), which is what pins `arm-B-raw` as exactly `arm-A`'s pre-Binaryen input;
`arm-D2` is byte-identical to `public/pgrust/postgres-threads.wasm` (sha256 `765b06fb904d…`).

Prior-art numbers this reproduces (`tmp/agents/prof/collected.txt`, another agent, same machine,
pglite-memory in the same page): A0 627.2 / 539.2, A 1121.8 / 1234.8, B (`-O3`) 1164.9 / 1170.4,
D (`-O3` over fat LTO) 1323.5 / 1321.9. `-O3` and `-Oz` are equally bad, which is why the earlier
sitting concluded "the Binaryen level is worth nothing": both levels it compared are on the wrong
side of the cliff. The cliff is between `-O1` and `-O2` (§7).

## 2. Row 1 is a warm-up measurement

Two Configurations in one page, memory store first and OPFS store second, **same module bytes**:

| arm | `pgrust-postmaster-memory-broker` (ran first) | `pgrust-postmaster-opfs-repacked-relaxed` (ran second) |
| --- | --------------------------------------------- | ------------------------------------------------------ |
| A0  | 423.3                                         | 109.5                                                  |
| A   | 582.0                                         | 97.1                                                   |

The second engine in the same browser process runs row 1 in a tenth of the time, on a fresh guest
with cold catalogs and a different store. What it inherits is V8's compiled code for those module
bytes. So row 1's headline number is dominated by a once-per-process cost attached to the MODULE,
not by SQL execution — and every number in §1 is therefore taken with one Configuration per run.

The store matters only as a second-order effect (more CPU competing with the compiler):

| store, single Configuration per run | A0    | A      | A/A0  |
| ----------------------------------- | ----- | ------ | ----- |
| memory broker                       | 402.5 | 570.0  | 1.42× |
| OPFS repacked, relaxed              | 501.5 | 1057.9 | 2.11× |

## 3. What V8 is doing: the flag experiment

Same runs, same arms, Chromium started with extra `--js-flags` (scratch copy of `scripts/bench.ts`
that forwards `BENCH_CHROMIUM_ARGS` into Playwright's `launch({args})`):

| Chromium `--js-flags`                                     | A0            | A (`-Oz`)       | B-raw (no Binaryen) | A/A0       |
| --------------------------------------------------------- | ------------- | --------------- | ------------------- | ---------- |
| _(default: Liftoff, lazy, background tier-up)_            | 501.5 / 474.9 | 1057.9 / 1115.6 | 469.7 / 461.3       | 2.11–2.35× |
| `--no-wasm-lazy-compilation` (eager baseline, tier-up on) | 328.0         | 897.2           | 318.7               | 2.74×      |
| `--liftoff-only` (**no tier-up, ever**)                   | 344.8         | **462.0**       | 329.3               | **1.34×**  |
| `--no-liftoff` (TurboFan only, lazily per function)       | 2899.2        | **6446.6**      | 2641.6              | 2.22×      |

Read together:

- Forbidding tier-up **halves** the `-Oz` module's row 1 (1058 → 462) and leaves the other two arms
  roughly where they were. The penalty is the tier-up work, not the quality of the baseline code.
- Making V8 compile everything with TurboFan turns the penalty into 6.4 s against 2.6 s: TurboFan
  costs ~2.4× more on the `-Oz` module than on the same link unoptimised. That is the same 2.4×,
  paid explicitly.
- Removing lazy compilation does not close the gap, so it is not a per-function _baseline_ compile
  cost either.

Inference (the mechanism, not measured directly): `wasm-opt`'s inliner (§8) produces code TurboFan
takes longer to compile — bigger function bodies, and duplicated ones — and that compilation runs on
background threads that this 8-thread machine has to share with the guest's own threads for exactly
as long as row 1 lasts. Rows 2–16 run after the storm and get the benefit
(`arm-D2` vs `arm-D-raw`: Test 7 840 vs 886, Test 9 3093 vs 3044, Test 10 4344 vs 4349 — a wash),
except Test 2, which is 1130 vs 1373 in favour of the unoptimised module.

`wasm-opt -O0` (a full Binaryen decode/re-encode with no optimisation passes, 45.9 MB → 43.1 MB)
is **harmless**: 519 / 518 ms. So it is the optimisation passes, not Binaryen's re-encoding, not the
stripped name section, and not the module being smaller.

## 4. Outside the browser the regression does not exist

Two harnesses, both on the saved arm modules, both `synchronous_commit=off`, machine idle.

**Node 26.9.0 (V8), pgrust's own runner** — one session thread, no postmaster, broker store,
`CREATE TABLE` + N single-statement INSERT messages:

| arm   | 1000 INSERTs         | 2000 INSERTs | per statement |
| ----- | -------------------- | ------------ | ------------- |
| A0    | 2143–2163 ms         | 4237 ms      | 2.12 ms       |
| A     | 2286–2319 ms         | 4281 ms      | 2.14 ms       |
| B-raw | 2341 ms (under load) | —            | —             |

Per-100-statement block means are flat from the first block (A0 2.11 → 2.05, A 2.14 → 2.15 over
2000 statements): no warm-up hump, no gap. Node's per-statement wall is dominated by a ~1.5 ms
SabPipe round trip, and the guest thread is idle for most of it, so V8's background compilation
never competes with the critical path.

**Bun (JavaScriptCore), the bench's own engine** (`createPgrustPglite`, node:worker_threads
postmaster + broker), 1000 awaited `exec()` calls:

| port   | A0                          | A                          |
| ------ | --------------------------- | -------------------------- |
| memory | 1612.3 (loaded) / **599.7** | 642.9 (loaded) / **589.4** |
| file   | 667.7 / 612.8 / 578.1       | 591.9 / 587.9 / 626.0      |

0.54–0.67 ms per statement — the same as the browser's 0.2-line row 1 — and no gap either way.

**A warning about load.** Every measurement taken while another agent's `cargo build` was running
(1-minute load 3–11) showed a spurious 7 % gap in node and a spurious 1.6× gap in the in-guest phase
trace. Repeated on an idle machine, both vanished. Nothing in this note is from a loaded run except
where it says so.

## 5. The backend is not doing more work per statement

**Phase trace** (`PGRUST_STMT_TRACE=1`, identical probe sets on both refs; node, broker, idle
machine, 999 statements, p50 microseconds):

| phase                                           |        A0 |         A |         Δ |
| ----------------------------------------------- | --------: | --------: | --------: |
| `rfq.flushed`→`read.Q` (host round trip)        |    1454.3 |    1422.8 |     −31.5 |
| `read.Q`→`q.xact` (prologue)                    |      37.4 |      41.7 |      +4.3 |
| `q.xact`→`q.parse`                              |      26.6 |      36.9 |     +10.3 |
| `q.parse`→`q.rewrite`                           |      86.3 |      86.8 |      +0.5 |
| `q.rewrite`→`q.plan`                            |      75.5 |      85.8 |     +10.3 |
| `q.plan`→`q.portalstart`                        |      15.1 |      15.9 |      +0.8 |
| `q.portalstart`→`q.run`                         |     132.9 |     139.8 |      +6.9 |
| `q.run`→`q.commit` (commit)                     |      88.3 |      88.1 |      −0.2 |
| `q.commit`→`cycle.end`                          |       5.1 |       6.1 |      +1.0 |
| `cycle.end`→`ready.begin`                       |       4.1 |       4.6 |      +0.5 |
| `ready.begin`→`ready.pre_rfq` (ready envelope)  |       6.4 |       9.5 |      +3.1 |
| `ready.pre_rfq`→`rfq.flushed`                   |      34.8 |      37.1 |      +2.3 |
| **whole in-guest cycle `read.Q`→`rfq.flushed`** | **525.8** | **558.3** | **+32.5** |

+33 µs per statement in the guest, i.e. +33 ms over row 1, against a browser regression of +600 ms.
(The trace itself adds 12 clock calls per cycle, which is why these totals exceed §4's.)

**Host-call census** (scratch instrumentation of the WASI import table, counting every call and
dumping totals at each wire write; differenced between write 200 and write 1000, so per autocommit
statement):

| WASI call                                                                                      |   A0 |        A |
| ---------------------------------------------------------------------------------------------- | ---: | -------: |
| `clock_time_get`                                                                               | 5.00 | **7.00** |
| `fd_read`                                                                                      | 1.00 |     1.00 |
| `fd_write`                                                                                     | 1.00 |     1.00 |
| `fd_pread`, `fd_pwrite`, `fd_sync`, `fd_datasync`, `path_open`, `path_filestat_get`, `fd_seek` |    0 |        0 |

The two extra clock calls are exactly the `idle_passivate_timeout` arm/disarm pair the desk study
predicted (candidate C1: `enable_timeout_after` + `disable_timeout`, one
`get_current_timestamp()` each). They are real, and they are worth ~3 µs per statement here. **No
extra file operation, no extra host round trip, no extra wake.**

## 6. Candidates killed

| candidate                                                                                        | killed by                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 `idle_passivate_timeout` (60 s default arming a timer per autocommit cycle)                   | `PGRUST_IDLE_PASSIVATE_SECS=0` moves nothing (2354 ms against a 2310–2319 ms baseline); the census prices its two clock calls at ~3 µs/statement                                                   |
| C2 shared catalog cache `l2cache` + L1 caps                                                      | `PGRUST_L2_CACHE=0`: 2296 ms, unchanged                                                                                                                                                            |
| C3 WAL flush pipeline                                                                            | `PGRUST_FLUSH_PIPELINE_TRACE=1` prints **zero** `flushpipe:` lines over 1000 INSERTs — the pipeline is never entered under `synchronous_commit=off`; `PGRUST_FLUSH_PIPELINE=0`: 2293 ms, unchanged |
| C4 admission gate                                                                                | `max_active_queries` boot value 0; no per-statement cost visible in the phase table (prologue +4 µs)                                                                                               |
| C5 `reuse_idle_stack`                                                                            | dies with C1 (same GUC), and the prologue phase moves by 4 µs                                                                                                                                      |
| C6 bulk-write governor                                                                           | `PGRUST_BULK_WRITE_GOVERNOR=off`: 2377 ms, unchanged; the census shows no writes per statement to govern                                                                                           |
| upstream 0.2 → 0.3 (PG 18.3 → 18.6)                                                              | `arm-D87`, the FIRST 0.3 publish (full features, no Binaryen), runs row 1 in 464 / 478 ms — as fast as the 0.2 line                                                                                |
| feature profile full → browser                                                                   | `arm-B-raw` (browser features, no Binaryen) 470 / 461 ms                                                                                                                                           |
| our spike commits between `d87d883e` and `31b5259d` (portal source text, per-parsetree contexts) | same: `arm-B-raw` carries all of them and is fast                                                                                                                                                  |
| the Binaryen LEVEL                                                                               | `-O3` (1165 / 1170) and `-Oz` (1058 / 1116) are the same; `-O0` (519 / 518) is not                                                                                                                 |
| the host/client round trip                                                                       | trace `rfq.flushed`→`read.Q` is 31 µs FASTER on the 0.3 module                                                                                                                                     |
| OPFS / the store                                                                                 | the memory-broker store shows the same regression at 1.42×; the census shows no per-statement file ops                                                                                             |

The knob runs in this table were taken while the machine was loaded; since the idle baseline shows
no gap at all outside the browser, none of them has anything left to explain.

## 7. `-O1` is the level that costs nothing here

`wasm-opt -O1` over the same fat-LTO link (32 s wall, against 221 s for `-Oz`) keeps almost the
whole size win and none of the penalty. Both columns below are from one sitting, interleaved:

| row                                         | `arm-DO1` (`-O1`) | `arm-D2` (`-Oz`, shipped) |
| ------------------------------------------- | ----------------: | ------------------------: |
| **Test 1: 1000 INSERTs**                    |         **520.0** |                **1309.9** |
| Test 2: 25000 INSERTs in a transaction      |            1109.1 |                    1247.1 |
| Test 3: 25000 INSERTs into an indexed table |            2802.9 |                    2896.3 |
| Test 7: 5000 SELECTs with an index          |             848.4 |                     832.0 |
| Test 9: 25000 UPDATEs with an index         |            3062.9 |                    3085.8 |
| Test 10: 25000 text UPDATEs with an index   |            4429.9 |                    4350.9 |
| Test 11: INSERTs from a SELECT              |            1974.3 |                    2005.1 |
| bytes                                       |        41 442 596 |                40 127 758 |

`-O1` is better or level everywhere except Test 7 and Test 10, which it loses by under 2 %, and it
is 2.5× better on row 1 for 1.3 MB (3.3 %) more module. `wasm/wasm-build.sh` already has the knob:
`PGRUST_WASM_OPT_LEVEL=-O1` (or `PGRUST_WASM_OPT=0` for the raw link, which costs 5.75 MB and is a
touch slower still than `-O1` on row 1's neighbours). §8 finds a better answer than either.

**The cliff is between `-O1` and `-O2`**, and `-O2` buys almost nothing for it (interleaved, same
sitting, 1-minute load 2.2–2.3):

| level over the same link |      bytes |   vs `-Oz` |     Test 1 (ms) |
| ------------------------ | ---------: | ---------: | --------------: |
| `-O1`                    | 41 442 596 | +1 314 838 |           519.7 |
| `-O2`                    | 41 056 758 |   +928 976 | 1196.5 / 1243.1 |
| `-Oz`                    | 40 127 758 |          — |       1168–1310 |

`-O2` is 386 KB smaller than `-O1` and 2.4× slower on row 1.

## 8. It is Binaryen's INLINING, and turning it off is free

`-O2` differs from `-O1` by a handful of passes; inlining is the one. Same level, same everything,
inlining's three size thresholds set to zero (`-aimfs=0 -fimfs=0 -ocimfs=0`):

| arm                               |          bytes |       Test 1 (ms) |
| --------------------------------- | -------------: | ----------------: |
| `-O2`                             |     41 056 758 |            1315.5 |
| `-O2 -aimfs=0 -fimfs=0 -ocimfs=0` |     41 134 428 | **522.4 / 519.4** |
| `-Oz` (**the shipped module**)    |     40 127 758 |            1200.3 |
| `-Oz -aimfs=0 -fimfs=0 -ocimfs=0` | **40 004 932** | **516.5 / 515.2** |

At `-Oz`, inlining does not even pay for itself in bytes: the module WITHOUT it is 122 826 bytes
**smaller**. The full row comparison against what ships today, one interleaved sitting:

| row                                       | `-Oz` no inlining | `-Oz` = shipped |
| ----------------------------------------- | ----------------: | --------------: |
| **Test 1: 1000 INSERTs**                  | **516.5 / 515.2** |      **1200.3** |
| Test 2: 25000 INSERTs in a transaction    |   1093.7 / 1117.7 |          1368.6 |
| Test 7: 5000 SELECTs with an index        |     859.5 / 847.1 |           850.3 |
| Test 9: 25000 UPDATEs with an index       |   3045.2 / 3036.1 |          3073.4 |
| Test 10: 25000 text UPDATEs with an index |   4425.8 / 4313.2 |          4353.5 |
| bytes                                     |        40 004 932 |      40 127 758 |

Smaller, 2.3× faster on row 1, 20 % faster on row 2, level everywhere else. This arm has only been
run through the Speedtest Suite twice — it has not been through the pgxsinkit suite or the node
proof lanes, so it is a candidate, not a verdict.

**It is ONE of the three: one-caller inlining.** Each threshold dropped on its own, over the same
link, at `-Oz`:

| arm                                           |                                                                                                                bytes |       Test 1 (ms) |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------: | ----------------: |
| `-Oz` (shipped)                               |                                                                                                           40 127 758 |   1204.8 / 1246.9 |
| `-Oz -fimfs=0` (flexible inlining off)        | 40 127 758 — **byte-identical** to the shipped module (sha256 `765b06fb904d…`), so the flag is a no-op at this level |   1293.5 / 1204.8 |
| `-Oz -ocimfs=0` (**one-caller inlining off**) |                                                                                                           40 004 938 | **519.5 / 513.2** |
| `-Oz -aimfs=0 -fimfs=0 -ocimfs=0` (all three) |                                                                                                           40 004 932 |     516.5 / 515.2 |

`-ocimfs=0` alone is six bytes off the all-three module and gets the whole win. Always-inline
(`-aimfs`, default max size 2) and flexible inlining (`-fimfs`, speed-only, inert at `-Oz`) are
innocent.

What one-caller inlining does to the module (`wasm-opt --metrics`), measured:

|                | shipped `-Oz` | `-Oz -ocimfs=0` |
| -------------- | ------------: | --------------: |
| functions      |        26 331 |      **33 568** |
| total IR nodes |    15 508 789 |      15 422 734 |
| bytes          |    40 127 758 |      40 004 938 |

It folds 7 237 functions — 21.6 % of them — into their single callers, so the shipped module carries
the same work in 27 % fewer, correspondingly larger function bodies. That is the input V8 has to
tier up: same code, fewer and bigger compilation units. It also ends up with slightly MORE IR and
more bytes than not doing it at all.

## 9. What is still open

- **Why TurboFan hates 27 % fewer, larger functions.** The input shape is now measured; the cost
  model is not. The plausible reading is that TurboFan's per-function cost grows faster than
  linearly (register allocation, scheduling) and that fewer units parallelise worse across the
  background compiler threads. `--trace-wasm-compilation-times` on both modules would settle it, and
  that is what a Binaryen or V8 issue would need.
- **Whether it is TurboFan compile time specifically.** `chrome://tracing`'s `v8.wasm` category, or
  `--trace-wasm-compilation-times` / `--print-wasm-code-size`, would price the tier-up storm
  directly instead of inferring it from `--liftoff-only`.
- **Whether other engines pay it.** Firefox and Safari were not run. Bun's JavaScriptCore does not
  (§4), node's V8 does not on this harness, but node never exposes the critical path to it.
- **Whether row 1 is the only victim in real use.** Anything that runs a short burst of statements
  immediately after boot pays the same storm — a page that opens a store and answers three queries
  is exactly row 1's shape. The Suite hides this because rows 2–16 run warm.
- **Machine dependence.** 8 threads. On a 4-thread machine the compiler and the guest would contend
  harder; on 16 they would not.

## 10. Reproduction

Browser (the decisive one, ~25 s per arm):

```bash
cd /home/anton/dev/tmp/pglite-v-pgrust
# one Configuration per run, or the second one measures a warm code cache
CONFIGS=pgrust-postmaster-opfs-repacked-relaxed TAG=x ROUNDS=1 ARMS="D-raw D2" \
  ./tmp/agents/row1/browser-ab.sh          # swaps dist/pgrust/postgres-threads.wasm, restores it
grep -E '^\| Test 1: ' $(ls -t tmp/results/*.md | head -2)
```

The V8 flag arms (scratch copy of `scripts/bench.ts` with `args: process.env.BENCH_CHROMIUM_ARGS`):

```bash
BENCH_SCRIPT=tmp/agents/row1/bench-flags.ts BENCH_CHROMIUM_ARGS="--js-flags=--liftoff-only" \
CONFIGS=pgrust-postmaster-opfs-repacked-relaxed TAG=lo ROUNDS=1 ARMS="A0 A" \
  ./tmp/agents/row1/browser-ab.sh
```

Making the arms by hand from ONE link — `arm-D-raw.wasm` is the pre-Binaryen link of the shipped
module, so every arm below differs from it by the `wasm-opt` invocation alone:

```bash
cd /home/anton/dev/tmp/pgrust/tmp/agents/profiles
FEAT="--enable-threads --enable-bulk-memory --enable-bulk-memory-opt --enable-call-indirect-overlong
      --enable-exception-handling --enable-extended-const --enable-multivalue --enable-mutable-globals
      --enable-nontrapping-float-to-int --enable-reference-types --enable-sign-ext"
wasm-opt -Oz $FEAT arm-D-raw.wasm -o arm-D2.wasm                       # what ships: slow
wasm-opt -Oz -aimfs=0 -fimfs=0 -ocimfs=0 $FEAT arm-D-raw.wasm -o arm-DOZNI.wasm   # smaller AND fast
wasm-opt -O1 $FEAT arm-D-raw.wasm -o arm-DO1.wasm                      # fast
wasm-opt -O2 $FEAT arm-D-raw.wasm -o arm-DO2.wasm                      # slow
```

(`-Oz` takes ~220 s on this machine, `-O1` ~32 s. The feature list is wasm-build.sh's; `--all-features`
produces a module V8 refuses.)

Making the two ends of the A/B through the build script instead:

```bash
cd /home/anton/dev/tmp/pgrust
PGRUST_WASM_TARGET=wasm32-wasip1-threads PGRUST_WASM_PROFILE=wasm-release \
PGRUST_WASM_FEATURES=browser PGRUST_WASM_OPT=0 wasm/wasm-build.sh     # the fast module
PGRUST_WASM_TARGET=wasm32-wasip1-threads PGRUST_WASM_PROFILE=wasm-release \
PGRUST_WASM_FEATURES=browser wasm/wasm-build.sh                        # + wasm-opt -Oz, the slow one
```

Outside the browser (neither reproduces the regression; both are useful as controls):

```bash
# node, pgrust's own runner, one statement per line
cd /home/anton/dev/tmp/pgrust
PGRUST_WASM_THREADS=$PWD/tmp/agents/profiles/arm-A.wasm \
PGRUST_REPACKED_BUNDLE=file://$PWD/wasm/vendor/pglite-opfs-repacked.js \
PGRUST_WIRE_GUCS="timezone=UTC,log_timezone=UTC,synchronous_commit=off" \
  node tmp/agents/row1/runner.mjs --dispatch stdio-wire-threaded --fs broker \
       --sql tmp/agents/row1/row1.sql --quiet

# bun, the bench's own postmaster engine
cd /home/anton/dev/tmp/pglite-v-pgrust
PGRUST_ROW1_MODULE=/home/anton/dev/tmp/pgrust/tmp/agents/profiles/arm-A.wasm \
  bun tmp/agents/row1/bun-row1.ts            # ROW1_BACKEND=file for the persistent port
```

`tmp/agents/row1/runner.mjs` is a scratch copy of `wasm/run-node-wire-threads.mjs` with three
additions: every `PGRUST_*` variable in the host environment is forwarded into the guest's WASI
environ (the original forwards none, so `PGRUST_STMT_TRACE` and the knobs never arrived), `--quiet`
for the 1000-statement transcript, and a per-statement stats line. `tmp/agents/row1/wasmcopy/` is a
mirror of `wasm/` whose `threads-host.js` counts WASI imports when `PGRUST_CENSUS` names a file
(a parked worker never flushes `console.error`, hence the synchronous append). Nothing tracked in
either repository was modified.
