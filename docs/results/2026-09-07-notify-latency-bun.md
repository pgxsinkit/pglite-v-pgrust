# Cross-session NOTIFY latency, pgrust postmaster under bun

- Date: 2026-09-07
- Runtime: bun 1.4.2 on Linux 7.0.0-30-generic (x86_64, i7-1165G7), no browser
- Engine: pgrust `PostmasterMain` over host pipes, broker store on the memory port — **before**
  `08a306441f`, **after** `d74e974426`
- Client: `PgrustPGlite` (PGlite's `BasePGlite`, pgrust transport), `@pgxsinkit/pglite` 0.5.5-pgx.3
- Driver: `bun run probe:notify` (`scripts/probe-notify-latency.ts`)

Two runs of the same probe, either side of one change in the transport. **Before**, the connection
record's fourth word was `reserved` and this host wrote 0 into it, so a blocked backend learned about
another backend's `NOTIFY` only when its own 100 ms interrupt poll next woke. **After**, pgrust
`d2da198f48` made that word a per-session **wake fd**: the host now creates a third ring per session,
registers it as fd `900+k`, and puts its number in the record — and all three of a session's rings
share one gate, so the backend's `poll` over its in fd and its wake fd is a single `Atomics.wait` that
another backend's `SetLatch` ends at once. Nothing else about the probe changed.

## Method

One postmaster, two sessions, two `PgrustPGlite` clients on them: A does `LISTEN probe` and then
sits idle with `pumpNotifications()` watching its ring; B notifies from its own backend. A round is
timed from B's statement resolving to A's listener callback, 50 rounds per row. The two variants are
a bare `NOTIFY probe, '<payload>'` and an `INSERT` into a table carrying a statement-level plpgsql
trigger that calls `pg_notify` — the shape PGlite's `live` extension builds. Each variant runs at two
cadences: a **fixed** 20 ms gap between rounds, and a **swept** gap of 20–110 ms in 10 ms steps,
which lands the rounds at every phase of the guest's poll instead of at one of them.

## Numbers — before (pgrust `08a306441f`, `reserved = 0`)

| Variant | Cadence | delivered | lost | min (ms) | median (ms) | p95 (ms) | max (ms) | mean (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NOTIFY from session B | fixed 20 ms | 50/50 | 0 | 56.2 | 78.6 | 79.5 | 80.2 | 78.2 |
| NOTIFY from session B | swept 20–110 ms | 50/50 | 0 | 7.9 | 49.7 | 99.3 | 99.8 | 54.2 |
| INSERT + statement trigger calling pg_notify (the live shape) | fixed 20 ms | 50/50 | 0 | 70.6 | 77.2 | 78.6 | 82.1 | 76.8 |
| INSERT + statement trigger calling pg_notify (the live shape) | swept 20–110 ms | 50/50 | 0 | 7.0 | 48.9 | 97.8 | 98.0 | 52.9 |

Boot: postmaster ready in 1220 ms, two sessions handshaken in 166 ms, clean shutdown (exit 0, the
shutdown checkpoint ran). 200 of 200 notifications arrived.

## Reading — before

- **Delivery is reliable and the bound is the guest's 100 ms idle poll, exactly as predicted.** The
  swept rows are a uniform distribution over `[0, 100)` ms: min ≈ 7, median ≈ 49, p95 ≈ 99, max ≈ 100.
  That is the signature of a listener whose backend learns about a notification only when its next
  poll wakes, and there is no evidence of anything slower behind it.
- **The two variants are the same measurement.** The trigger's `pg_notify` costs nothing measurable
  over a bare `NOTIFY` (medians 48.9 against 49.7 ms), so a `live` subscription split across two
  sessions would pay the poll and nothing else.
- **The fixed cadence is a trap, and it is in the table to show why.** With a constant 20 ms gap the
  loop phase-locks to the poll — 50 rounds took exactly 5.0 s, i.e. one round per 100 ms — and the
  spread collapses to 56–80 ms. Read alone it would suggest a stable ~78 ms latency; it is one phase
  of the distribution sampled fifty times.
- **What it costs to see any of this:** an idle client must watch its own ring. `pumpNotifications()`
  is opt-in for exactly that reason, reads only when no exchange is in flight, and adds a 1 ms host
  poll — two orders of magnitude under the 100 ms it is waiting on.
- **Against the one-session shape**, where the notification rides back inline on the writing
  statement's own reply (`bun run scenario:pgxsinkit-live`), this is ~50 ms of median latency that
  a two-session split would introduce and a single session does not pay.

## Numbers — after (pgrust `d74e974426`, per-session wake fd)

| Variant | Cadence | delivered | lost | min (ms) | median (ms) | p95 (ms) | max (ms) | mean (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NOTIFY from session B | fixed 20 ms | 50/50 | 0 | 0.0 | 0.3 | 0.9 | 2.0 | 0.4 |
| NOTIFY from session B | swept 20–110 ms | 50/50 | 0 | 0.0 | 0.3 | 0.8 | 0.9 | 0.3 |
| INSERT + statement trigger calling pg_notify (the live shape) | fixed 20 ms | 50/50 | 0 | 0.0 | 0.5 | 0.9 | 0.9 | 0.5 |
| INSERT + statement trigger calling pg_notify (the live shape) | swept 20–110 ms | 50/50 | 0 | 0.0 | 0.3 | 0.7 | 0.8 | 0.4 |

Boot: postmaster ready in 1363 ms, two sessions handshaken in 183 ms, clean shutdown (exit 0, the
shutdown checkpoint ran). 200 of 200 notifications arrived.

## Reading — after

- **The 100 ms bound is gone; what is left is the two backends' own work.** Every row's median is
  0.3–0.5 ms and every maximum is at or under 2.0 ms, against a before-median of ~49 ms and a
  before-maximum of ~100 ms. A cross-session notification now costs about as much as the round trip
  that raised it (RTT Suite medians on this Engine are 0.4–1.4 ms), which is the honest floor.
- **The cadence no longer changes the answer**, and that is the clearest evidence the poll is out of
  the path: fixed and swept agree to 0.2 ms, where before they disagreed by 30 ms. The fixed run's 50
  rounds took 1.1 s rather than 5.0 s, because there is no longer a 100 ms wheel for the loop to
  phase-lock to.
- **The two variants remain the same measurement.** The trigger's `pg_notify` costs 0.2 ms over a
  bare `NOTIFY` at the median, which is inside the spread of either.
- **A two-session split now costs what a single session costs.** The one-session shape
  (`bun run scenario:pgxsinkit-live`, notification inline on the writing statement's own reply,
  29.2 ms end to end including the client's re-query) is no longer the only way to get sub-poll
  delivery: the ~50 ms median the split used to add is now ~0.3 ms.
- **What still has to be true for it to work:** the host must create the wake ring, register it on
  fd `900+k`, put that fd in the connection record and build all three of the session's rings on one
  gate. A host that writes 0 there gets the "before" table back — that is exactly what pgrust's own
  `--no-session-wake` lane reproduces.
