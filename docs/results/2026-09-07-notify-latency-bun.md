# Cross-session NOTIFY latency, pgrust postmaster under bun

- Date: 2026-09-07
- Runtime: bun 1.4.2 on Linux 7.0.0-30-generic (x86_64, i7-1165G7), no browser
- Engine: pgrust `08a306441f`, `PostmasterMain` over host pipes, broker store on the memory port
- Client: `PgrustPGlite` (PGlite's `BasePGlite`, pgrust transport), `@pgxsinkit/pglite` 0.5.5-pgx.3
- Driver: `bun run probe:notify` (`scripts/probe-notify-latency.ts`)

## Method

One postmaster, two sessions, two `PgrustPGlite` clients on them: A does `LISTEN probe` and then
sits idle with `pumpNotifications()` watching its ring; B notifies from its own backend. A round is
timed from B's statement resolving to A's listener callback, 50 rounds per row. The two variants are
a bare `NOTIFY probe, '<payload>'` and an `INSERT` into a table carrying a statement-level plpgsql
trigger that calls `pg_notify` — the shape PGlite's `live` extension builds. Each variant runs at two
cadences: a **fixed** 20 ms gap between rounds, and a **swept** gap of 20–110 ms in 10 ms steps,
which lands the rounds at every phase of the guest's poll instead of at one of them.

## Numbers

| Variant | Cadence | delivered | lost | min (ms) | median (ms) | p95 (ms) | max (ms) | mean (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NOTIFY from session B | fixed 20 ms | 50/50 | 0 | 56.2 | 78.6 | 79.5 | 80.2 | 78.2 |
| NOTIFY from session B | swept 20–110 ms | 50/50 | 0 | 7.9 | 49.7 | 99.3 | 99.8 | 54.2 |
| INSERT + statement trigger calling pg_notify (the live shape) | fixed 20 ms | 50/50 | 0 | 70.6 | 77.2 | 78.6 | 82.1 | 76.8 |
| INSERT + statement trigger calling pg_notify (the live shape) | swept 20–110 ms | 50/50 | 0 | 7.0 | 48.9 | 97.8 | 98.0 | 52.9 |

Boot: postmaster ready in 1220 ms, two sessions handshaken in 166 ms, clean shutdown (exit 0, the
shutdown checkpoint ran). 200 of 200 notifications arrived.

## Reading

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
