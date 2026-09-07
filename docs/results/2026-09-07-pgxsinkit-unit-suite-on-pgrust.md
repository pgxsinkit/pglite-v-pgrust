# pgxsinkit's whole unit suite on pgrust: 1968 of 1987, and every failure is one of two engine gaps

- Date: 2026-09-07
- Runtime: bun 1.4.2 on Linux 7.0.0-30-generic (x86_64, 8 logical cores), no browser
- Engines: pgrust `9bab6bff11` (`PostmasterMain` over host pipes, broker store on the **memory**
  port, wasm32-wasip1-threads, 8-byte `Datum`) against a baseline of `@pgxsinkit/pglite`
  0.5.5-pgx.2 (PostgreSQL 18.3, 32-bit emscripten), which is what pgxsinkit's own suite runs on
- Suite: pgxsinkit at `04bf351` (`feat/repacked-sync-broker`), **189 unit files**, unmodified —
  the only change in that repo is the store seam itself
- Driver: `bun run test:pgxsinkit-on-pgrust`
  (`scripts/run-pgxsinkit-on-pgrust.ts` → `src/client/pgxsinkit-test-store-factory.ts`)

## The question, and how the suite got here

The factory scenario proved pgrust could answer pgxsinkit's store contract once, for one store, in
a script this repo wrote. The suite that actually knows what pgxsinkit expects of a store is
pgxsinkit's own. So the seam went the other way round: `tests/support/pglite.ts` now resolves an
optional `PGXSINKIT_TEST_STORE_FACTORY` module and lets it build every store the unit suite uses —
`createFresh`, `createFromDump`, a cache prefix and identity, `closeAll`, and no engine's name
anywhere in the contract. Unset, the suite is PGlite exactly as before.

Thirty of the 189 unit files build their stores through those helpers; the rest construct PGlite
directly or touch no database at all, and are unaffected — they are included below because the
whole suite was run, not a selection.

Two facts shaped the pgrust side. A PGlite datadir cannot boot here and vice versa
(`USE_FLOAT8_BYVAL`, recorded in `2026-09-07-datadir-portability.md`), so `createFresh` starts from
pgrust's own packed image rather than pgxsinkit's `prepopulatedfs` base, and the schema-snapshot
disk cache gets its own filename prefix and identity so the two lanes can never read each other's
tarballs. And every store here is a whole postmaster with its own worker threads, so the seam
tracks and closes them: a leaked engine does not slow a run down, it stops the process exiting.

## Headline

| Lane | Files | Tests | Pass | Fail | Wall time | Shard pool |
| --- | --- | --- | --- | --- | --- | --- |
| PGlite (baseline) | 189 | 1987 | 1987 | 0 | 113.9 s | 4 |
| pgrust, first run | 189 | 1987 | 1940 | 47 | 410.5 s | 3 |
| pgrust, after the `/dev/blob` fix | 189 | 1987 | **1968** | **19** | 475.4 s | 3 |

Skips are not in the table because the runner does not aggregate them: `scripts/run-unit-tests.ts`
sums the `N pass` / `N fail` lines only, and prints a shard's own output solely when it fails. The
two failing shards report 0 skipped and 1 `todo`; the test COUNT is identical in both lanes (1987),
so no file silently ran fewer tests on pgrust.

The pool is 3 rather than the default 4 because each pgrust store is a postmaster with a dozen
worker threads on an 8-core box; the two wall times are therefore not a clean comparison, and the
per-file table below (both lanes run three-at-a-time) is the honest one.

## The failures, classified

Of the 47 failures in the first run, **26 were the seam's fault and are fixed**; the remaining
**19 are pgrust engine gaps**, and they sit in two files. Nothing failed because a test assumes
PGlite internals — no test reached for `Module`, `fs`, an emscripten path or a dump's layout.

| Class | Meaning | First run | Now |
| --- | --- | --- | --- |
| (A) pgrust SQL/behaviour difference | the engine answers differently, or refuses | 19 | **19** |
| (B) seam/factory limitation | something PGlite's client does that this one did not | 26 | **0** |
| (C) test assumes PGlite internals | `Module`, `fs`, dump layout, timing | 0 | 0 |

### (A) — the 19 that remain, verbatim

