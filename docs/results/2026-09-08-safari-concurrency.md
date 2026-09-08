# The postmaster's Safari concurrency collapse — one waiter too many

- Date: 2026-09-08
- Browser under investigation: **Safari 26.6.2** on macOS 26.6.2 (Apple M2, 8 cores, 16 GB), driven
  over WebDriver by `safaridriver`. The shipping engine on the shipping OS, not Playwright's WebKit.
- Control browser: headless **Chromium 149.0.7827.55** on Linux (Intel i7-1165G7, 8 threads).
- Engines: `@pgxsinkit/pglite 0.5.5-pgx.3`, `@pgxsinkit/pglite-opfs-repacked 0.3.0` (pre-release
  store), pgrust `e8e8ee061d` before and `df11a1dd2a` after.
- Pages: the production build at `http://localhost:4199/` and the dev server at
  `http://localhost:5580/`, both served from the Linux machine over an ssh reverse tunnel with the
  two cross-origin isolation headers.

## The report this answers

On the Concurrency Suite's **Test 1** — four Clients running 500 point SELECTs each, total wall —
`pgrust Postmaster` was **15-20x** PGlite in Safari on a Mac mini M2 and on an iPhone 14 Pro, while
headless Chromium on Linux had the same column at **0.28x** PGlite. Single-statement RTT on Safari
was only ~5x PGlite, so whatever it was did not show up one statement at a time.

## Answer, in one paragraph

Nothing in the store, the broker or the postmaster is involved. The host's session pump held **one
outstanding `Atomics.waitAsync` per session**, and a WebKit agent holding two or more of those, with
an otherwise idle run loop, intermittently **stops running altogether for about a second** — its own
timers stop firing, incoming `postMessage` is not delivered, and the wait's own timeout does not end
it. At four sessions that happened ~65-110 times per Test 1 and was the entire difference. Parking
every session behind **one** shared waiter removes it: Safari's Test 1 goes from 12.00x PGlite to
2.55x, and Chromium does not move.

## 0. Is it JavaScriptCore, or is it WebKit?

bun embeds JavaScriptCore, so the same engine can be measured off the browser. pgrust's node lane
grew a fan-out scenario for exactly this shape (`wasm/fanout-scenario.js`, `--fanout N`): N sessions,
N real backends, 500 point SELECTs each over one 100 000-row indexed table, one wall, run under both
runtimes on the Linux box against the same wasm and the same broker store.

| sessions | `node` wall | `bun` (JavaScriptCore) wall |
| --- | --- | --- |
| 1 | 262 ms | 197 ms |
| 2 | 305 ms | 238 ms |
| 4 | 463 ms | 476 ms |

JavaScriptCore is at parity with V8 — ahead of it at one and two sessions. So the fault is not in the
engine's codegen and not in its futex implementation: it is in WebKit-in-the-browser.

## 1. The client sweep — a step function, not a slope

