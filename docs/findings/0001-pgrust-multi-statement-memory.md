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

The per-statement copy is in parse analysis, `crates/backend/parser/parser_analyze/src/lib.rs:66`
(and the sibling entry points at lines 105, 144, 173, 227, plus `parse_clause/src/lib.rs:1790`):

```rust
pstate.p_sourcetext = Some(mcx::slice_in(mcx, source_text.as_bytes())?.leak());
```

C's `ParseState.p_sourcetext` is a pointer (`pstate->p_sourcetext = sourceText`); pgrust copies the
whole message text into the message arena on every parse-analyze call, i.e. once per statement of a
multi-statement message. `p_sourcetext` is already declared `Option<&'mcx [u8]>`, so the fix is a
borrow with a lifetime tightening on the `parse_analyze_*` signatures — no `unsafe`.

(A first attempt blamed `PortalDefineQuery`'s `PgString::from_str_in(sourceText, mcx)`; that copy goes
to `TopPortalContext` and is freed at `PortalDrop`, so removing it moved the failure from statement
2 047 to 2 048. Branch `bench/portal-source-text-borrow` in the pgrust checkout records that attempt.)

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

## Fix

Branch `bench/parse-source-text-borrow` in the pgrust checkout (commit `dab0f929`, 15 files, +64/−35):
`parse_analyze_*` and the `analyze_seams` seams take `source_text: &'mcx str` and store the borrow;
the six callers whose text genuinely outlives the message (extended-query plansource, `PREPARE`,
`PerformCursorOpen`, SPI plans, SQL-function inlining ×2) make their one arena copy themselves via a
new `mcx::str_in`. No `unsafe`. `cargo check --workspace --all-targets` clean; ~300 unit tests in
the touched crates green.

Result on the same wasm build, same host, one session, scripts 1 → 16 in order:

| script | ms | command tags | errors |
|---|---:|---:|---:|
| 1 | 321 | 1 001 | 0 |
| 2 | 5 150 | 25 003 | 0 |
| 3 | 4 944 | 25 004 | 0 |
| 7 | 1 169 | 5 002 | 0 |
| 9 | 5 405 | 25 002 | 0 |
| 10 | 6 544 | 25 002 | 0 |
| 15 | 1 370 | 12 003 | 0 |
| all others | | | 0 |

The benchmark's pgrust column is built from this branch; `src/vendor/pgrust/VERSION` records the
commit, and the stock-`438c8c420b` result above stays on record.

## Status

- [x] Root-caused and fixed locally (2026-08-29).
- [ ] Report upstream (malisper/pgrust) with the repro, the memory dump, and the patch.
