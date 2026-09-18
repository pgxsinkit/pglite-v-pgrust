# Speed first: the cargo profile is worth 13% of the Suite, the Binaryen level nothing — and 0.3 lost row 1

- Date: 2026-09-18
- Runtime: bun 1.4.2 and node 26.9.0 on Linux 7.0.0-31-generic (x86_64, i7-1165G7, 8 logical cores);
  every browser number in headless Chromium 149.0.7827.55 (the full build, not the headless shell)
- Engine: pgrust `31b5259d22` on `spike/wasip1-threads`, the module published as
  `pgrust-assets/31b5259d` — upstream base v0.3 (`79ad992ede`, PostgreSQL 18.6)
- Regression reference: the 0.2-line module from `pgrust-assets/e8e8ee06` (pgrust `e8e8ee061d`,
  upstream `438c8c42`, PostgreSQL 18.3)
- Drivers: `wasm/wasm-build.sh` and `wasm/run-node-wire-threads.mjs` in the pgrust checkout;
  `bun run bench --no-build --suite speedtest|rtt` and `bun run probe:wasm-instantiate` here
- Nothing was adopted. No pgrust file was edited and no pgrust commit was made; the published module
  was restored into the build tree afterwards, byte for byte

## The question

`[profile.wasm-release]` was chosen for size and measured for speed once, on the 0.2 line
(pgrust `wasm/BUILD-PROFILES.md`, 2026-09-07). Since then the module changed three times: the
0.3 rebase, the `browser` feature profile, and a `wasm-opt -Oz` pass in the build. So: on the module
that is published **today**, what is the cargo profile worth, what is the Binaryen level worth, and
did 0.3 cost anything the 0.2 line had?

## The arms

All five are `wasm32-wasip1-threads` modules. Only `dist/pgrust/postgres-threads.wasm` was swapped
between runs; the store adapter, the host, `vfs.img` (byte-identical across the two releases) and the
page were never touched.

| Arm | cargo profile | Binaryen | what it is |
| --- | --- | --- | --- |
| **A0** | `opt-level = "s"`, `lto = false`, `codegen-units = 16` | none | the 0.2-line module, release `pgrust-assets/e8e8ee06` |
| **A** | `opt-level = "s"`, `lto = false`, `codegen-units = 16` | `-Oz` | the published module, release `pgrust-assets/31b5259d` |
| **B** | same link as A, bit for bit | `-O3` | the Binaryen level, and nothing else, changed |
| **C** | `opt-level = 3`, `lto = "thin"`, `codegen-units = 1` | `-O3` | |
| **D** | `opt-level = 3`, `lto = "fat"`, `codegen-units = 1` | `-O3` | |

**A0 is not a single-variable control.** It differs from A in four ways at once — PostgreSQL 18.3
against 18.6, the whole-contrib `full` feature set against `browser`, no Binaryen pass against `-Oz`,
and every engine change on the spike line between `e8e8ee061d` and `31b5259d22`. It is here to answer
"did anything get slower", not "why".

### How each was built

A, as published (not rebuilt here — the module was copied out of pgrust's build tree, sha256
`7737d8b3…`, which is byte-identical to the copies this repo synced from the release into `dist/` and
`public/`):

```
LC_ALL=C PGRUST_WASM_TARGET=wasm32-wasip1-threads PGRUST_WASM_PROFILE=wasm-release \
  PGRUST_WASM_FEATURES=browser wasm/wasm-build.sh
```

B — the same cargo units, re-uplifted with the Binaryen pass switched off, then optimised by hand
with exactly the feature list `wasm/wasm-build.sh` passes for the threads target (never
`--all-features`, for the reason `2026-09-16-wasm-opt-pass.md` records):

```
LC_ALL=C PGRUST_WASM_TARGET=wasm32-wasip1-threads PGRUST_WASM_PROFILE=wasm-release \
  PGRUST_WASM_FEATURES=browser PGRUST_WASM_OPT=0 wasm/wasm-build.sh
wasm-opt -O3 --enable-threads --enable-bulk-memory --enable-bulk-memory-opt \
  --enable-call-indirect-overlong --enable-exception-handling --enable-extended-const \
  --enable-multivalue --enable-mutable-globals --enable-nontrapping-float-to-int \
  --enable-reference-types --enable-sign-ext  postgres.wasm -o arm-B.wasm
```

