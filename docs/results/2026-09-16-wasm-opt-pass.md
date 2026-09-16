# A Binaryen pass in the build: 14 MB off each module, and about 7% of the Speedtest

- Date: 2026-09-16
- Runtime: bun 1.4.2 and node 26.8.2 on Linux 7.0.0-31-generic (x86_64, 8 logical cores); the
  browser lanes in headless Chromium 149.0.7827.55 (the full build, not the headless shell)
- Engine: pgrust `e5f4bd9e71` on `spike/wasip1-threads` — one commit on top of `d87d883e8f`, the
  0.3-rebased line of `2026-09-16-pgrust-v0.3-rebase.md`, upstream base `79ad992ede` (PostgreSQL 18.6)
- Baseline: `d87d883e8f`, the release published as `pgrust-assets/d87d883e`, measured on this machine
  the same morning — threads module 53 414 445 bytes, Speedtest Suite total 47 970 ms, wasm memory
  263.6 MiB (`2026-09-16-pgrust-v0.3-rebase.md` §4)
- Drivers: `wasm/wasm-build.sh` in the pgrust checkout, the five node proof lanes there, and this
  repo's `tmp/agents/diet/chromium-check.ts` single-column Speedtest, `bun run bench --suite rtt`
  and `bun run probe:wasm-instantiate`

## What the pass is

`2026-09-08-wasm-size-map.md` §5 found that a fifth of the module is the same function bodies
repeated, and §9 measured what `wasm-opt -Oz` does about it on a copy of the 0.2 module: −27.2% raw,
boots, 152 s. That was a measurement on a copy in `tmp/agents/`; the build tree never saw it and
nothing shipped. This note is that pass moved **into** `wasm/wasm-build.sh`, run on both modules,
and — the thing §9 explicitly did not do — measured for speed.

The pass runs `wasm-opt -Oz` over `postgres.wasm` in place, immediately after the link, and only
when both of these hold:

- `PGRUST_WASM_PROFILE=wasm-release`. Dev builds — the gate's fast path — are untouched.
- `PGRUST_WASM_OPT` is not `0`. That is the opt-out, and it is the only one: under the release
  profile a missing Binaryen fails the build with a one-line message naming it, rather than quietly
  producing a module 14 MB larger than the one the numbers below describe.

**The feature list is spelled out in the script and has to stay that way.** The release profile
strips the module's `target_features` section, so wasm-opt cannot detect what the module uses, and
`--all-features` makes a *smaller* module that V8 then refuses to compile
(`CompileError: unknown import kind 0x7e`) — §9's finding, unchanged and unexplained. The list is
the names build's own feature set; only `--enable-threads` differs between the two targets.

## Both modules

Binaryen 132, one build at a time, i7-1165G7:

| Module | raw before | raw after | gzip -9 before | gzip -9 after | pass wall |
| --- | --- | --- | --- | --- | --- |
| `postgres-threads.wasm` (`wasm32-wasip1-threads`) | 53 414 445 | **39 040 753** (−26.9%) | 15 097 262 | **13 434 230** (−11.0%) | 306 s |
| `postgres.wasm` (`wasm32-wasip1`) | 53 265 180 | **38 410 184** (−27.9%) | 15 089 981 | **13 519 294** (−10.4%) | 299 s |

sha256 after the pass:

```
737762791ff9b34a6339ceb0ae2ad323856ebb03c4ea6f73c10fffa8ec87d0a0  postgres-threads.wasm
6ef8c4459bec38d12db1ff45e9108f9f52d93168c727f71ba9548ba5ad5d7be6  postgres.wasm
```

Fourteen megabytes off each module, for about five minutes of wall time on top of a build that
already takes five. Over the wire the win is smaller and still real: 1.6 MB off the gzipped threads
module, which is what a browser actually downloads. The single-session module gains slightly more raw
and slightly less gzipped than the threaded one — the two modules are within 150 KB of each other
before the pass and within 631 KB after it.

The pass does not touch the Cargo profile, which stays `opt-level = "s"`, `lto = false`,
`codegen-units = 16` exactly as `2026-09-08-wasm-size-map.md` and pgrust's own `wasm/BUILD-PROFILES.md`
left it. It is the duplicate elimination `lto = "fat"` would have done in the compiler, bought at
the link instead.

## The five proof lanes, on the optimised threads module

All five, in the pgrust checkout, against `target/wasm32-wasip1-threads/wasm-release/postgres.wasm`
as the pass left it:

| Lane | Decisive line | Verdict |
| --- | --- | --- |
| `--dispatch postmaster --fs broker` | `VERDICT: postmaster-node PASS fs=broker` — 12 spawned threads, 0 EAGAIN refusals, delta 5 files / 139 636 bytes into the one store | PASS |
| `--dispatch stdio-wire-threaded --fs broker --mount /pgeph=memory --sql wasm/tablespace-proof.sql` | `VERDICT: threads-node PASS fs=broker` — 13-statement script in 798 ms, `/pgeph` holds 7 files | PASS |
| `… --mount /pgdata/pg_tblspc=memory --sql wasm/tablespace-inplace-proof.sql` | `VERDICT: threads-node PASS fs=broker` — delta 11 files / 263 118 bytes, the mount holds 7 | PASS |
| `node wasm/tablespace-host-proof.mjs` | `VERDICT: tablespace-host-proof PASS` — the relation's bytes in the mount store, the symlink in the root store, 0 bytes of it in root | PASS |
| `node --test wasm/test/sab-pipe-host-gate.test.mjs` | `pass 6, fail 0` | PASS |

