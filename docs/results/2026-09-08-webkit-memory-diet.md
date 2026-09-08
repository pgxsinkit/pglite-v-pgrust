# The postmaster's memory diet — real Safari, and the knob that was the whole of it

- Date: 2026-09-08
- Browser: **Safari 26.6.2** on macOS 26.6.2 (Apple M2, 8 cores, 16 GB), driven over WebDriver by
  `safaridriver`. Not Playwright's WebKit: this is the shipping engine, on the shipping OS.
- Page: the benchmark page served from a Linux machine at `http://localhost:4199/` over an ssh
  reverse tunnel, with the two cross-origin isolation headers — **one Configuration per Run**, so the
  renderer's memory belongs to one column.
- Engines: `@pgxsinkit/pglite 0.5.5-pgx.3`, `@pgxsinkit/pglite-opfs-repacked 0.3.0` (pre-release
  store), pgrust `d13d781fb9` for the baseline and `e8e8ee061d` for the new defaults.
- Second lane, for the knobs whose answer is a number the engine cannot change: headless Chromium
  149.0.7827.55 on Linux, one column per Run, same page, same build.

## The report this answers

On an **iPhone Xs (4 GB, iOS 18.7.1)** the page reloads for memory when only
`pgrust Postmaster OPFS repacked (relaxed)` and wa-sqlite are selected and the Speedtest Suite or the
Concurrency Suite runs. Every PGlite column plus wa-sqlite together completes all three Suites on the
same phone. So the postmaster alone was over the per-tab budget, and no other column was.

## Method, and what each number is

Each Run gets its own WebDriver session, navigates to a URL naming one Configuration, waits for
`crossOriginIsolated`, clicks the Suite's Start and waits for `data-state=complete`. Two things are
read off the page afterwards and one off the machine:

- **wasm memory** — the Engine's own `WebAssembly.Memory.buffer.byteLength`, published by each Run
  through a new hidden `data-testid=engine-stats-<suite>` element (Safari has no CDP, so a driver
  can only read what the page publishes). A `WebAssembly.Memory` never shrinks, so the size read at
  the end of a Run **is** that Run's high-water mark. It is an allocation, not a residency.
- **peak WebContent RSS** — `ps -axo pid=,rss=,command=` on the Mac every two seconds for the length
  of the Run, attributed to the WebContent process that GREW: Safari keeps a just-closed tab's
  process alive for a while, and the largest RSS in a sample is not necessarily this Run's.
  macOS RSS is not iOS's `phys_footprint` and the absolute numbers do not transfer to the phone —
  PGlite Memory, which the phone completes comfortably, sits at 1.9 GB here. It is used as a
  **relative** measure between variants on one machine, which is what it is good for.
- **Suite total (cells)** — the sum of the Benchmark cells, not the wall time from the click. A
  Measurement is taken inside the worker around the Engine call alone; the wall time also carries
  ~90 MB of asset fetch, a wasm compile and a cold store seed, none of which any Benchmark measures.

Worker count is structural: `1 engine worker + 1 storage coordinator + 1 process worker + poolSize`.

## 1. Baseline — Safari, pgrust `d13d781fb9`, pool 12, `max_stack_depth=60000`

| Configuration | Suite | peak WebContent RSS | wasm memory | workers | Suite total (cells) |
| --- | --- | --- | --- | --- | --- |
| PGlite Memory | Speedtest | 1898 MB | 226.3 MiB (PGlite emscripten heap) | 1 | 16 832 ms |
| PGlite OPFS repacked (relaxed) | Speedtest | 1636 MB | 226.3 MiB | 1 | 18 600 ms |
| pgrust Postmaster OPFS repacked (relaxed) | Speedtest | **2358 MB** | **1101.1 MiB** | 16 | 49 752 ms |
| pgrust Postmaster OPFS repacked (relaxed) | Concurrency | **2368 MB** | **979.2 MiB** | 19 | 19 267 ms |

The postmaster's shared memory is **4.9×** PGlite's heap and its renderer holds ~460 MB more than
PGlite Memory's does. Chromium's own memory probe had recorded 545 MiB for the same Engine after a
warm RTT Run; that number is reproduced below and is the half of this that matters.

## 2. Knob sweep — Safari, one change at a time, postmaster OPFS, Speedtest

Every row is a full Run from the baseline with exactly one thing moved, through the new
`?postmasterTuning=` URL (`src/postmaster-tuning.ts`), on the baseline wasm module.