That the A/B pair is a one-variable comparison was checked rather than assumed: running `-Oz` with
the same flags over the same 50 831 423-byte link reproduces the published module **byte for byte**
(sha256 `7737d8b3…`, 173.0 s).

C and D — the profile set through cargo's environment overrides, so `Cargo.toml` was never touched:

```
LC_ALL=C PGRUST_WASM_TARGET=wasm32-wasip1-threads PGRUST_WASM_PROFILE=wasm-release \
  PGRUST_WASM_FEATURES=browser PGRUST_WASM_OPT=0 \
  CARGO_PROFILE_WASM_RELEASE_OPT_LEVEL=3 \
  CARGO_PROFILE_WASM_RELEASE_LTO=thin   # fat, for D \
  CARGO_PROFILE_WASM_RELEASE_CODEGEN_UNITS=1 \
  wasm/wasm-build.sh
```

The override does reach the custom profile. Cargo's own unit graph, asked for under D's environment:

```
main_main profile: {"name": "wasm-release", "opt_level": "3", "lto": "fat", "codegen_units": 1, …}
```

and the rustc lines during C's build carry `-C opt-level=3 -C linker-plugin-lto -C codegen-units=1`.

## Build cost and size

| Arm | cargo (link leg) | Binaryen | raw before | raw after | gzip -9 | sha256 |
| --- | --- | --- | --- | --- | --- | --- |
| A0 | not built here | — | — | 46 431 092 | 13 304 907 | `0558dd88…` |
| A | as published | `-Oz` 173.0 s | 50 831 423 | **37 210 023** | **12 820 991** | `7737d8b3…` |
| B | shared with A (11.4 s re-uplift) | `-O3` 226.7 s | 50 831 423 | 38 319 075 | 13 002 664 | `dae6062b…` |
| C | **5 m 43 s** | `-O3` 222.3 s | 50 790 552 | 42 053 309 | 14 451 147 | `89530ae1…` |
| D | **10 m 28 s** | `-O3` 335.6 s | 45 880 406 | 40 635 385 | 14 112 922 | `1385330c…` |

The cargo column is cargo's own `Finished` line for the build-std + link leg, with the script's crate
check leg already cached; D's full script wall, including that cached leg and the unwind smoke, was
639.5 s. A profile change invalidates every unit in the target directory, so C and D are each a full
recompile of that directory — build-std plus `main_main`'s whole graph — not an incremental one.

Against A, the arm actually shipped: C costs **+4.8 MB raw and +1.63 MB gzipped** (+12.7%), D costs
**+3.4 MB raw and +1.29 MB gzipped** (+10.1%), and both cost 6–11 minutes of build. Fat LTO is again
the smallest **link** of the three (45.9 MB against 50.8 MB), as it was on the 0.2 line, and again the
slowest to produce.

## Boot proofs

`PGRUST_WASM_THREADS=<arm> node wasm/run-node-wire-threads.mjs --dispatch postmaster --fs broker`,
in the pgrust checkout:

| Arm | Result |
| --- | --- |
| A0 | PASS — `VERDICT: postmaster-node PASS fs=broker` |
| A | PASS |
| B | PASS |
| C | PASS |
| D | PASS |

No arm was dropped. All five also ran the browser Speedtest to completion with zero reported
failures.

## Speedtest

Two interleaved rounds in the order A0, A, B, C, D, A0, A, B, C, D, one module swap between each,
`--configurations pglite-memory,pgrust-postmaster-opfs-repacked-relaxed --baseline pglite-memory`.
Each run started with the 1-minute load between 1.43 and 2.45 (the harness waits for < 2.5 and
records it), and no run reported a single Suite failure. Better of the two rounds, pgrust
milliseconds, lower is better:

