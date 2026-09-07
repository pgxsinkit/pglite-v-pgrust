# What each Engine costs in memory — Chromium, Linux

- Date: 2026-09-07
- Browser: Chromium 149.0.7827.55 (Playwright 152 bundle), **full build in new headless mode**
  (`channel: "chromium"`), Linux 7.0.0-30-generic, x86_64, i7-1165G7
- Page: the benchmark page, cross-origin isolated, one Configuration per fresh browser
- `@pgxsinkit/pglite 0.5.5-pgx.3 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust 08a306441f | wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available`
- Driver: `bun run probe:memory` (`scripts/probe-memory.ts` + `src/memory-probe.ts`)

## Method

Each Configuration gets its own browser, so the page has exactly one renderer of its own. The page
opens the Engine, runs the RTT Suite's setup and its twelve Benchmarks once each — one warm Run —
and then, with the Engine still open, three measurements are taken in this order: the Engine's
worker reports its `WebAssembly.Memory.buffer.byteLength` over the existing worker protocol; the
browser reports the renderer processes' RSS (`SystemInfo.getProcessInfo` for the pids,
`/proc/<pid>/status` for `VmRSS`) and the live worker targets; and only then does the page call
`performance.measureUserAgentSpecificMemory()`, which forces a garbage collection and would
otherwise change the RSS it is compared against. The Engine is closed last.

## Numbers

| Configuration | warm Run (ms) | wasm memory (MiB) | page memory (MiB) | page renderer RSS before → after (MiB) | RSS delta (MiB) | all renderers RSS (MiB) | worker targets |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PGlite Memory | 2058 | 188.6 (PGlite emscripten heap) | 277.9 | 189.2 → 747.4 | 558.2 | 813.7 (2) | 1 |
| pgrust Threads Memory | 894 | 256.0 (pgrust shared memory) | — | 184.3 → 718.2 | 533.9 | 784.9 (2) | 6 |
| pgrust Postmaster Memory (broker, pre-release store) | 1537 | 545.1 (pgrust shared memory) | — | 184.8 → 775.4 | 590.7 | 842.5 (2) | 16 |
| PGlite OPFS repacked (relaxed) | 3654 | 188.6 (PGlite emscripten heap) | 240.2 | 185.0 → 750.0 | 565.0 | 816.8 (2) | 1 |
| pgrust Postmaster OPFS repacked (relaxed, pre-release store) | 3786 | 545.1 (pgrust shared memory) | — | 184.8 → 650.8 | 465.9 | 717.8 (2) | 16 |

Page-memory breakdown, where there is one:

| Configuration | DedicatedWorkerGlobalScope | Window | Shared + DOM | after release, Engine closed |
| --- | --- | --- | --- | --- |
| PGlite Memory | 241.5 | 35.7 | 0.6 | not within 30 s |
| pgrust Threads Memory | — | — | — | 36.5 |
| pgrust Postmaster Memory (broker) | — | — | — | 36.4 |
| PGlite OPFS repacked (relaxed) | 203.7 | 35.7 | 0.7 | not within 30 s |
| pgrust Postmaster OPFS repacked (relaxed) | — | — | — | 36.5 |

## Which number is which

- **wasm memory — per Engine, and an ALLOCATION, not a residency.** pgrust's host creates its shared
  memory at 256 MiB with a 4 GiB maximum before the guest runs, so the threads column's 256.0 MiB is
  its opening claim untouched, and the postmaster's 545.1 MiB is how far the guest grew it. PGlite's
  188.6 MiB is an emscripten heap, which grows only when it is used.
- **page memory — per page**, i.e. this agent cluster: the window and the page's workers, JS objects
  and the wasm memory they hold.
- **page renderer RSS — per process.** The renderer that hosts the page and all its workers; `before`
  is the loaded page with no Engine open. This is the only number that says what is actually
  resident. Chromium keeps a **spare renderer** (~67 MiB) alongside, which is why `all renderers RSS`
  is the larger figure and why the page's own renderer is identified by size.
- **worker targets — per browser**, counted over CDP so nested workers are included; `page.workers()`
  agreed with it in every row.

## Reading

- **On what is resident, the three Engines are within ~11% of each other**, and PGlite is not the
  cheapest: 558 MiB of RSS growth for PGlite Memory, 534 for one pgrust threads session, 591 for a
  whole pgrust postmaster. A postmaster with sixteen live workers costs about 6% more resident memory
  than PGlite with one.
- **The allocation numbers say something quite different from the residency ones**, which is exactly
  why both are here. pgrust's postmaster claims 545 MiB of wasm address space against PGlite's 189 —
  nearly three times — and ends up 6% larger in RSS. Reading `WebAssembly.Memory.buffer.byteLength`
  alone would have overstated pgrust's cost by a factor of three.
- **Worker count is where the two designs really differ: 1 against 6 against 16.** The postmaster's
  sixteen are the prewarmed wasi thread pool plus the storage coordinator, and they are threads of
  one Postgres rather than sixteen databases — but they are sixteen real agents in the renderer.
- **The store adds nothing measurable to PGlite and takes ~125 MiB off the postmaster.** PGlite's two
  columns are the same allocation and the same RSS; the postmaster's OPFS column is 466 MiB resident
  against 591 for the memory port, which is the arena living in OPFS files rather than in the
  coordinator's heap. Both OPFS columns ran headlessly without complaint.
- **`performance.measureUserAgentSpecificMemory()` cannot measure a page while pgrust is open.** It
  waits for a garbage collection across every agent in the cluster, and pgrust's workers are parked
  in `Atomics.wait` inside the guest, where they can never take part in one — the call never returned
  in 30 s for any pgrust column. The test of that explanation is in the last column: on the same
  page, moments after the Engine was closed and its workers terminated, the same call returned
  36.5 MiB (the bare page). For any application that wants to report its own memory use, this is a
  real consequence of the threads design: the standard API goes dark while the database is open.
  (PGlite's blank in that column is a different thing — Chrome delays repeat measurements by up to
  ~20 s, and its first measurement had already succeeded.)

## Caveats

- One run per Configuration, single samples. RSS moves by tens of MiB between runs; the ~11% spread
  between Engines is inside the noise this method can resolve, and should be read as "the same order,
  not obviously different" rather than as a ranking.
- The probe needs the **full** Chromium build: `chromium.launch({ headless: true })` uses
  `chromium_headless_shell`, where `measureUserAgentSpecificMemory` exists but throws
  `SecurityError: … is not available.` on a demonstrably cross-origin-isolated page. `bun run bench`
  is unchanged and still runs the shell.
- The Configuration ids are this repo's own: `pgrust-threads-memory` is the single-session threads
  column on its private copy of the filesystem (`fs: "copy"`), and `pgrust-postmaster-memory-broker`
  is the postmaster on the coordinator's memory port.