| Variant | peak RSS | wasm memory | Suite total | Outcome |
| --- | --- | --- | --- | --- |
| baseline | 2358 MB | 1101.1 MiB | 49 752 ms | — |
| `pool:8` | 2214 MB | 1101.1 MiB | 46 994 ms | boots; 12 workers instead of 16 |
| `pool:6` | — | — | — | **fails to boot**: `wasi thread-spawn refused, the prewarmed pool of 7 is exhausted` |
| `pool:5` | — | — | — | **fails to boot**: `the prewarmed pool of 6 is exhausted` |
| `shared_buffers=16MB` | 2280 MB | 1080.2 MiB | 62 362 ms | −21 MiB, and slower |
| `shared_buffers=32MB` | 2268 MB | 1097.8 MiB | 45 157 ms | restates the default; the row is the noise floor |
| `wal_buffers=1MB` | 2182 MB | 1101.1 MiB | 60 705 ms | no change in memory |
| `work_mem=1MB` | 2247 MB | 1101.0 MiB | 46 188 ms | no change in memory |
| `max_connections=8` | 2291 MB | 1097.6 MiB | 60 586 ms | −3.5 MiB |
| `max_worker_processes=4` | 2270 MB | 1100.8 MiB | 44 458 ms | no change in memory |
| **`max_stack_depth=2048`** | **1956 MB** | **788.9 MiB** | 50 574 ms | **−312 MiB** |

`pool:7` was measured in the Chromium lane and also refuses (`the prewarmed pool of 8 is
exhausted`), so **8 is the minimum pool base** with one Session, not a round number.

Note how little the Postgres memory GUCs move: `shared_buffers` gives back its own 16 MiB and no
more, `work_mem`, `wal_buffers` and `max_worker_processes` give back nothing at all, and two of them
cost 25–40% in time. The postmaster's memory is not Postgres's memory.

### The knob that was the whole of it

`max_stack_depth` is not a memory GUC on any other platform. On wasm it is the biggest one there is,
because of `child_thread_stack_size()` in pgrust's `launch_backend`:

```rust
let rlim = stack_depth::get_stack_depth_rlimit();            // -1 on WASI: no rlimits
let unlimited_reserve = (16 << 20).max(max_stack_depth_bytes() + (2 << 20));
```

WASI has no `RLIMIT_STACK`, so every postmaster child takes the "unlimited" reserve — and the wasm
boot harness pins `max_stack_depth=60000kB`, which makes that reserve **60.6 MiB per child**. The
postmaster spawns twelve children before the first statement. The comment above that function
explains why the reserve is free — "reserve is address space only" — and that is the one sentence
which is false on wasm: a wasm thread stack is malloc'd out of the ONE shared `WebAssembly.Memory`
every instance imports, so it is bytes the memory grows by and the tab makes resident.

Two Chromium Runs of the **RTT** Suite (twelve single statements, no bulk workload) separate the
structural cost from the workload's:

| Module | Tuning | Suite | wasm memory |
| --- | --- | --- | --- |
| `d13d781fb9` | — | RTT | 545.2 MiB |
| `d13d781fb9` | `max_stack_depth=2048` | RTT | **256.0 MiB — the initial claim, untouched** |

That is the entire structural growth: with stock Postgres's own `max_stack_depth`, a booted
postmaster serving statements never grows its memory past the size it was created with. Everything
above 256 MiB in the Speedtest column is that Suite's own arena (see
[`docs/findings/0001`](../findings/0001-pgrust-multi-statement-memory.md) — `MessageContext` is a
Bump arena that is reset per message, not per statement), which no knob here reaches.

## 3. Module variants — headless Chromium, one column per Run

The wasm memory a Run claims is a property of the guest, not of the browser: Chromium and Safari
report the same 1101.1 MiB for the baseline. So the variants that need a rebuild were swept in the
Chromium lane, where there is no session to queue for, and the winner was then re-measured on Safari.

Two rebuilt modules:

- **A** — `child_thread_stack_size()`'s unlimited-reserve floor is 4 MiB on wasm (16 MiB elsewhere).
- **B** — A, plus `-zstack-size=16777216` for `wasm32-wasip1-threads` only: nothing that runs SQL is
  on the main stack of that target (a wire session takes its own 64 MiB thread, every postmaster
  child takes the size above), while `wasm32-wasip1` keeps 64 MiB because `--single` and
  `--stdio-wire` DO run the session on it.