| File | Test | First error line |
| --- | --- | --- |
| `plpgsql-apply` | array columns in the write path > round-trips empty, non-empty and null arrays through create and update | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | array columns in the write path > leaves an array column untouched when its key is absent from the payload | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | json[] / jsonb[] columns keep each element's JSON value > round-trips a string element as a JSON STRING (the corruption pin), plus objects, nulls and [] | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | canonical entity identity — composite + renamed PK (ADR-0012) > applies update/delete to exactly the addressed row of a composite-PK table | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | canonical entity identity — composite + renamed PK (ADR-0012) > keeps the Server version strictly monotonic even when the wall clock is behind (GREATEST) | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | set-based apply (ADR-0014 Phase 4) > inserts many rows of one (table, kind, column-set) in a single grouped statement, stamping managed fields | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | set-based apply (ADR-0014 Phase 4) > groups partial updates by column-set so each row's untouched columns survive, and bumps every Server version | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | set-based apply (ADR-0014 Phase 4) > applies a mixed create/update/delete batch across groups in one call | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | create-only managed fields are inert on update > applies the ordinary columns and leaves the create-only managed columns at their stored values | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | stale-write conflict detection (ADR-0015 Phase 3) > last-write-wins applies a stale update anyway and reports no conflict | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | stale-write conflict detection (ADR-0015 Phase 3) > reject-if-stale leaves the row untouched and reports the conflict with the current Server version | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | stale-write conflict detection (ADR-0015 Phase 3) > reject-if-stale applies a non-stale update (base == current) and reports no conflict | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | stale-write conflict detection (ADR-0015 Phase 3) > reject-if-stale UPDATE of a MISSING row → conflict (target deleted), nothing applied (#6) | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | stale-write conflict detection (ADR-0015 Phase 3) > reject-if-stale with no base (a create-like write) skips the stale check and applies | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | derived (non-UUID) mutation ids flow through text, not uuid > records a non-UUID mutation id in operations_log when p_log_enabled = true | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | derived (non-UUID) mutation ids flow through text, not uuid > returns a non-UUID mutation id verbatim on a reject-if-stale conflict | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | self-verifying apply function (ADR-0030) > applies when the expected fingerprint matches the stamped comment | `error: funcapi exprType: node family T_NullIfExpr not ported` |
| `plpgsql-apply` | deny-by-default apply-function ACL (ADR-0054) > revokes a grantee it cannot name — an inherited ALTER DEFAULT PRIVILEGES grant — while keeping the allowlist | `error: aclchk: compressed/external ACL varlena — detoast gap` |
| `apply-function-schema` | --function-schema end to end (generate flag ⇄ server option) > qualifies the emitted DDL, the fingerprint, and the runtime call with the same schema | `error: expect(received).toBe(expected)` (HTTP 500; the server log says `ERROR: funcapi exprType: node family T_NullIfExpr not ported`) |

The last row's assertion is `expect(response.status).toBe(200)` against a write-API handler, so the
test never sees the database's words. With `PGXSINKIT_PGRUST_SERVER_LOG=1` the postmaster names the
same gap, which is why it is counted with the other eighteen rather than as a behaviour difference
of its own.

### (B) — the 26 that were the seam's fault, and are not any more

Every one of them was `could not open file "/dev/blob" for reading: No such file or directory`, in
`copy` (24), `bulk-apply` (1) and `apply-ladder` (1), plus two more in `circuits-sync-engine` that
the same gap caused (one directly, one through the held-batch commit path). `COPY … FROM
'/dev/blob'` is pgxsinkit's fastest apply tier, and `/dev/blob` is a character device PGlite
registers inside its own emscripten filesystem — the wire client here had refused the facility on
the grounds that it has no filesystem.

It has one. The coordinator's store IS the guest's root filesystem — `pg_ls_dir('/')` from inside
the server answers `pgdata` and `share` — so `PgrustClientPGlite` now writes a real file at
`/dev/blob` over its own broker channel and the backend opens it like any other. `_handleBlob`
stages the input, `_cleanupBlob` drops it before the base class asks for an output, and
`_getWrittenBlob` takes what `COPY TO` left and empties the file behind it. `copy`, `bulk-apply`,
`apply-ladder` and `circuits-sync-engine` — 71 tests — then passed in full.

## The thirty files that actually build stores through the seam

Both lanes run three files at a time on the same 8-core box, so the ratio is comparable even though
the absolute numbers include contention.

| File | Tests | pgrust pass / fail | PGlite | pgrust | Ratio |
| --- | --- | --- | --- | --- | --- |
| `apply-fingerprint` | 9 | 9 / 0 | 1.0 s | 3.3 s | 3.3× |
| `apply-function-schema` | 4 | 3 / 1 | 2.2 s | 7.1 s | 3.2× |
| `apply-ladder` | 4 | 4 / 0 | 1.8 s | 4.4 s | 2.4× |
| `blind-update` | 6 | 6 / 0 | 3.9 s | 36.7 s | 9.4× |
| `bulk-apply` | 19 | 19 / 0 | 1.9 s | 4.9 s | 2.6× |
| `circuits-group-restart` | 4 | 4 / 0 | 4.0 s | 13.3 s | 3.3× |
| `circuits-group-sync` | 8 | 8 / 0 | 3.4 s | 8.1 s | 2.4× |
| `circuits-shared-handle-dedup` | 1 | 1 / 0 | 1.4 s | 5.4 s | 3.9× |
| `circuits-shared-revocation` | 2 | 2 / 0 | 2.3 s | 8.8 s | 3.8× |
| `circuits-sync-engine` | 11 | 11 / 0 | 3.7 s | 7.9 s | 2.1× |
| `client-managed-field-strip` | 3 | 3 / 0 | 2.1 s | 18.0 s | 8.6× |
| `client-schema` | 10 | 10 / 0 | 0.9 s | 4.4 s | 4.9× |
| `conflict-base-capture` | 4 | 4 / 0 | 2.7 s | 22.9 s | 8.5× |
| `conflict-handling` | 5 | 5 / 0 | 3.0 s | 28.0 s | 9.3× |
| `convergence-model` | 9 | 9 / 0 | 4.3 s | 41.6 s | 9.7× |
| `copy` | 37 | 37 / 0 | 10.7 s | 75.2 s | 7.0× |
| `ephemeral-schema` | 4 | 4 / 0 | 1.7 s | 8.3 s | 4.9× |
| `event-lane-flush` | 31 | 31 / 0 | 6.7 s | 89.8 s | 13.4× |
| `event-outbox-append` | 14 | 14 / 0 | 4.0 s | 49.3 s | 12.3× |
| `flush-serialization` | 4 | 4 / 0 | 2.6 s | 23.3 s | 9.0× |
| `local-store` | 8 | 8 / 0 | 4.0 s | 40.6 s | 10.2× |
| `mutation-quarantine` | 11 | 11 / 0 | 5.0 s | 55.9 s | 11.2× |
| `overlay-state` | 36 | 36 / 0 | 13.7 s | 132.6 s | 9.7× |
| `pessimistic-flush` | 8 | 8 / 0 | 4.2 s | 45.1 s | 10.7× |
| `plpgsql-apply` | 44 | 26 / 18 | 13.0 s | 75.5 s | 5.8× |
| `rls-malformed-claim-arrays` | 14 | 14 / 0 | 1.5 s | 5.3 s | 3.5× |
| `sync-apply` | 3 | 3 / 0 | 1.6 s | 4.8 s | 3.0× |
| `sync-drizzle-executor` | 12 | 12 / 0 | 4.3 s | 21.3 s | 5.0× |
| `write-activation-runtime` | 5 | 5 / 0 | 3.2 s | 27.5 s | 8.6× |
| `write-unit-tag` | 2 | 2 / 0 | 2.5 s | 12.3 s | 4.9× |
| **total** | **332** | **313 / 19** | **117.3 s** | **881.6 s** | **7.5×** |

The spread is the interesting part. Files whose cost is dominated by ONE store boot land at 2–4×;
files that boot a store per test land at 9–13×. A pgrust store costs ~1.4 s to boot and ~0.35 s to
close where PGlite's costs ~0.2 s, and a suite that opens one per test pays that difference
directly. Nothing here is a query-throughput measurement — `copy` moves the most data of any file
and sits at 7.0×, below several files that move almost none.

## What the (A) list says about pgrust

Nineteen failures, two causes, and neither is about SQL semantics: pgrust computed a **different
answer** nowhere in 1987 tests. `funcapi exprType: node family T_NullIfExpr not ported` is a
missing arm in the port's expression-type walker, reached whenever a set-returning PL/pgSQL
function's result type has to be resolved through an expression containing `NULLIF` — which
pgxsinkit's generated apply function does, once, and so takes down seventeen tests that have
nothing else in common. `aclchk: compressed/external ACL varlena — detoast gap` is the same shape
of gap one layer down: an ACL array long enough to be TOASTed is not detoasted before it is read,
so a `REVOKE` against an inherited default-privileges grant cannot be evaluated. Both are ports in
progress reporting honestly rather than guessing, which is the right failure mode and makes them
cheap to place: each names its own file and node family.

What that leaves is a strong result for everything else the suite exercises — the local schema
generator, the overlay and journal machinery, the mutation runtime, conflict detection at the SQL
level, the event lane and outbox, RLS predicate handling, the Circuits read path's applier, COPY in
every type the serializer supports, the Drizzle executor over the wire, and `dumpDataDir`/
`loadDataDir` round trips through the seam's snapshot cache — 313 of 332 store-backed tests and
1968 of 1987 overall, with no test needing a pgrust-shaped exception. (What this lane does NOT
exercise is `live`: the suite's helpers never request the extension, so live queries and the
`LISTEN`/`NOTIFY` under them are still only covered by the factory scenario.) The remaining nineteen are one afternoon's work in
pgrust's own tree, not a design difference: port `T_NullIfExpr` in `funcapi`'s `exprType`, detoast
the ACL varlena, and this suite is green on both engines.

One thing worth recording that is not a failure: every pgrust boot logs `WARNING: regexp engines:
spencer only — RE2 was not linked into this build`. Nothing in pgxsinkit's suite asked for RE2, so
it cost nothing here, but a registry using `regex_engine=re2` would meet it immediately.

## Reproducing

```
bun run test:pgxsinkit-on-pgrust                 # the whole suite
bun run test:pgxsinkit-on-pgrust plpgsql-apply   # one file
PGXSINKIT_PGRUST_SERVER_LOG=1 …                  # the postmaster's own stderr
PGXSINKIT_DIR=/path/to/pgxsinkit …               # a checkout elsewhere
```