| Benchmark | PGlite (mean of the 10 runs) | A0 | A | B | C | D |
| --- | --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 61.9 | 539.2 | 1121.8 | 1164.9 | 1276.9 | 1321.9 |
| 2: 25000 INSERTs in a transaction | 589.9 | 5835.0 | 1733.1 | 1764.0 | 1270.2 | 1264.1 |
| 2.1: 25000 INSERTs in single statement | 140.6 | 508.8 | 530.7 | 511.7 | 462.2 | 497.7 |
| 3: 25000 INSERTs into an indexed table | 761.5 | 6576.1 | 3310.7 | 3366.3 | 3095.3 | 3028.2 |
| 3.1: 25000 INSERTs indexed, single statement | 167.9 | 688.8 | 715.8 | 684.2 | 665.9 | 658.9 |
| 4: 100 SELECTs without an index | 319.3 | 446.8 | 438.8 | 411.5 | 442.4 | 429.1 |
| 5: 100 SELECTs on a string comparison | 806.6 | 715.0 | 758.9 | 758.4 | 768.3 | 815.2 |
| 6: Creating an index | 29.5 | 159.1 | 155.6 | 155.8 | 149.9 | 148.5 |
| 7: 5000 SELECTs with an index | 461.7 | 1322.1 | 1086.3 | 1038.0 | 883.9 | 865.8 |
| 8: 1000 UPDATEs without an index | 169.5 | 275.7 | 272.4 | 253.6 | 217.8 | 210.8 |
| 9: 25000 UPDATEs with an index | 1376.6 | 5904.2 | 3823.3 | 3812.6 | 3165.0 | 3058.1 |
| 10: 25000 text UPDATEs with an index | 1736.6 | 8212.7 | 5071.5 | 5057.8 | 4432.3 | 4339.5 |
| 11: INSERTs from a SELECT | 288.0 | 2128.4 | 2157.2 | 2265.8 | 2170.3 | 2085.2 |
| 12: DELETE without an index | 26.0 | 57.5 | 56.5 | 60.6 | 51.0 | 54.9 |
| 13: DELETE with an index | 31.9 | 151.9 | 144.8 | 148.3 | 126.9 | 122.8 |
| 14: A big INSERT after a big DELETE | 168.9 | 907.1 | 886.5 | 937.0 | 859.3 | 803.3 |
| 15: A big DELETE then many small INSERTs | 246.0 | 1575.9 | 699.3 | 732.0 | 599.3 | 535.6 |
| 16: DROP TABLE | 4.8 | 25.7 | 28.1 | 30.9 | 28.9 | 30.4 |
| **Suite total** | **7387** | **36402** | **23136** | **23200** | **20831** | **20555** |
| **Suite total, × PGlite** | 1.0× | 4.9× | 3.1× | 3.1× | 2.8× | 2.8× |

The bench emits no total row; "Suite total" here is the sum of the 18 cells, and the PGlite column is
the mean of the ten controls (per-run totals 7148–7570, a 5.9% spread).

Both rounds, for the rows the question is about:

| Benchmark | A0 r1 / r2 | A r1 / r2 | B r1 / r2 | C r1 / r2 | D r1 / r2 |
| --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 627 / 539 | 1122 / 1235 | 1165 / 1170 | 1277 / 1356 | 1323 / 1322 |
| 2: 25000 INSERTs in a transaction | 5996 / 5835 | 1733 / 1863 | 1764 / 1861 | 1270 / 1305 | 1264 / 1375 |
| 3: 25000 INSERTs into an indexed table | 7029 / 6576 | 3311 / 3592 | 3366 / 3487 | 3113 / 3095 | 3028 / 3145 |
| 7: 5000 SELECTs with an index | 1322 / 1411 | 1086 / 1134 | 1038 / 1108 | 884 / 900 | 899 / 866 |
| 9: 25000 UPDATEs with an index | 6013 / 5904 | 3823 / 3961 | 3813 / 3942 | 3200 / 3165 | 3058 / 3113 |
| 10: 25000 text UPDATEs with an index | 8234 / 8213 | 5185 / 5071 | 5058 / 5232 | 4669 / 4432 | 4339 / 4610 |
| 11: INSERTs from a SELECT | 2128 / 2219 | 2157 / 2282 | 2266 / 2336 | 2198 / 2170 | 2178 / 2085 |
| 14: A big INSERT after a big DELETE | 907 / 978 | 886 / 946 | 982 / 937 | 859 / 860 | 852 / 803 |
| 15: A big DELETE then many small INSERTs | 1576 / 1653 | 699 / 710 | 732 / 736 | 610 / 599 | 597 / 536 |
| **Suite total** | **37294 / 36402** | **23136 / 23922** | **23200 / 24005** | **21035 / 20831** | **20555 / 20873** |
| PGlite control, same runs | 7285 / 7466 | 7148 / 7522 | 7191 / 7570 | 7300 / 7522 | 7429 / 7438 |