| Module | Tuning | wasm memory | Suite total | Outcome |
| --- | --- | --- | --- | --- |
| stock `d13d781fb9` | — | 1101.1 MiB | 35 054 ms | baseline |
| stock | `max_stack_depth=2048` | 788.6 MiB | 37 965 ms | −312 MiB |
| stock | `pool:8` | 1101.1 MiB | 34 667 ms | no memory change |
| stock | `shared_buffers=16MB` | 1083.4 MiB | 73 335 ms | 2.1× slower |
| stock | `work_mem=1MB` | 1101.1 MiB | 76 778 ms | 2.2× slower |
| stock | `max_connections=8` | 1097.6 MiB | 36 387 ms | −3.5 MiB |
| A | — | 1101.1 MiB | 44 663 ms | unchanged: `max_stack_depth` still dominates the max |
| A | `max_stack_depth=2048` | 704.9 MiB | 34 709 ms | −84 MiB on top of the GUC |
| B | — | 1053.1 MiB | 35 459 ms | −48 MiB: the main stack alone |
| B | `max_stack_depth=2048` | **656.9 MiB** | 34 612 ms | −444 MiB from baseline |
| B | `pool:8,max_stack_depth=2048` | **656.9 MiB** | **35 037 ms** | the chosen defaults, **0.0% vs baseline** |
| B | `max_stack_depth=2048`, Concurrency | 366.9 MiB | — | four Sessions, four backends |
| A | `initial:67108864` | — | — | **fails to boot**: `RuntimeError: memory access out of bounds` |
| B | `max_stack_depth=2048,initial:67108864` | — | — | **renderer crash** during boot |
| B | `max_stack_depth=2048,initial:134217728` | — | — | **renderer crash** during boot |
| B | `max_stack_depth=2048,initial:201326592` | — | — | **renderer crash** during boot |
| B | `pool:7,max_stack_depth=2048` | — | — | **fails to boot**: `the prewarmed pool of 8 is exhausted` |
| B | `pool:6` / `pool:5` | — | — | **fails to boot**, as on Safari |

**The initial claim stays at 256 MiB.** 64 MiB against the stock 64 MiB main stack traps before the
postmaster starts — the module's static data (6.6 MiB) plus that stack do not fit under it, which is
exactly what the link-time flag would have refused. With the 16 MiB main stack it links and fits, and
64, 128 and 192 MiB all take the renderer down while the guest grows instead. It would not have
lowered the **peak** in any case: the Speedtest arena grows past 256 MiB whatever the claim was, and
the one workload where a smaller claim would show — a booted, idle postmaster — is the RTT row above,
which is already the claim and nothing more.

## 4. The chosen defaults

Lowest peak with a Speedtest total inside 15% of baseline:

| Default | Was | Now | Why |
| --- | --- | --- | --- |
| `POOL_BASE_SIZE` (`pgrust-postmaster.worker.ts`) | 12 | **8** | The measured minimum with one Session; 7 refuses the spawn. Four fewer live Workers per Run, 16 → 12. No effect on wasm memory, which is why it is here for the Workers rather than for the guest. |
| `max_stack_depth` in the postmaster's argv | 60000 kB (from `defaultWireArgv()`) | **2048 kB** | Stock Postgres's own default. On wasm it sizes every child thread stack: 60.6 MiB → 4 MiB each. −312 MiB on the stock module, and the whole of the structural growth. |
| `child_thread_stack_size()` unlimited-reserve floor (pgrust) | 16 MiB | **4 MiB on wasm** | Lets the GUC above reach 4 MiB instead of stopping at the 16 MiB floor. −84 MiB. Native platforms keep 16 MiB. |
| `-zstack-size` for `wasm32-wasip1-threads` (pgrust) | 64 MiB | **16 MiB** | Nothing that runs SQL is on that target's main stack. −48 MiB. `wasm32-wasip1` keeps 64 MiB. |
| `--initial-memory` | 256 MiB | **256 MiB** (unchanged) | Every smaller value measured either traps at boot or crashes the renderer, and none would lower the peak. |

Everything the postmaster ran on before is still reachable in one URL:
`?postmasterTuning=pool:12,max_stack_depth=60000`, which is how the "old defaults" rows below were
produced — on the **new** module, so the two arms differ only in the knobs.

## 5. The table again, with the new defaults — Safari

pgrust `e8e8ee061d`, pool 8, `max_stack_depth=2048`.

| Configuration | Suite | peak WebContent RSS | wasm memory | workers | Suite total (cells) |
| --- | --- | --- | --- | --- | --- |
| PGlite Memory | Speedtest | 1945 MB | 226.3 MiB | 1 | 17 172 ms |
| PGlite OPFS repacked (relaxed) | Speedtest | 1637 MB | 226.3 MiB | 1 | 18 337 ms |
| pgrust Postmaster OPFS repacked (relaxed) | Speedtest | **2017 MB** | **656.9 MiB** | 12 | 49 961 ms |
| pgrust Postmaster OPFS repacked (relaxed) | Concurrency | **1921 MB** | **366.9 MiB** | 15 | 22 537 ms |

