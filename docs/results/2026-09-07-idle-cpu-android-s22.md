# What an idle Engine costs a phone: Galaxy S22, Chrome 152

- Date: 2026-09-07
- Device: Samsung SM-S9060 (Galaxy S22), Android 16, 4500 mAh, plugged in over USB the whole time
- Browser: Chrome 152.0.7977.82 (`com.android.chrome`, uid `u0a245`)
- Served from: this repo's `dist/` over `adb reverse`, cross-origin isolated, SharedArrayBuffer and
  JSPI available, 8 cores
- Engines: `@pgxsinkit/pglite` 0.5.5-pgx.3, pgrust `d74e974426`, store bundle `5e5d168a99`
- Driver: `bun run probe:idle-cpu-android` (`scripts/probe-idle-cpu-android.ts`)

The desktop half — where the same question can be taken apart process by process — is
[`2026-09-07-idle-cpu-chromium-linux.md`](2026-09-07-idle-cpu-chromium-linux.md), and it carries the
table of which pgrust thread wakes how often and which knob quiets it.

## Method

Per Configuration: Chrome is force-stopped and restarted on `about:blank`; the driver connects over
CDP (`adb forward` to `chrome_devtools_remote`), loads the bench page, opens one Engine through the
page's idle-probe handle, runs one warm RTT Benchmark — and then **disconnects**, because a tab with a
DevTools client attached is a tab the browser keeps awake. Three 120-second windows follow, each
preceded by ten seconds of settling and `dumpsys batterystats --reset` + `dumpsys battery unplug`:

1. **foreground, screen on** — the phone woken, its keyguard dismissed, Chrome resumed on the Engine's
   own tab;
2. **background tab, screen on** — a second Chrome tab opened in front of it;
3. **background tab, screen off** — `stay_on_while_plugged_in = 0` and `KEYCODE_SLEEP`, confirmed by
   `dumpsys power` reporting `Dozing`.

Every 10 s the driver reads, over `adb` alone: Σ(utime + stime) from `/proc/<pid>/stat` over every
`com.android.chrome` process (CLK_TCK 100), and voluntary + involuntary context switches over every
thread of those processes, which is the wakeup count. After each window `dumpsys batterystats
com.android.chrome` gives Android's own estimate for uid `u0a245`; the **cpu** component of it is what
the table reports, because when Chrome is in front Android also charges it the **display** — 3.7 mAh
in a two-minute window, about 111 mAh/h, which is a fact about the screen and not about the database.
At the end the client reconnects, times one `select 1`, and reads the page's own `visibilitychange`
log, which is what the "page state" column is: asking a page for `document.visibilityState` over CDP
answers `visible` whatever the tab was doing, because attaching the client activates it.

The device is restored in a `finally`: `dumpsys battery reset`, screen woken,
`stay_on_while_plugged_in` back to 2, both adb forwards removed.

## Numbers

600 CPU-ms per minute is 1% of one core. `% battery/h` is the CPU component of Android's own mAh
estimate against this phone's 4500 mAh.