One Configuration per page load, cold Test 1 only, off the dev server (`tmp/agents/fanout-drive.ts`,
which drives the app's own runner for one Benchmark).

| Clients | Safari, before | Safari, after | Chromium |
| --- | --- | --- | --- |
| 1 | 1 068 ms | 931 ms | 327 ms |
| 2 | **10 110 ms** | 1 546 ms | 417 ms |
| 4 | 9 447 ms | 3 000 ms | 537 ms |
| 8 | 16 159 ms | 5 501 ms | 756 ms |

Before, Safari steps by 9.5x between one Client and two and is then non-monotonic — the signature of
a rare, large, fixed-size penalty rather than of contention, which would scale smoothly. After, it is
linear in total statements. Chromium is smooth throughout and never had the problem.

## 2. Where the time went — the pump's own counters

`SabPipe.readAsync` was instrumented (scratch, not committed) to count parks and their durations, and
the broker's doorbell ticket was read before and after each Test 1 so broker traffic could be
separated from the untimed setup. Four Clients, dev server, one page load, four consecutive Test 1
repeats:

| repeat | Safari wall | broker requests | parks | parked (ms) | parks ≥32 ms |
| --- | --- | --- | --- | --- | --- |
| 0 | 18 241 ms | 63 | 2 004 | 72 647 | 68 |
| 1 | 15 602 ms | 30 | 2 003 | 62 032 | 57 |
| 2 | 3 568 ms | 8 | 2 001 | 14 184 | 12 |
| 3 | 1 407 ms | 2 | 2 000 | 5 483 | 8 |

Three things fall out of this table.

- **The broker is not involved.** Test 1 makes 2-63 broker requests; the ~11 000 the Run does happen
  in the untimed setup, before the clock starts. The Chromium control makes the same 26-30. So the
  brief's primary hypothesis — that the single doorbell and the coordinator's O(N) scan degrade with
  concurrent backends — is **refuted by measurement**, and no change was made to the broker.
- **The pumps are parked 99.6% of the wall** (72 647 ms of park against 4 × 18 241 ms of pump time),
  so nothing on the host thread is the bottleneck either.
- **A handful of parks carry everything.** Subtracting the modal buckets leaves ~64 s spread over 68
  parks: **~940 ms each**. The same shape at every repeat. Chromium's ≥32 ms bucket in the same
  workload is 0-5 and its worst park is under 60 ms.

## 3. The primitive is fine

A pure-JS wake matrix (`tmp/agents/wake-matrix.js`) reproduced the SabPipe round trip — a responder
Worker parked in `Atomics.wait`, a driver poking it and waiting for the answer — swept over who
drives, how it waits, and how many other Workers are parked:

| shape | Chromium median | Safari median |
| --- | --- | --- |
| page drives, `waitAsync`, 1 lane | 0.015 ms | 0.040 ms |
| Worker drives, `waitAsync`, 1 lane | 0.010 ms | 0.020 ms |
| Worker drives, synchronous `wait`, 1 lane | 0.010 ms | 0.000 ms |
| Worker drives, `waitAsync`, 4 lanes | 0.020 ms | 0.120 ms |
| Worker drives, `waitAsync`, 1 lane, 14 idle Workers parked | 0.015 ms | 0.040 ms |
| Worker drives, `waitAsync`, 4 lanes, 14 idle Workers parked | 0.025 ms | 0.300 ms |

Safari's wake latency is a fraction of a millisecond in every shape. But two of these runs recorded a
`max` of **1000.58 ms** and **1029.34 ms**, and both were the Worker-driven multi-lane ones.

## 4. The freeze, isolated

`tmp/agents/wake-stall.js` narrows it. The responder busy-waits 2 ms before replying, because a driver
whose lanes all answer in 20 µs never lets its run loop go idle and an idle run loop is what the
engine has between statements; the driver Worker also runs a `setInterval(…, 10)` and reports **its
own largest gap**. 1000 rounds per lane.

| shape | total | round trips ≥100 ms | worst | driver's own timer gap |
| --- | --- | --- | --- | --- |
| 1 lane, `waitAsync` | 2 136 ms | 0 | 3.0 ms | 11.9 ms |
| 4 lanes, `waitAsync` (5 s timeout) | 24 350 ms | 12 | 1 169 ms | **1 168 ms** |
| 4 lanes, `waitAsync` (50 ms timeout) | 24 378 ms | 12 | 1 187 ms | **1 188 ms** |
| 4 lanes, `waitAsync`, page posts a message every 4 ms | 19 353 ms | 8 | 1 186 ms | **1 185 ms** |
| 4 lanes, `setTimeout(0)` polling instead | 33 568 ms | 160 | 204 ms | 204 ms |
| 8 lanes, `waitAsync` | 62 792 ms | 32 | 1 010 ms | 1 017 ms |
| 2 lanes, `waitAsync` | 4 461 ms | 0 | 5.7 ms | 12.7 ms |

So:

- it is **not the wait** that stalls, it is **the whole agent** — its own `setInterval` misses by the
  same 1.0-1.2 s;
- the wait's **timeout does not end it**: 50 ms and 5000 ms give the same 1.19 s;
- an **incoming `postMessage` does not end it** either;
- the number of stalled round trips is always an exact multiple of the lane count — one freeze event
  hits every lane at once, which is what "the agent stopped" means;
- **one outstanding waiter never froze**, and `setTimeout` polling (the only timer-based alternative)
  has a 6 ms median on Safari and is not a candidate.

Rate, from these runs and the engine's own counters: roughly **one freeze per 500 round trips** with
four waiters.

## 5. Choosing the fix

Three shapes doing identical work, 1500 rounds per lane, four lanes (`tmp/agents/wake-fix.js`):

| design | total | ≥100 ms | worst | driver's timer gap |
| --- | --- | --- | --- | --- |
| one `waitAsync` per ring (today) | 39 269 ms | 20 | 1 186 ms | 1 197 ms |
| **one shared word, one `waitAsync`, re-scan** | **14 060 ms** | **0** | 9.6 ms | 13.4 ms |
| a blocking reader Worker per ring, `postMessage` back | 13 361 ms | 0 | 7.4 ms | 13.2 ms |
| one per ring, plus a 1 ms `setInterval` heartbeat | 41 424 ms | 24 | 1 055 ms | 1 054 ms |

The heartbeat is out: an earlier smaller run made it look like a cure and a bigger one showed it is
not. The blocking-reader design works and costs a Worker and a message per reply. The shared word
works just as well, is a hundred lines less, and is the same idea the pipes already had for the
guest — so that is what shipped.

**The host gate** (pgrust `wasm/sab-pipe.js`): a second shared word beside the per-session group
gate, bumped by `_bump` and waited on by nobody in the guest. Every ring one non-blocking host reads
carries the same one; `readAsync` parks on it, `_awaitHostGate` keeps exactly one live wait per gate
however many rings are parked, and each wake re-tests every ring the way a `poll(2)` caller re-tests
its fds. A host with one ring, and every blocking caller, is untouched. The same change fixes a
second-order bug on the way past: `readAsync` used to read its wait word **after** testing the ring,
so a byte landing between the two was slept through — the SEQ-first discipline every other waiter in
that file already followed.

## 6. Before and after — the Concurrency Suite, production build

Four Configurations, one Run each, `?configurations=…`. Same build, same machines, same session; the
only difference is `wasm/sab-pipe.js`.

### Safari 26.6.2 (M2)

| Benchmark | PGlite Memory | pgrust Threads Memory | **Postmaster Memory (broker)** | Postmaster OPFS repacked (relaxed) |
| --- | --- | --- | --- | --- |
| Test 1 before | 1 507.4 | 3 879.7 (2.57x) | **18 086.8 (12.00x)** | 14 142.4 (9.38x) |
| Test 1 after | 1 499.1 | 3 961.7 (2.64x) | **3 821.4 (2.55x)** | 3 246.3 (2.17x) |
| Test 2 before / after | 2 018.9 / 2 120.7 | 5 477.5 / 5 634.7 | 9.6 / 7.6 | 10.5 / 8.2 |
| Test 3 before / after | 683.3 / 635.4 | 131.1 / 127.6 | 11.4 / 7.3 | 8.9 / 6.4 |
| Test 4 before / after (tx/s, higher better) | 862.6 / 822.6 | 1 684.5 / 1 676.2 | **372.6 / 524.4** | **380.0 / 503.4** |
| Test 5 before / after (p95) | 6.7 / 6.6 | 37.0 / 36.7 | **19.5 / 14.2** | **24.9 / 14.9** |

Test 1 is **4.7x** faster; the two single-pump controls (PGlite, pgrust Threads) do not move, which
is the check that nothing else changed. Test 4 gains 41% and Test 5's p95 a quarter — the same
freezes, in smaller numbers, were in those rows too.

### Headless Chromium 149 (Linux)

| Benchmark | PGlite Memory | pgrust Threads Memory | Postmaster Memory (broker) | Postmaster OPFS repacked (relaxed) |
| --- | --- | --- | --- | --- |
| Test 1 before | 633.5 | 786.4 (1.24x) | 197.2 (0.31x) | 323.6 (0.51x) |
| Test 1 after | 670.6 | 772.7 (1.15x) | 186.3 (0.28x) | 157.3 (0.23x) |
| Test 4 before / after (tx/s) | 1 976.3 / 1 947.3 | 2 240.0 / 2 230.0 | 5 669.9 / 5 781.2 | 2 358.4 / 2 292.9 |

Chromium does not move: every difference here is inside the run-to-run spread of these columns. The
extra wakeups the shared word costs (the pump parks ~6 000 times instead of 2 000 for the same 2 000
statements) are free there, and were free on Safari too.

The node and bun fan-out lanes are also unchanged at four sessions (463 → 422 ms, 476 → 498 ms).

## 7. What the fix does not fix

Safari's postmaster is still 2.55x PGlite where Chromium's is 0.28x. Two residuals, measured on one
session with nothing concurrent (`--sql`, 30 iterations, median):

| statement | engine | Chromium | Safari | ratio |
| --- | --- | --- | --- | --- |
| `SELECT count(*), sum(v)` over 100 000 rows | PGlite | 14.9 ms | 43.5 ms | 2.9x |
| `SELECT count(*), sum(v)` over 100 000 rows | pgrust Threads | 6.1 ms | 18.2 ms | 3.0x |
| `SELECT payload … WHERE k = 42` | PGlite | 0.295 ms | 0.82 ms | 2.8x |
| `SELECT payload … WHERE k = 42` | pgrust Threads | 0.475 ms | **3.56 ms** | **7.5x** |

- **Execution is uniformly ~3x slower on this Safari/M2 pair than on this Chromium/i7 pair**, for
  both engines, and pgrust is 2.4x *faster* than PGlite at it on both. Hardware is folded into that
  number and it is not something this repo can move.
- **The cross-agent round trip is not.** PGlite's point SELECT costs exactly its execution ratio,
  because PGlite has no cross-agent round trip at all: it runs the wasm in the worker that asked.
  pgrust pays ~2 ms per statement on Safari that it does not pay on Chromium, for a wake path the
  microbenchmark of §3 times at 0.02-0.3 ms. That gap is unexplained and is the next thing to chase;
  it is what keeps Safari's postmaster at 523 statements/s in §6 where Chromium reaches 10 735.
- **The freeze is reduced, not eliminated.** After the fix, Test 1's per-Client `max` on Safari is
  still ~1002 ms — one event per Run rather than the 65-110 that were there before. One waiter is
  far safer than four; it is not provably safe.

## Method notes

- Every Safari Run is its own WebDriver session against `safaridriver` on the Mac over an ssh tunnel,
  one Suite at a time. A page running two Suites at once produces numbers that cannot be read.
- The §1-§5 numbers come off the **dev server**, which serves the app unbundled; absolute walls there
  are up to 3x the production build's for the postmaster column (537 ms against 186 ms on Chromium
  for the same Test 1). Only §6 is a production build, and every comparison is within one lane.
- The Linux box was shared with unrelated work during part of the §1-§2 Chromium runs; §6's Chromium
  Runs were taken at a load average under 1.3.
- Scratch drivers and probes live in `tmp/agents/` and are not part of the app: `fanout-drive.ts` and
  `fanout-page.js` (one Benchmark, N Clients, either browser), `wake-drive.ts` with `wake-matrix.js`,
  `wake-stall.js` and `wake-fix.js` (the pure-JS primitive), `ab-hostgate.sh` (the alternating A/B).