Nothing in the optimised module behaved differently from the unoptimised one these lanes had passed
the same morning.

## Speed: the Suite costs about 7% more

The controlled single-column Chromium Speedtest of `2026-09-08-webkit-memory-diet.md` §3, the same
lane the baseline was taken on:

```
DIST=dist bun tmp/agents/diet/chromium-check.ts \
  "?configurations=pgrust-postmaster-opfs-repacked-relaxed&postmasterTuning=pool:8,max_stack_depth=2048" \
  speedtest
```

| Module | wasm memory | Suite total | vs baseline |
| --- | --- | --- | --- |
| `d87d883e8f`, 53 414 445 bytes (baseline) | 276 365 312 B = **263.6 MiB** | **47 970 ms** | — |
| `e5f4bd9e71` `-Oz`, 39 040 753 bytes, run 1 | 276 299 776 B = 263.5 MiB | 51 515 ms | +7.4% |
| `e5f4bd9e71` `-Oz`, 39 040 753 bytes, run 2 | 276 365 312 B = **263.6 MiB** | **51 263 ms** | **+6.9%** |

The repo's own allowance for shipping a change like this is 15%, and the better run uses about half
of it. The two runs are 0.5% apart, so the cost is not noise: `-Oz` is a size-first pipeline and it
is charging roughly 7% of the Suite for its 27%. The memory number does not move at all — run 2's
`WebAssembly.Memory.buffer.byteLength` is byte-identical to the baseline's, which is the expected
result (the claim is the module's declared 256 MiB initial plus what the Suite grows, and the pass
changes neither).

Per cell, the two runs against each other — no per-cell baseline exists, only the Suite total:

| Benchmark | run 1 (ms) | run 2 (ms) |
| --- | --- | --- |
| 1: 1000 INSERTs | 1848.730 | 1717.740 |
| 2: 25000 INSERTs in a transaction | 7229.150 | 7146.930 |
| 2.1: 25000 INSERTs in single statement | 844.340 | 806.280 |
| 3: 25000 INSERTs into an indexed table | 9085.750 | 8947.125 |
| 3.1: 25000 INSERTs indexed, single statement | 1167.720 | 1158.945 |
| 4: 100 SELECTs without an index | 703.005 | 656.380 |
| 5: 100 SELECTs on a string comparison | 1120.990 | 1071.750 |
| 6: Creating an index | 240.585 | 237.550 |
| 7: 5000 SELECTs with an index | 1705.070 | 1651.580 |
| 8: 1000 UPDATEs without an index | 405.360 | 387.320 |
| 9: 25000 UPDATEs with an index | 7895.440 | 7767.200 |
| 10: 25000 text UPDATEs with an index | 11147.830 | 11509.525 |
| 11: INSERTs from a SELECT | 4000.080 | 4114.540 |
| 12: DELETE without an index | 85.895 | 84.285 |
| 13: DELETE with an index | 257.040 | 212.595 |
| 14: A big INSERT after a big DELETE | 1670.495 | 1681.100 |
| 15: A big DELETE then many small INSERTs | 2070.895 | 2071.535 |
| 16: DROP TABLE | 36.595 | 41.060 |

Machine conditions: a VM was on the box for about 1.4 cores throughout, as it was during the
baseline run the same morning; 1-minute load was 3.5–3.8 before each of the three runs. That is the
same box in the same state, not an idle one.

The single-session module was smoked separately — `bun run bench --no-build --suite rtt
--iterations 1 --configurations pgrust-memory` answered 12 of 12 tests.

## What instantiation costs now

`bun run probe:wasm-instantiate`, Chromium 149, on the optimised threads module:

| Step | wall (ms) | renderer RSS (MiB) | Δ RSS (MiB) |
| --- | --- | --- | --- |
| page loaded, nothing compiled | — | 101.5 | — |
| after `compileStreaming` | 163 (138 of it the fetch) | 223.1 | **+121.6** |
| after `new WebAssembly.Memory` | 1 | 224.1 | +1.0 |
| after `instantiate` | 14 | 231.6 | +7.5 |

Sections, as the probe reads them: code 31 797 707 (81.4%), data 7 156 258 (18.3%), element 42 231,
function 39 174, everything else under 4 KB.

There is no same-day control here — the 0.3 module was never put through this probe unoptimised —
so the honest comparison is to the 0.2 line in `2026-09-08-wasm-size-map.md` §10, where the shipped
46.4 MB module compiled in 148–155 ms for +146.2 MiB and its `-Oz` 33.8 MB copy in 96–115 ms for
+105.6 MiB. This module is bigger than either and sits between them at +121.6 MiB.

## What this note does not claim

- **Not that `-Oz` is free.** It costs about 7% of the Suite, measured twice. `-O3`, `-O2` and `-Os`
  were not tried — the brief for this bite ruled them out either way, and §9 never ran them either.
  If the 7% ever matters more than the 14 MB, that sweep is the next measurement, not a re-reading
  of this one.
- **Nothing about Safari or iOS.** Every browser number here is headless Chromium on Linux.
  `2026-09-08-webkit-memory-diet.md` §8 lists what a Chromium number does not say about WebKit, and
  all of it still applies — including whether a smaller module changes the phone's compile ceiling.
- **Nothing about the Concurrency Suite or the other thirteen columns.** One column was measured,
  the one the baseline exists for.
- **No claim about correctness beyond the five lanes.** They are the same five the 0.3 rebase was
  proved with; they are not the pgxsinkit suite, which was not re-run on this module.
