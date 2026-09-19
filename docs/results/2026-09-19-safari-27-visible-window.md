# Safari 27.0, and the rule that a Run needs a window on screen

- Date: 2026-09-19
- Browser: **Safari 27.0** on **macOS 27.0 (26A428)**, driven over WebDriver by `safaridriver`. The
  shipping engine on the shipping OS, not Playwright's WebKit. The machine was reinstalled since the
  8 September runs: same Apple M2 (4 performance + 4 efficiency cores, 16 GB), a 1920×1080 display
  attached and awake, one user session.
- Page: the published Pages build <https://pgxsinkit.github.io/pglite-v-pgrust/>, **one Configuration
  per WebDriver session** through `?configurations=<id>`, so the Run's memory and time belong to one
  column. (The 8 September Safari runs were served from the Linux box at `http://localhost:4199/`
  over an ssh tunnel; the build pipeline is the same, only the origin differs, and the fetch it
  changes is untimed.)
- Engines, from the page's own header:
  `@pgxsinkit/pglite 0.5.5-pgx.3 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust 569d16128c |
  wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available`
- Comparison lane: headless **Chromium 149.0.7827.55** on Linux (i7-1165G7, 8 threads), the runs
  recorded in [`docs/findings/0002`](../findings/0002-pgrust-autocommit-insert-regression.md)
  §"Adopted (2026-09-19)" against **the same module** this page loads.
- Driver: `scripts/safari-drive.ts`, promoted out of scratch for this note and given the visibility
  guard §6 describes. Raw artefacts: `tmp/agents/safari27/runs/` (untracked).

## What this answers

Two Safari notes were written on 8 September — [the memory
diet](2026-09-08-webkit-memory-diet.md) and [the concurrency
collapse](2026-09-08-safari-concurrency.md) — and every timing conclusion in them was taken on
**Safari 26.6.2 / macOS 26.6.2**. The Mac has since been reinstalled and moved a **major browser
version**, to Safari 27.0 on macOS 27.0. So: do those conclusions still describe the browser this
repo has to run on?

They do not. Every one that was re-measured has moved (§7 lists the two that were not), and the
Suite the postmaster used to take 50 s over now takes 5. Those notes are **superseded, not wrong**:
they are accurate observations of a browser that is no longer installed anywhere this repo can reach.

A second thing came out of re-measuring, and it is the more useful half: **a hidden Safari window
costs about 6×**. That is a property of Safari 27.0, measured here, and it is why this note ends in a
rule and a guard rather than a table.

## Method, and what each number is

Each Run is its own WebDriver session: navigate to a URL naming one Configuration, wait for
`crossOriginIsolated` with the Suite rendered, read `document.visibilityState`, click the Suite's
Start, wait for `data-state=complete`, read the page's own Markdown export back off the DOM.

- **Suite total (cells)** — the sum of the Benchmark cells, not the wall clock from the click. A
  Measurement is taken inside the worker around the Engine call alone; the wall also carries ~90 MB
  of asset fetch, a wasm compile and a cold store seed, none of which any Benchmark measures.
- **visible / hidden** — `document.visibilityState` read on the page itself, `"visible"` or
  `"hidden"`. The hidden arm was produced by minimising the window through WebDriver
  (`POST /session/{id}/window/minimize`) after the page was ready and before the click, and the state
  was confirmed on the page afterwards. The two arms were **alternated**, not batched.
- **wasm memory** — the Engine's own `WebAssembly.Memory.buffer.byteLength`, published by the page
  (Safari has no CDP, so a driver can only read what the page publishes). A `WebAssembly.Memory`
  never shrinks, so the value at the end of a Run is that Run's high-water mark. It is an allocation,
  not a residency.