Round-to-round spread on the pgrust Suite total is 1.0–3.5% per arm, which is the resolution these
two rounds have.

### Speedup over A

Better run of each arm, A ÷ X (above 1 is faster than the published module):

| Benchmark | B (`-O3` only) | C (opt3/thin/1) | D (opt3/fat/1) |
| --- | --- | --- | --- |
| 1: 1000 INSERTs | 0.96× | 0.88× | 0.85× |
| 2: 25000 INSERTs in a transaction | 0.98× | 1.36× | 1.37× |
| 2.1: 25000 INSERTs in single statement | 1.04× | 1.15× | 1.07× |
| 3: 25000 INSERTs into an indexed table | 0.98× | 1.07× | 1.09× |
| 3.1: 25000 INSERTs indexed, single statement | 1.05× | 1.07× | 1.09× |
| 4: 100 SELECTs without an index | 1.07× | 0.99× | 1.02× |
| 5: 100 SELECTs on a string comparison | 1.00× | 0.99× | 0.93× |
| 6: Creating an index | 1.00× | 1.04× | 1.05× |
| 7: 5000 SELECTs with an index | 1.05× | 1.23× | 1.25× |
| 8: 1000 UPDATEs without an index | 1.07× | 1.25× | 1.29× |
| 9: 25000 UPDATEs with an index | 1.00× | 1.21× | 1.25× |
| 10: 25000 text UPDATEs with an index | 1.00× | 1.14× | 1.17× |
| 11: INSERTs from a SELECT | 0.95× | 0.99× | 1.03× |
| 12: DELETE without an index | 0.93× | 1.11× | 1.03× |
| 13: DELETE with an index | 0.98× | 1.14× | 1.18× |
| 14: A big INSERT after a big DELETE | 0.95× | 1.03× | 1.10× |
| 15: A big DELETE then many small INSERTs | 0.96× | 1.17× | 1.31× |
| 16: DROP TABLE | 0.91× | 0.97× | 0.92× |
| **Suite total** | **1.00×** | **1.11×** | **1.13×** |

Three things the table says, and nothing more:

- **The Binaryen level is worth nothing measurable.** B is 1.00× on the Suite and between 0.91× and
  1.07× on every row, in both directions, over a module 1.1 MB larger. `-O3` buys no speed here that
  these two rounds can see, and `-Oz` costs none.
- **The cargo profile is worth 11–13% of the Suite**, concentrated in the same places the 0.2-line
  study found: the big transactional writes (row 2, 1.36–1.37×), indexed updates (rows 9, 10,
  1.14–1.25×), indexed selects (row 7, 1.23–1.25×) and the composite rows 8, 13, 15 (1.11–1.31×).
- **C and D are not separated by these runs.** Their Suite totals (20831/21035 against 20555/20873)
  overlap; D leads by 1.3% on the better round, inside the round-to-round spread. D costs 83% more
  build time than C and is 1.4 MB smaller.

Row 1 is the one row where the profile arms are *slower* than A, consistently, in both rounds
(0.85–0.88×). See the regression section — it is the same row 0.3 lost, and the profile arms lose a
little more of it.

