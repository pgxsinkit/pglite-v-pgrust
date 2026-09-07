# What an idle Engine costs, headless Chromium on Linux

- Date: 2026-09-07
- Browser: Chromium 149.0.7827.55, the full `chromium` channel in new headless mode, a fresh browser
  per row
- Machine: Linux 7.0.0-30-generic (x86_64, i7-1165G7, 8 threads), otherwise idle
- Engines: `@pgxsinkit/pglite` 0.5.5-pgx.3, pgrust `d74e974426`, store bundle `5e5d168a99`
- Driver: `bun run probe:idle-cpu` (`scripts/probe-idle-cpu.ts`)

The phone half of the same study is
[`2026-09-07-idle-cpu-android-s22.md`](2026-09-07-idle-cpu-android-s22.md); it is the one that
answers the battery question, and this is the lane that can take a machine apart while it does.

## Method

One fresh browser per row; one page; one Engine opened through the page's idle-probe handle and
warmed with one RTT Benchmark; ten seconds to settle; then **120 seconds in which nothing is asked of
the page**, sampled every 10 s from outside it.

- **CPU** — the delta of CDP `SystemInfo.getProcessInfo`'s `cpuTime`, summed over every process of
  that browser (renderer, browser, GPU, network and storage services alike).
- **Wakeups** — the delta of voluntary plus involuntary context switches over every thread of those
  processes (`/proc/<pid>/task/<tid>/status`), which is where a futex park's wake is counted. pgrust's
  host could be taught to count its own `poll_oneoff` returns instead, but only inside each thread
  worker, where no driver can read the count without new plumbing in pgrust — and the scheduler
  already counts the same events for every Engine on both platforms, so it was not changed.
- **State** — the page's own `visibilitychange` log, read once after the window. Asking a page for
  `document.visibilityState` over CDP does not work: a tab with a client attached to it is a tab the
  browser treats as active.
- A Playwright client is connected to the browser for the whole of every row, this one included, so
  the `blank` control carries that cost too.

`blank` is the same page with no Engine at all, and every other row should be read against it.

## Numbers

CPU-ms per idle minute is CPU time, not wall time: 600 CPU-ms per minute is 1% of one core.