Against the baseline table: the Speedtest column's shared memory falls **1101.1 → 656.9 MiB (−40%)**
and the Concurrency column's **979.2 → 366.9 MiB (−63%)**. Peak renderer RSS falls 2358 → 2017 MB on
the Speedtest and 2368 → 1921 MB on the Concurrency Suite, and the postmaster's excess over PGlite
Memory's own renderer — the part of the RSS that is this Engine rather than this page — falls from
~460 MB to ~72 MB.

### Paired repeats, same module, knobs the only difference

macOS RSS and Safari timing are both noisy enough that one Run of each would not settle the 15%
question, so both arms were repeated on the new module.

| Arm | Speedtest totals (ms) | median | peak RSS (MB) | median |
| --- | --- | --- | --- | --- |
| new defaults (`pool 8`, `max_stack_depth=2048`) | 49 961 / 60 673 / 45 796 / 45 242 | **47 879** | 2017 / 1869 / 2004 / 1967 | **1986** |
| old defaults (`?postmasterTuning=pool:12,max_stack_depth=60000`) | 45 785 / 49 804 / 62 495 | **49 804** | 2196 / 2217 / 2096 | **2196** |

The new defaults are **4% faster** at the median — comfortably inside the 15% allowance, and the
Chromium A/B above puts the same pair at 35 037 ms against 35 054 ms, a 0.0% difference. The ~60 s
outlier appears in both arms and in three of the no-op knob rows in §2; it is the harness, not the
change.

## 6. Nothing regressed on Chromium

`bun run bench --no-build --suite speedtest --configurations
pglite-memory,pgrust-postmaster-opfs-repacked-relaxed`, on the new module and the new defaults
(`--no-build` only because a rebuild would have swapped the `dist/` a Safari Run was being served
from; the build is the one under test). Eighteen Benchmarks, no failures, ratios in the band this
repo has always reported for that pair:

| Benchmark | PGlite Memory (ms) | pgrust Postmaster OPFS repacked (ms) | vs PGlite Memory |
| --- | --- | --- | --- |
| Test 1: 1000 INSERTs | 226.0 | 472.0 | 2.09× |
| Test 2: 25000 INSERTs in a transaction | 2035.1 | 6999.6 | 3.44× |
| Test 3: 25000 INSERTs into an indexed table | 2194.9 | 9632.4 | 4.39× |
| Test 9: 25000 UPDATEs with an index | 2184.5 | 8063.5 | 3.69× |
| Test 10: 25000 text UPDATEs with an index | 3382.0 | 8065.3 | 2.38× |

(Full table: `tmp/results/2026-09-08T03-06-02.385Z-chromium.md`.) The controlled single-column
Chromium A/B in §3 is the sharper answer: 656.9 MiB at 35 037 ms against 1101.1 MiB at 35 054 ms.

## 7. Guest-side verification

The two pgrust changes were verified on the rebuilt module under Node, all three lanes with
`-c max_stack_depth=2048` so the new 4 MiB floor is the one being exercised:

| Lane | Result |
| --- | --- |
| `node run-node-wire-threads.mjs --dispatch postmaster --fs broker` | PASS — twelve child threads spawned, every one returned, shutdown checkpoint logged, the session's writes in the one store |
| `--fs broker --mount /pgeph=memory --sql tablespace-proof.sql` | PASS — 7 files / 90 112 bytes in the `/pgeph` store, none in the root |
| `--fs broker --mount /pgdata/pg_tblspc=memory --sql tablespace-inplace-proof.sql` | PASS — same counts, in-place shape |

## 8. What this does not fix

657 MiB is still 2.9× PGlite's heap on the Speedtest Suite, and all of the remainder is one thing:
the `MessageContext` arena that
[`docs/findings/0001`](../findings/0001-pgrust-multi-statement-memory.md) is about. A booted
postmaster costs 256 MiB and grows by nothing; the Speedtest scripts that send 25 000 statements in
one simple-query message are what take it to 657 MiB, and they would do it on any pool size and any
stack budget. Freeing per statement rather than per message is the next 400 MiB, and it is a change
to pgrust's `simple_query`, not a knob.

Whether 657 MiB clears the iPhone Xs's per-tab budget is a question for the phone; this page's
Speedtest Suite is not a small workload, and the postmaster is now within 72 MB of PGlite's own
renderer on the machine where both could be measured.