- **peak WebContent RSS** — `ps -axo pid=,rss=,command=` on the Mac every two seconds, attributed to
  the WebContent process that GREW (Safari keeps a just-closed tab's process alive for a while). Read
  §5's caveat before comparing these with 8 September's: the Runs are now so short that the sampler
  only gets four to seven samples.

Four Speedtest Runs of `pglite-memory` and three of `pgrust-postmaster-opfs-repacked-relaxed` were
taken visible, and two of each minimised. The Runs with full artefact directories are
`tmp/agents/safari27/runs/{a,b}-*` (Speedtest) and `conc-*` (Concurrency). **The remaining three
visible totals (2519, 2561, 4948 ms) and all four hidden totals came from a scratch driver,
`tmp/agents/safari27/visibility.ts`, which printed Suite totals and nothing else** — there is no
artefact directory behind those seven numbers, only the printed total and the `visibilityState` it
printed beside it. A further Speedtest round (`r1-*`) was taken while the Mac's owner was using
Safari; it is discarded, and no number in this note comes from it.

## 1. Speedtest with the window visible, against 8 September

`pgrust Postmaster OPFS repacked (relaxed)` and `PGlite Memory`, Suite total in cells:

| Configuration | Safari 26.6.2, 8 Sep | Safari 27.0, 19 Sep, visible | median | change |
| --- | --- | --- | --- | --- |
| PGlite Memory | 17 172 ms | 2527 / 2513 / 2519 / 2561 ms | **2523 ms** | **6.8× faster** |
| pgrust Postmaster OPFS repacked (relaxed) | 49 961 ms (median of four: 47 879) | 4963 / 4902 / 4948 ms | **4948 ms** | **9.7× faster** |
| pgrust ÷ PGlite | 2.91× | — | **1.96×** | — |

Two things to keep straight in that table.

**The PGlite row is a controlled comparison and the pgrust row is not.** `@pgxsinkit/pglite
0.5.5-pgx.3` is the same package on both dates and its emscripten heap reports the same 226.3 MiB on
both, so nothing about that Engine changed between 17 172 ms and 2523 ms. pgrust did change — `e8e8ee061d`
then, `569d16128c` now, which is the v0.3 rebase plus everything in
[2026-09-16](2026-09-16-pgrust-v0.3-rebase.md), [2026-09-18](2026-09-18-speed-first-profile.md) and
`findings/0002`. On headless Chromium that engine work alone took the same Suite from **36 402 ms to
19 061 ms** — a factor of 1.9 — so of the pgrust row's 9.7×, about 1.9× is engine work measured on
another browser and the remaining ~5× is this machine, this browser and this window. PGlite's 6.8×,
where no engine changed at all, is the honest scale for that part.

**Safari is no longer the slow lane.** The current Chromium/Linux numbers for the identical module
and page are `pglite-memory` **7152 / 7218 ms** and `pgrust-postmaster-opfs-repacked-relaxed`
**19 061 / 19 012 ms** (`findings/0002`, adopted 2026-09-19, headless Chromium 149 on the i7-1165G7).
Against this Mac's 2523 and 4948, the Safari/M2 pair is **2.8× faster on PGlite and 3.9× faster on
the postmaster** than the Chromium/i7 pair — where 8 September read it as ~3× slower, in both
engines. The postmaster is also closer to PGlite here (**1.96×**) than it is on Chromium (**2.65×**).
Hardware is folded into all of those numbers, as it was folded into the 8 September ones.

## 2. The hidden window costs about 6×

The same Configurations, the same session shape, alternated with the Runs above; the only difference
is a `POST /window/minimize` before the click, and `document.visibilityState` reading `hidden` rather
than `visible` when the Suite starts.

| Configuration | visible (median) | minimised, hidden | hidden ÷ visible |
| --- | --- | --- | --- |
| PGlite Memory | 2523 ms | 15 736 / 16 011 ms | **6.3×** |
| pgrust Postmaster OPFS repacked (relaxed) | 4948 ms | 35 366 / 35 581 ms | **7.2×** |
| pgrust ÷ PGlite | 1.96× | 2.23× | — |

So the penalty is large, it is repeatable to within 2% across the pairs, and it is **not a uniform
scaling**: the two engines are 1.96× apart on screen and 2.23× apart minimised, so a hidden Run does
not even preserve the ranking's size. Any comparison taken with the window off screen is measuring
Safari's background policy as much as it is measuring an Engine.

This is a Safari 27.0 measurement. Nothing here says what Safari 26.6.2 did to a hidden window,
because that browser is no longer on the machine (see §7).

## 3. Concurrency

One Run of each Configuration, window visible, four Clients. The 8 September columns are the
**after-fix** ones from [the concurrency note](2026-09-08-safari-concurrency.md) §6 — the host gate
was in place for both dates, so this is not a before/after of that change.

| Benchmark | PGlite, 8 Sep | pgrust, 8 Sep | PGlite, 19 Sep | pgrust, 19 Sep |
| --- | --- | --- | --- | --- |
| Test 1: read fan-out, 4×500 point SELECTs, total wall | 1499.1 ms | 3246.3 ms (2.17×) | **190.0 ms** | **264.7 ms (1.39×)** |
| Test 2: reader p95 under a bulk write | 2120.7 ms | 8.2 ms | 251.4 ms | 1.26 ms |
| Test 3: short p95 beside a long query | 635.4 ms | 6.4 ms | 131.0 ms | 0.44 ms |
| Test 4: writers on disjoint rows (txn/s, higher better) | 822.6 | 503.4 | 2760.5 | **8611.4** |
| Test 5: writers on the same row, p95 | 6.6 ms | 14.9 ms | 0.86 ms | 0.92 ms |

Underneath Test 1, from the same Run's detail rows: pgrust ran its 2000 point SELECTs at **7555
statements/s**, per-Client p50 **0.42 ms**, p95 1.12–1.26 ms, max 4.38–4.64 ms; PGlite at 10 524
statements/s, p50 0.34 ms, max 1.5–2.2 ms.

Those three numbers are what retire the residual the 8 September note ended on. It recorded the
postmaster at **~523 transactions/s** in Test 4 against Chromium's 10 735, a **~2 ms per statement**
Safari surcharge that the wake-path microbenchmark could not explain, and a per-Client **max of
~1002 ms** — one agent stall per Run, surviving the host-gate fix. In this Run the surcharge is not
visible (0.42 ms per point SELECT, against PGlite's 0.34 ms on the same page), Test 4 is 17× the old
figure, and the worst round trip across 2000 of them was 4.64 ms. **No stall event appeared.** One
Run cannot prove a rare event is gone — the old rate was about one per Run — so the honest statement
is that it did not appear here, not that it cannot.

## 4. RTT

The RTT Suite was run once with **all fourteen Configurations** selected, and it completed — every
column, including the two single-session `pgrust Memory` columns that need JSPI and are only now
runnable on Safari, in about 45 s. That Run may have been disturbed, so its numbers are not published
here: the claim is that the fourteen-column RTT Suite runs to completion on Safari 27.0, and nothing
about how fast.

## 5. Memory

wasm memory is a property of the guest, not of the browser — Chromium and Safari reported the same
figure for the same module on 8 September — so these rows move only because pgrust moved:

| Configuration | Suite | wasm memory, 8 Sep | wasm memory, 19 Sep |
| --- | --- | --- | --- |
| PGlite Memory | Speedtest | 226.3 MiB (emscripten heap) | **226.3 MiB** (237 305 856 B) |
| PGlite Memory | Concurrency | — | 188.6 MiB (197 722 112 B) |
| pgrust Postmaster OPFS repacked (relaxed) | Speedtest | 656.9 MiB | **260.4 MiB** (273 088 512 B) |
| pgrust Postmaster OPFS repacked (relaxed) | Concurrency | 366.9 MiB | **264.0 MiB** (276 824 064 B) |

PGlite's heap is identical to the byte, which is the check that this is the same page measuring the
same way. The postmaster's 656.9 → 260.4 MiB on the Speedtest Suite is the `MessageContext` arena
work of [`findings/0001`](../findings/0001-pgrust-multi-statement-memory.md) landing in pgrust 0.3,
not anything Safari did; `findings/0002`'s own gate records 273 219 584 B of shared memory for this
module on Chromium, which is this figure within two wasm pages.

Peak WebContent RSS, the process that grew:

| Configuration | Suite | 8 Sep | 19 Sep |
| --- | --- | --- | --- |
| PGlite Memory | Speedtest | 1945 MB | 1112 / 1641 MB |
| pgrust Postmaster OPFS repacked (relaxed) | Speedtest | 2017 MB | 989 / 1048 MB |
| pgrust Postmaster OPFS repacked (relaxed) | Concurrency | 1921 MB | 1354 MB |
| PGlite Memory | Concurrency | — | 1604 MB |

**Do not read these as a 2× memory saving.** The sampler takes one `ps` every two seconds, and a Run
that used to last 50 s now lasts 5–10 s: these peaks rest on **four to seven samples** each, against
several times that in September's longer Runs. The two PGlite Speedtest Runs, identical in every other respect,
came out 1112 and 1641 MB — a 48% spread, which is the measurement's own resolution and not a
difference between the Runs. Each figure is a lower bound on the peak. The only thing this table
supports is that the postmaster's renderer is no longer above PGlite's, which was the point of the
memory diet and which the wasm-memory table above says far better.

## 6. The new rule: a Safari Run only counts with a visible window

Given §2, a Suite total taken on a hidden page is off by a factor of six and looks like a perfectly
ordinary number. So the rule is that **a Safari Run counts only if the page was visible for the whole
of it**, and the driver enforces it rather than the operator remembering it.

`scripts/safari-drive.ts` — promoted out of `tmp/agents/diet/` because published notes now cite it,
and run as `bun run safari:drive`:

- after the page is ready and **before** the Start click it reads `document.visibilityState`. Not
  `visible`: it deletes the session and exits non-zero, with a message naming the three things to
  check — wake the display, un-minimise the window, nobody else using Safari.
- it installs a `visibilitychange` listener before the click, logging every transition with a
  timestamp to a window global, and reads it back at the end with the final state. If the page was
  hidden at any point during the Run, the artefacts are still written, `summary.json` carries
  `"valid": false` with the reason, the driver prints `*** INVALID RUN — DO NOT PUBLISH THESE
  NUMBERS ***` and exits non-zero.
- `--window minimised` minimises through WebDriver on purpose — that is how §2's hidden arm was
  taken — and `--allow-hidden` permits an already-hidden page. Neither suppresses the check: they
  record the hidden state as intended. `window`, `visibilityStart`, `visibilityEnd`,
  `visibilityChanges` and `valid` are in `summary.json` on every Run either way.
- `ssh mac001 caffeinate -d -u -t <seconds>` runs beside the RSS sampler for the length of the Run
  and is killed in the same `finally`, because a display that sleeps takes the window's visibility
  with it.
- the session is deleted on every exit path, and `cells total: N ms` is printed and stored as
  `cellsTotalMs` — the wall clock is quantised to the 5 s completion poll and is not the measurement.

All four paths — visible, refused, deliberately minimised, and hidden part-way through a Run — were
exercised against a **stub WebDriver** (`tmp/agents/safari-guard-check/`, untracked) rather than
against Safari: the Mac was in use by its owner when this was written and `POST /session` timed out
twice, so the guard has not yet refused a real Safari session. The numbers in §1–§5 were taken with
the driver's predecessor and the visibility state read by hand.

## 7. What this does not show

- **It cannot say how much of §1 is the browser and how much is the window state, and it does not
  claim either.** The 8 September Runs did not record `document.visibilityState`, and Safari 26.6.2
  is not installed on any machine this repo can reach, so the experiment that would separate them
  cannot be run. The two candidate explanations are of the same size — PGlite's total moved 6.8×
  between the dates, and minimising the window on Safari 27.0 moves it 6.3× on its own — which means
  the window state alone could account for the whole of it, and so could the browser. Nothing here
  distinguishes them, and no claim is made.
- **Nothing about the hidden state on Safari 26.** Whether 26.6.2 also throttled a hidden window ~6×,
  or throttled it differently, or not at all, is unmeasured and unmeasurable now.
- **Minimised is not the only way to be hidden.** Only `POST /window/minimize` was tested. A sleeping
  display, an occluded window, a background tab and a locked screen are four different states in
  WebKit's own accounting and none of them was measured; the driver's `caffeinate -d -u` exists
  precisely because the display-asleep case is untested.
- **Two Safari 26 findings were not re-tested at all**, and nothing here supersedes them: the
  `setTimeout(0)` clamp (the concurrency note §4–§5 measured `setTimeout` polling at a 6 ms median on
  26.6.2, which is why it was rejected as a pump design) and the **two-outstanding-`Atomics.waitAsync`
  agent stall** that the host gate was built for. The gate is still in the build and still shipping;
  §3's clean Test 1 is a Run with the gate, not a Run without it. Whether Safari 27.0 still stops an
  agent that holds two waiters is an open question, and the pure-JS probes (`wake-stall.js`,
  `wake-fix.js`) that would answer it were not run.
- **Two Configurations out of fourteen.** Only `pglite-memory` and
  `pgrust-postmaster-opfs-repacked-relaxed` were measured for time. The four repacked-store columns,
  the `pgrust Threads` family, `pgrust Memory` and both wa-sqlite columns have no Safari 27 timing at
  all beyond the RTT Suite completing in §4.
- **No phone.** The iPhone Xs and iPhone 14 Pro reports that started both 8 September notes are not
  re-measured. iOS's `phys_footprint` is not macOS RSS and a Mac's window-visibility policy is not a
  phone's; a backgrounded iOS tab is a different mechanism again.
- **No Firefox, and only one Chromium lane.** The Chromium figures quoted in §1 come from
  `findings/0002`'s adopted runs on one Linux box; they are there to give the Safari totals a scale,
  not to rank browsers.
- **One Run each on the Concurrency Suite, and no repeats on the hidden arm beyond two.** §3's table
  is a single Run per column. The Speedtest arms are three and four Runs and agree to within 2%,
  which is the only place in this note with a spread worth trusting.