## RTT

One run per arm, `--suite rtt --iterations 5`, median over the 12 tests:

| Arm | pgrust median (ms) | PGlite median, same run (ms) | pgrust spread (min–max) |
| --- | --- | --- | --- |
| A0 | 1.996 | 0.521 | 0.495 – 4.764 |
| A | 3.071 | 0.537 | 0.621 – 42.594 |
| B | 2.417 | 0.487 | 0.635 – 33.813 |
| C | 5.264 | 0.502 | 0.650 – 51.526 |
| D | 3.133 | 0.537 | 0.462 – 35.109 |

**These medians do not separate the arms.** One run of five iterations produces single cells that
move by an order of magnitude between arms (test 7, update 1kb row: 42.6 ms on A against 4.8 ms on
A0 — and 51.5 ms on C, which is the fastest arm on the Suite). The 2026-09-07 study said the same
thing about three iterations and it is still true at five. Read the column as "all five answer all
12 tests", nothing finer.

## Instantiation

`bun run probe:wasm-instantiate --module <arm>`, Chromium 149, one run per arm, cold cache:

| Arm | module bytes | code section | compile (ms) | of which fetch | Δ RSS at compile (MiB) | instantiate (ms) | Δ RSS (MiB) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A0 | 46 431 092 | 39 369 538 | 172 | 138 | 145.8 | 13 | 8.5 |
| A | 37 210 023 | 30 136 181 | 128 | 101 | **115.8** | 10 | 7.3 |
| B | 38 319 075 | 31 248 019 | 128 | 105 | 118.7 | 10 | 7.4 |
| C | 42 053 309 | 35 324 267 | 128 | 105 | 128.8 | 10 | 7.1 |
| D | 40 635 385 | 34 519 323 | 129 | 102 | 124.6 | 9 | 6.8 |