| Configuration | Window | page state | CPU-ms/min | % of one core | wakeups/s | CPU mAh/h | % battery/h | reconnect→answer (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| blank page (no Engine) | foreground, screen on | visible | 1082 | 1.80% | 42 | 5.39 | 0.12% | — |
| blank page (no Engine) | background tab, screen on | hidden | 833 | 1.39% | 6 | 1.34 | 0.03% | — |
| blank page (no Engine) | background tab, screen off | hidden | 314 | 0.52% | 3 | 0.57 | 0.01% | — |
| PGlite Memory | foreground, screen on | visible | 1228 | 2.05% | 68 | 4.91 | 0.11% | — |
| PGlite Memory | background tab, screen on | hidden | 1492 | 2.49% | 9 | 3.05 | 0.07% | — |
| PGlite Memory | background tab, screen off | hidden | 394 | 0.66% | 3 | 0.93 | 0.02% | 610 |
| pgrust Postmaster Memory (broker) — default GUCs | foreground, screen on | visible | 2845 | 4.74% | 117 | 7.61 | 0.17% | — |
| pgrust Postmaster Memory (broker) — default GUCs | background tab, screen on | hidden | 2944 | 4.91% | 34 | 5.24 | 0.12% | — |
| pgrust Postmaster Memory (broker) — default GUCs | background tab, screen off | hidden | 329 | 0.55% | 4 | 0.68 | 0.02% | 816 |
| pgrust Postmaster Memory (broker) — quiet GUCs | foreground, screen on | visible | 1807 | 3.01% | 106 | 5.90 | 0.13% | — |
| pgrust Postmaster Memory (broker) — quiet GUCs | background tab, screen on | hidden | 2754 | 4.59% | 29 | 5.30 | 0.12% | — |
| pgrust Postmaster Memory (broker) — quiet GUCs | background tab, screen off | hidden | 519 | 0.87% | 2 | 0.99 | 0.02% | 768 |

For scale, in the same windows: the **display** cost Chrome's uid 3.72–5.98 mAh per two minutes,
i.e. **111–179 mAh/h, 2.5–4.0% of this battery an hour**. Every CPU number above is one to two orders
of magnitude under that.

One sentence each:

- **blank, foreground** — an empty bench page in front costs 5.4 mAh/h of CPU, 0.12% of the battery an
  hour, and that is the floor the Engine rows stand on.
- **blank, background** — hiding the tab takes three quarters of that away (1.34 mAh/h): what stopped
  was the page's own rendering, which is all a blank page has.
- **blank, screen off** — 0.57 mAh/h, 0.01% an hour, which is as close to nothing as this measurement
  can see.
- **PGlite Memory, foreground** — 4.91 mAh/h, *below* the blank page's 5.39 in the same window: a
  PGlite session that is not being queried adds nothing an hour of this measurement can resolve.
- **PGlite Memory, background** — 3.05 mAh/h against blank's 1.34, so about 1.7 mAh/h (0.04%/h) is
  what an idle PGlite in a hidden tab actually costs.
- **PGlite Memory, screen off** — 0.93 against 0.57 mAh/h: 0.36 mAh/h, 0.008% of the battery an hour.
- **pgrust Postmaster, default GUCs, foreground** — 7.61 mAh/h and 117 wakeups a second: the postmaster
  costs 2.2 mAh/h over the blank page (0.05% an hour), which is 2% of what the screen it is being
  looked at through costs.
- **pgrust Postmaster, default GUCs, background** — 5.24 mAh/h, 3.9 over blank (0.09%/h), and the CPU
  did not fall when the tab was hidden (2944 against 2845 CPU-ms/min): the cost lives in Workers, and
  Chrome does not throttle those with visibility.
- **pgrust Postmaster, default GUCs, screen off** — 0.68 mAh/h against the blank page's 0.57, a
  difference of 0.11 mAh/h or **0.002% of the battery an hour**: with the screen off the phone
  suspends the whole browser and the postmaster costs nothing measurable.
- **pgrust Postmaster, quiet GUCs, foreground** — 1807 CPU-ms/min against 2845 default, −36%, and
  5.90 mAh/h against 7.61.
- **pgrust Postmaster, quiet GUCs, background** — 2754 against 2944, −6%: the same knob that is worth a
  quarter of the CPU on the desktop is inside the noise here.
- **pgrust Postmaster, quiet GUCs, screen off** — 0.99 mAh/h against the default run's 0.68, i.e. the
  screen-off rows are all the same number and none of them is distinguishable from an empty tab.

**Nothing was frozen.** Every Engine answered `select 1` after all three windows: 610 ms (PGlite),
816 ms and 768 ms (postmaster) from the client reconnecting to the answer, of which 110 ms, 288 ms and
295 ms were inside the page. Chrome for Android freezes a background tab after about five minutes, and
these windows are two, so this study says what an unfrozen background tab costs — the freezing case is
untested here and would only make the numbers smaller.

## What it means for a battery

- **Screen off, which is where a phone spends most of its life: nothing.** 0.68 mAh/h for a whole idle
  postmaster against 0.57 for an empty tab, on a 4500 mAh battery, is 0.002% an hour — below what this
  method can resolve, and three orders of magnitude under the 111 mAh/h the display draws when it is on.
- **Screen on, tab hidden: 3.9 mAh/h**, 0.09% of the battery an hour. A day of four hours' screen-on
  with the page hidden behind whatever the user is actually doing, plus twenty hours asleep, comes to
  roughly 4 × 3.9 + 20 × 0.11 ≈ **18 mAh, or 0.4% of one charge**.
- An idle **PGlite** in the same place costs about 1.7 mAh/h, so pgrust's postmaster is a little over
  twice it in the state that matters — a difference of about 2 mAh/h, which is a fifth of a percent of
  the battery over an eight-hour day.
- The number that would hurt a phone is not here: nothing in any window was above 5% of one core, and
  the screen-on rows are dominated by the display by a factor of 20 to 40.

## Workarounds, and what each one is worth

| Workaround | What it changed | What it did not |
| --- | --- | --- |
| **The OS sleeping** (screen off) | 2944 → 329 CPU-ms/min and 5.24 → 0.68 mAh/h for the postmaster; the same for every Configuration, all of them landing on the blank page's number | Nothing to do: it is free, automatic, and it is the state the phone is in most of the time |
| **Hiding the tab** (second tab in front) | Took the page's own rendering away — 1082 → 833 CPU-ms/min on the blank row | Did **not** touch the Engine: 2845 → 2944 for the postmaster, 1228 → 1492 for PGlite. Worker threads are not throttled by visibility |
| **Quiet GUCs + `PGRUST_WAITER_RECHECK_MS=0`** | −36% CPU foreground here, −25% on the desktop, and −33% of the desktop's wakeups | −6% in the background window, i.e. inside the noise on this device; and it trades away a lost-wake backstop (a dropped cross-thread wake then costs forever rather than one second) |
| **Postgres's periodic GUCs alone** (`bgwriter_delay`, `wal_writer_delay`, `checkpoint_timeout`, `autovacuum_naptime`) | Nothing measurable (desktop: 290 against 300 CPU-ms/min) | Every one of those periods is already longer than the 1 s recheck cadence that caps every park in the guest, and `autovacuum` is off in this server's argv |
| **Freezing the page** (`Page.setWebLifecycleState`) | Nothing; on the desktop the frozen rows are *higher*, because the client that freezes them costs more than the freeze saves | The Engine's Workers keep running while the page's task queues are stopped |

What remains, in the order it would be worth trying:

1. **The store coordinator's 250 ms heartbeat.** `RepackedSyncBroker`'s `pollIntervalMs` defaults to
   250 ms — four wakeups a second, by its own documentation — and pgrust's `wasm/storage-worker.js`
   does not pass one. `Infinity` makes it a pure park. Untested here, because the vendored host is
   copied byte-verbatim from pgrust and this study changed nothing in it.
2. **Parking the Engine outright.** Nothing in this study stops the guest's threads; an Engine that
   could be told "sleep until I ask again" — close the sessions, let the postmaster stop, and reopen
   from the store — would cost the reopen (4.2 s here) and nothing per hour.
3. **Chrome's own freezing**, which was never reached in a two-minute window. A study that leaves the
   tab hidden for ten minutes would say whether the browser eventually takes the cost away by itself.

## Caveats

- The 10-second sampler is `adb shell`, and it wakes the phone: the screen-off rows describe a device
  that is dozing but disturbed briefly six times a minute, not one in deep Doze.
- The phone was on USB power throughout with `dumpsys battery unplug` in force, so Android's
  accounting behaves as if on battery while the CPU governor behaves as if charging.
- The foreground rows include Chrome's own compositing of a visible page; the background rows are the
  cleaner measurement of an Engine, and the screen-off rows are the cleanest.
- One Run per cell. The desktop lane's repeats put a single cell's spread at about ±20%, and no
  conclusion here rests on a difference smaller than that.