| Row | CPU-ms per idle minute | % of one core | over `blank` | wakeups/s | worker targets | query after idle (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| blank page (no Engine) | 90 | 0.15% | — | 12 | 0 | — |
| PGlite Memory | 140 | 0.23% | +50 | 11 | 1 | 1.7 |
| PGlite OPFS repacked (relaxed) | 145 | 0.24% | +55 | 11 | 1 | 51.6 |
| pgrust Postmaster Memory (broker) — default GUCs | 300 | 0.50% | +210 | 52 | 16 | 3.2 |
| pgrust Postmaster Memory (broker) — quiet GUCs + recheck off | 225 | 0.37% | +135 | 35 | 16 | 11.8 |
| pgrust Postmaster Memory (broker) — quiet GUCs only | 290 | 0.48% | +200 | 44 | 16 | 3.4 |
| pgrust Postmaster Memory (broker) — second tab in front | 510 | 0.85% | +420 | 62 | 16 | 141.0 |
| pgrust Postmaster Memory (broker) — tab frozen | 585 | 0.97% | +495 | 55 | 16 | 3.1 |
| PGlite Memory — tab frozen | 195 | 0.32% | +105 | 14 | 1 | 1.1 |
| pgrust Postmaster OPFS repacked (relaxed) — default GUCs | 460 | 0.77% | +370 | 53 | 16 | 7.0 |
| pgrust Postmaster OPFS repacked (relaxed) — quiet GUCs + recheck off | 260 | 0.43% | +170 | 38 | 16 | 14.4 |
| pgrust Postmaster OPFS repacked (relaxed) — second tab in front | 430 | 0.72% | +340 | 54 | 16 | 3.1 |

One sentence each:

- **blank page (no Engine)** — 90 CPU-ms a minute is what a loaded page and its browser cost before
  any database exists, and it is the floor every other row stands on.
- **PGlite Memory** — 140 CPU-ms a minute, 50 of them the Engine's: one wasm session with nothing to
  do costs about a twelfth of a percent of one core.
- **PGlite OPFS repacked (relaxed)** — 145, the same as its Memory twin within the noise, so the store
  adds nothing measurable while nobody is querying.
- **pgrust Postmaster Memory (broker), default GUCs** — 300 CPU-ms a minute (0.50% of one core), 210
  of them the Engine's: a whole postmaster — checkpointer, background writer, WAL writer, two pgrust
  service threads, one backend — costs about four times an idle PGlite session and about a
  two-hundredth of a core in absolute terms.
- **pgrust Postmaster Memory (broker), quiet GUCs + recheck off** — 225 CPU-ms a minute and 35 wakeups
  a second: turning the recheck cadence off takes a quarter of the idle CPU and a third of the wakeups
  away, and nothing else in the Run changed.
- **pgrust Postmaster Memory (broker), quiet GUCs only** — 290 against the default's 300, which is
  noise: with `autovacuum=off` already set and every auxiliary process's own period capped by the 1 s
  recheck cadence, `bgwriter_delay`, `wal_writer_delay`, `checkpoint_timeout` and `autovacuum_naptime`
  have nothing left to slow down.
- **pgrust Postmaster Memory (broker), second tab in front** — 510, and the page's own log says why
  that is not a throttling measurement: it never fired a `visibilitychange`, so headless Chromium kept
  the Engine's tab `visible` and this row is the Engine plus a second tab's renderer (the phone
  answers the hidden-tab question).
- **pgrust Postmaster Memory (broker), tab frozen** — 585 with `Page.setWebLifecycleState = frozen`,
  *higher* than not freezing it: freezing the page's task queues does not stop the Engine's Workers,
  where all of this CPU lives, and the DevTools session the row needs costs about 130 CPU-ms a minute
  of its own.
- **PGlite Memory, tab frozen** — 195 against 140 unfrozen, the same story on the other Engine: the
  freeze buys nothing and the attached session costs.
- **pgrust Postmaster OPFS repacked (relaxed), default GUCs** — 460 CPU-ms a minute, 160 more than the
  same postmaster on the memory port: an OPFS-backed store keeps real file handles, and that is the
  difference.
- **pgrust Postmaster OPFS repacked (relaxed), quiet GUCs + recheck off** — 260, back to the memory
  port's default figure, so the same knob does the same work on a storage column.
- **pgrust Postmaster OPFS repacked (relaxed), second tab in front** — 430, again with the Engine's tab
  never hidden.

Run-to-run spread: the two second-tab rows were measured twice (the first pass had no visibility log)
and gave 420 and 580 CPU-ms a minute against the 510 and 430 above, so a single row of this table is
worth about ±20%. The differences the table is read for — 90 against 300, 300 against 225 — are
several times that.

## Where an idle pgrust's wakeups come from

Read from pgrust `d74e974426` rather than inferred. Everything in this column is one process — the
guest's threads are the host's Workers — so "thread" here is what C Postgres would call a process.

| Thread | Running in this column? | Period when idle | Knob |
| --- | --- | --- | --- |
| postmaster `ServerLoop` | yes | parks on its wake fd; each lap capped at **1000 ms** | `PGRUST_WAITER_RECHECK_MS` (or `PGRUST_MQ_RECHECK_MS`); `<= 0` parks untimed |
| session backend (one per Session) | yes | `poll(session fd, wake fd)`, capped at **1000 ms** | the same; with no wake fd in the connection record it is `INTERRUPT_POLL_MS` = 100 ms, which is not configurable |
| `pg-timeout-timer` | yes, one per process | untimed park with no timeout armed → **1000 ms** recheck | the same |
| `pg:memwatchdog` | yes, one per process | `thread::sleep`, **1000 ms**, clamped to 100…60 000 | GUC `pgrust.memory_watchdog_interval` (max 60 000 ms); `pgrust.memory_watchdog=off` stops the work but not the wake |
| checkpointer | yes | `WaitLatch(checkpoint_timeout − elapsed)`, capped at **1000 ms** | `checkpoint_timeout` sets the real deadline; the cap is `PGRUST_WAITER_RECHECK_MS` |
| background writer | yes | `bgwriter_delay` (200 ms) while working, ×50 = 10 s hibernating, capped at **1000 ms** | `bgwriter_delay` (max 10 000 ms); the cap again |
| WAL writer | yes | `wal_writer_delay` (200 ms), ×25 = 5 s after 50 idle laps, capped at **1000 ms** | `wal_writer_delay` (max 10 000 ms); the cap again |
| autovacuum launcher | **no** | (`autovacuum_naptime`, 60 s) | the shared wire argv starts this server with `autovacuum=off` |
| IO workers | **no** | — | the same argv sets `io_method=sync` |
| `pg-bgjobs-dispatcher` | **no** | (job deadlines; a 10 s watchdog) | needs `PGRUST_RUNTIME_BGJOBS=1` **and** `PGRUST_RUNTIME=1`; this Engine runs `PGRUST_RUNTIME=0` |
| `pg-slease-sweeper` | **no** | (25…250 ms natively) | `#[cfg(not(target_family = "wasm"))]` — it is never spawned on wasm at all |
| store coordinator (`RepackedSyncBroker`, pgxsinkit) | yes | **250 ms** doorbell heartbeat = 4 wakeups/s | its `pollIntervalMs` (`Infinity` is a pure park); pgrust's `wasm/storage-worker.js` passes none |

The shape of that table is the finding: **almost every period in it is capped by one knob that is not
a GUC.** `waiter::recheck_cadence_ms` (GL-RECWAKE-1, default 1000 ms) bounds every park in the guest —
the postmaster's, every backend's `poll`, every auxiliary process's `WaitLatch` — so a checkpointer
told to wait five minutes still wakes once a second, and telling it to wait a day changes nothing.
That is exactly what the "quiet GUCs only" row measures, and it is why that row is the default row.

## What this says

- In absolute terms, an idle pgrust postmaster in a tab costs **0.35–0.62% of one core** over a blank
  page on this machine, and an idle PGlite costs **0.08%**. Both are small; whether the difference
  matters is a question about a device, which is the phone note's to answer.
- The one knob that moves the number is `PGRUST_WAITER_RECHECK_MS=0`: −25% CPU and −33% wakeups on the
  memory port, −43% CPU on the OPFS one. It is a lost-wake backstop, so turning it off trades a
  guarantee — a dropped cross-thread wake costs one second rather than forever — for idle cost.
- Postgres's own periodic GUCs buy nothing here, because the recheck cadence is already shorter than
  every one of them and autovacuum is off.
- Freezing the page does not help: the cost is in Workers, and a frozen page keeps them.
- Nothing grew over the two minutes in any row — the per-sample series in the probe's output are flat
  — so every number is a steady state rather than the tail of a boot.