Compile wall is flat at 128–129 ms for the four 0.3 modules regardless of 5 MB of size difference
(A0's 172 ms is mostly its 37 ms longer fetch). What tracks size is renderer memory: **+13.0 MiB of
RSS for C and +8.8 MiB for D** over the published module, in the compile step, on a machine with no
memory pressure. Every module declares the same 256 MiB shared memory import, and wasm memory after
instantiation is 256.0 MiB for all five.

## Did 0.3 regress anything against the 0.2 line?

A against A0, per round, from the interleaved rounds above. Ratio is A ÷ A0; above 1 means today's
module is slower.

| Benchmark | A0 r1 | A r1 | r1 | A0 r2 | A r2 | r2 | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1: 1000 INSERTs | 627 | 1122 | 1.79× | 539 | 1235 | 2.29× | **slower in both rounds** |
| 2: 25000 INSERTs in a transaction | 5996 | 1733 | 0.29× | 5835 | 1863 | 0.32× | faster in both |
| 2.1: 25000 INSERTs in single statement | 773 | 531 | 0.69× | 509 | 531 | 1.04× | — |
| 3: 25000 INSERTs into an indexed table | 7029 | 3311 | 0.47× | 6576 | 3592 | 0.55× | faster in both |
| 3.1: 25000 INSERTs indexed, single statement | 749 | 716 | 0.96× | 689 | 726 | 1.05× | — |
| 4: 100 SELECTs without an index | 473 | 439 | 0.93× | 447 | 445 | 0.99× | — |
| 5: 100 SELECTs on a string comparison | 797 | 775 | 0.97× | 715 | 759 | 1.06× | — |
| 6: Creating an index | 159 | 156 | 0.98× | 160 | 161 | 1.00× | — |
| 7: 5000 SELECTs with an index | 1322 | 1086 | 0.82× | 1411 | 1134 | 0.80× | faster in both |
| 8: 1000 UPDATEs without an index | 276 | 279 | 1.01× | 300 | 272 | 0.91× | — |
| 9: 25000 UPDATEs with an index | 6013 | 3823 | 0.64× | 5904 | 3961 | 0.67× | faster in both |
| 10: 25000 text UPDATEs with an index | 8234 | 5185 | 0.63× | 8213 | 5071 | 0.62× | faster in both |
| 11: INSERTs from a SELECT | 2128 | 2157 | 1.01× | 2219 | 2282 | 1.03× | — |
| 12: DELETE without an index | 57 | 56 | 0.98× | 64 | 58 | 0.90× | — |
| 13: DELETE with an index | 152 | 153 | 1.01× | 163 | 145 | 0.89× | — |
| 14: A big INSERT after a big DELETE | 907 | 886 | 0.98× | 978 | 946 | 0.97× | — |
| 15: A big DELETE then many small INSERTs | 1576 | 699 | 0.44× | 1653 | 710 | 0.43× | faster in both |
| 16: DROP TABLE | 26 | 28 | 1.09× | 28 | 32 | 1.12× | — |
| **Suite total** | 37294 | 23136 | 0.62× | 36402 | 23922 | 0.66× | faster in both |

**More than 15% slower in both rounds — one row:**

- **Test 1, 1000 single-statement autocommit INSERTs: 1.79× and 2.29× slower.** Against its own
  PGlite control in the same run, that is 19.7× and 20.1× PGlite today, against 10.3× and 8.5× on the
  0.2 module. This is the row the bite was called on, and it reproduces in both rounds.

**More than 15% faster in both rounds — seven rows:**

- Test 2, 25000 INSERTs in a transaction — 3.1–3.5× faster
- Test 3, 25000 INSERTs into an indexed table — 1.8–2.1× faster
- Test 15, a big DELETE then many small INSERTs — 2.2–2.3× faster
- Test 10, 25000 text UPDATEs with an index — 1.6× faster
- Test 9, 25000 UPDATEs with an index — 1.5–1.6× faster
- Test 7, 5000 SELECTs with an index — 1.2× faster
- The Suite total itself — 1.5–1.6× faster (36402 against 23136 ms on the better rounds)

No cause was investigated, and none is offered here. Note again that A0 carries four changes at once,
so "0.3 regressed row 1" is not what this measures: what it measures is that the module published
today is 1.8–2.3× slower on row 1 than the one published on the 0.2 line, and quicker on everything
that dominates the Suite.

## What this does and does not support

- **One machine, one browser.** An i7-1165G7 with 8 logical cores, headless Chromium 149 on Linux. No
  Safari, no WebKit, no phone, no other CPU. `2026-09-08-webkit-memory-diet.md` §8 lists what a
  Chromium number does not say about WebKit and all of it still applies.
- **One column of the bench.** `pgrust-postmaster-opfs-repacked-relaxed` against `pglite-memory`.
  Nothing here is about the other twelve configurations, the Concurrency Suite, or the single-session
  `wasm32-wasip1` module, which was not rebuilt or measured.
- **Two rounds.** Enough to say the Binaryen level does nothing and the cargo profile is worth about
  an eighth of the Suite; not enough to separate C from D, and — at five iterations — not enough for
  RTT to say anything at all.
- **Build walls are indicative, not clean-room.** A VM outside this work came up on the box at 22:50
  and took between 0.4 and 2 cores through the C and D builds. The Speedtest, RTT and instantiate
  runs were all started with the 1-minute load under 2.5, recorded per run.
- **The size-versus-speed trade is the owner's call.** This note sets no bar and assumes none. The
  numbers to trade are: C or D buys 11–13% of the Suite — 1.36–1.37× on the big transactional write,
  1.14–1.25× on the indexed update and select rows — for +1.29–1.63 MB gzipped, +8.8 to +13.0 MiB of
  renderer RSS at compile, 6–11 minutes of build, and 0.85–0.88× on row 1. B buys nothing at all for
  +0.18 MB gzipped.
- **Nothing was adopted.** `[profile.wasm-release]` and the `-Oz` pass in `wasm/wasm-build.sh` are
  exactly as they were; the published module is back in the build tree and in `dist/` and `public/`
  here, sha256 `7737d8b3ab8360f73e960b124adefe51530d4524e02837cca4604489bf4280d9`.
