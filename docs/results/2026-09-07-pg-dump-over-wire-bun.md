# Data export over the wire: PGlite's wasm pg_dump against a pgrust backend

- Date: 2026-09-07
- Runtime: bun 1.4.2 on Linux 7.0.0-30-generic (x86_64, i7-1165G7), no browser
- Engine: pgrust `08a306441f`, `PostmasterMain` over host pipes, broker store on the memory port
- Client: `PgrustPGlite`, `@pgxsinkit/pglite` 0.5.5-pgx.3, `@electric-sql/pglite-tools` 0.4.8
- Driver: `bun run probe:pg-dump` (`scripts/probe-pg-dump.ts`); `--async` reproduces the failure
- pg_dump 18.3 dumping database version 18.3

## Method

One postmaster, one session, one `PgrustPGlite`. The probe creates two tables, an index, five rows
and a plpgsql function, runs `pgDump({ pg })` and asserts the dump carries all six. `pgDump` is a
whole libpq compiled to wasm: its write callback calls `pg.execProtocolRawStream(bytes, { onRawData })`
without awaiting it and its read callback consumes the buffered reply on the same tick, inside a
blocking `callMain` where no microtask can run. Three runs are recorded: the client as it stood
before this probe, the client with the fix but the blocking path forced off (`--async`), and the
client as it now stands.

## Numbers

| Run | Result | Where it stopped |
| --- | --- | --- |
| as-is (client before this probe) | FAIL | `PgrustPGlite: the backend closed the session while a reply was outstanding` — the session was already dead by the time `pgDump` ran its post-dump `DEALLOCATE ALL`, and the unawaited raw-stream promise rejected on its own |
| `--async` (fix in place, blocking path off) | FAIL | `pg_dump failed with exit code 1 … server closed the connection unexpectedly … Query was: SELECT pg_catalog.set_config('search_path', '', false);` |
| current | PASS | dump.sql, 2596 bytes, 412 ms; all six required parts present; the session still answers queries afterwards |

| Measure | Value |
| --- | --- |
| postmaster boot | 1192 ms |
| `pgDump({ pg })` wall time | 412 ms |
| dump size | 2596 bytes |
| data form | `INSERT` statements (`pgDump` hard-codes `--inserts`) |
| session after the dump | usable — `select count(*) from book` → 3 |

## The two failure modes, and what each one taught

- **As-is: the session dies at libpq's first act.** pg_dump is a real libpq and opens with a startup
  packet. The old client forwarded it, and a backend that is long past its handshake answers a
  startup packet by terminating. Every later call then saw EOF. PGlite has the same problem and
  solves it its own way — `execProtocolRawSync` intercepts `message[0] === 0` and re-runs
  `ProcessStartupPacket` against its live backend. Over a wire there is nothing to re-run, so the
  handshake reply this session already received is **recorded at init and replayed**. An
  `SSLRequest`/`GSSENCRequest` is refused with the protocol's own one-byte `N` for the same reason.
- **`--async`: the transport's asynchrony, isolated.** With the startup answered, the connection
  comes up and pg_dump's first query is written — and its read callback finds an empty buffer,
  returns zero bytes, and libpq reads that as EOF. This is the failure the probe was written to
  find, and the message names the exact query it died on.

## The fix, and the rule

`execProtocolRawStream` — and only that method — drives the ring with the **blocking** half of
`SabPipe` (`write({ block: true })`, `readInto`) when both hold: this agent may park in
`Atomics.wait` (bun's main thread, any Worker; never a browser's main thread — the check is a real
`Atomics.wait` call, not environment sniffing), and no other exchange is in flight. It then reaches
`onRawData` inside its own synchronous prefix, which is exactly the contract PGlite's engine offers
and pg_dump depends on. Everything else stays asynchronous; `execProtocolRaw` deliberately does not
take the blocking path. The framing is shared between the two loops (`#scanForReply`), and one more
thing had to change for libpq: the reply terminator is taken from the **last** whole message in a
write, because libpq flushes whole `Parse`/`Bind`/`Describe`/`Execute`/`Sync` batches where
`BasePGlite` only ever sends one message at a time.

## Reading

- **pgxsinkit's data export works over the wire, unmodified.** `pgDump({ pg })` is the published
  package, called as pgxsinkit calls it, and the dump is a real pg_dump 18.3 dump.
- **It costs a blocking transport path.** That is available under bun and in any Worker, which
  covers the engine-worker shape this transport is headed for, but it is **not** available on a
  browser's main thread — a `PgrustPGlite` created there can do everything else and cannot run
  pg_dump. Worth knowing before an export button is wired to a main-thread client.
- **The dependency's peer range does not match and nothing came of it.** `@electric-sql/pglite-tools`
  0.4.8 declares `@electric-sql/pglite: 0.5.8`; this repo aliases that name to
  `@pgxsinkit/pglite@0.5.5-pgx.3`. bun installed it without a nested copy, so pg_dump talks to our
  client and not to a second PGlite.
