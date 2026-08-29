# pgrust: multi-statement simple queries need (statements × message size) memory

Found 2026-08-29 against pgrust `438c8c420b` (wasm32-wasip1, `wasm-release`, `--stdio-wire`),
reproduced in Chrome 152 and under Node 26 with the same `wiresession.js` host.

## Symptom

Speedtest script 2 (`benchmark2.sql`: `BEGIN; CREATE TABLE t2 …; 25 000 × INSERT; COMMIT;`, 2 014 081
bytes) sent as one simple-query (`Q`) message fails after 2 047 statements:

```
ERROR:  out of memory  (SQLSTATE 53200)
DETAIL: Failed on request of size 2014081 in memory context "MessageContext".
…
MessageContext: 4170892161 total in 2065 blocks; 0 free; 4170892161 used [Bump]
Grand total: 4177101420 bytes
```

2 065 blocks × ~2 MB = the whole query text copied once **per executed statement**, held in the
Bump-allocated `MessageContext` (never freed within a message) until the wasm32 4 GiB linear-memory
ceiling. The same script runs to completion on PGlite (0.54 s) — C Postgres frees per-statement
allocations through a child context for all but the last parsetree
(`exec_simple_query`), and never copies the query text per statement.

`crates/backend/tcop/postgres/src/simple_query.rs` documents the divergence:

> C uses a per-parsetree child context for all but the last parsetree so multi-statement strings
> free as they go; collapsed onto the MessageContext arena (its reset reclaims everything per
> message).

The per-statement copy is `PortalDefineQuery`
(`crates/backend/utils/mmgr/portalmem/src/lib.rs:370`):
`p.sourceText = Some(PgString::from_str_in(sourceText, mcx)?)` — the whole message text is
duplicated into the arena for every portal, where C's `portal->sourceText = sourceText` stores a
pointer. Either fix alone (free per statement, or stop copying) would bound the growth; the copy
is the cheaper one to remove.

Natively this is a silent O(statements × bytes) memory spike; on wasm32 it is a hard failure.

## Impact on this benchmark

Estimated peak `MessageContext` (bytes × statements) per Speedtest script:

| script     |   bytes | statements | est. peak |
| ---------- | ------: | ---------: | --------: |
| 2, 3       |  2.0 MB |     25 003 |    ~47 GB |
| 10         |  1.8 MB |     25 002 |    ~43 GB |
| 9          |  0.9 MB |     25 002 |    ~21 GB |
| 15         | 0.96 MB |     12 003 |    ~11 GB |
| 7          |  0.3 MB |      5 002 |   ~1.4 GB |
| all others |         |            |  < 0.1 GB |

So the pgrust Memory column cannot complete the Speedtest Suite as defined (one `exec` per script,
byte-identical to PGlite's) until pgrust either frees per statement or stops copying the text. The
RTT Suite (single statements) is unaffected: pgrust completes it.

## Repro

`tmp/wire-repro.mjs`-style: open a `WireSession`, `await session.query(readFile("benchmark2.sql"))`,
inspect the `E` message fields and the guest stderr memory dump.

## Status

- [ ] Report upstream (malisper/pgrust) with the repro and the memory dump.
- [ ] Decide how the benchmark presents this until fixed (see README).
