# What the module links is a feature list: the first profile that leaves something out

- Date: 2026-09-16
- Runtime: bun 1.4.2 and node v26.8.2 on Linux 7.0.0-31-generic (x86_64, 8 logical cores)
- Engine: pgrust `53845b1675` on `spike/wasip1-threads` — one commit on top of `e5f4bd9e71`, the
  Binaryen-pass line of `2026-09-16-wasm-opt-pass.md`, upstream base `79ad992ede` (PostgreSQL 18.6)
- Baseline: `e5f4bd9e71`, published as `pgrust-assets/e5f4bd9e` — threads module 39 040 753 bytes
  (gzip -9 13 434 230), single-session 38 410 184 (13 519 294), both after `wasm-opt -Oz`
- Drivers: `wasm/wasm-build.sh` in the pgrust checkout (three release builds), its six node proof
  lanes, `bun run test:pgxsinkit-on-pgrust` and `bun run bench --suite rtt` here
- Release: `pgrust-assets/53845b16`

## 1. The mechanism

`seams_init` — pgrust's one registry — was a flat list of 353 path dependencies and 311
`init_seams()` calls. A subsystem was in the `postgres` binary because that crate depended on it and
called its init, and there was no way to say "not that one". Every wasm module this repo has ever
benchmarked therefore carried logical replication, parallel query, base backup, four non-btree access
methods and all 47 contribs, whatever the host could actually use.

The gate is Cargo's, and it is the whole of it:

1. the dependency becomes `optional = true`,
2. a feature turns it on,
3. the `init_seams()` call gets a `#[cfg(feature = ...)]`.

Feature off ⇒ the crate is **not in the link graph at all** ⇒ its seams are never installed. For a
contrib that means the named builtin library it registers with `dfmgr` is absent, so `LOAD` (and
`CREATE EXTENSION` behind it) refuses it with PostgreSQL's own "could not access file"; for a core
builtin it means fmgr's existing `NotPorted` stub answers instead, an error at call time.

90 dependencies are gated this way, behind **47 `contrib-*` features and 12 group features**
(`replication`, `parallel`, `backup`, `index-gin`, `index-gist`, `index-spgist`, `index-brin`,
`tsearch`, `geo`, `jsonpath`, `pgrcolumnar`, `plpgsql`), over 92 `cfg`-ed lines. `main_main` takes
`seams_init` with `default-features = false` and forwards its own `full` / `browser`; it is the only
crate in the graph that depends on `seams_init`, so nothing re-enables the defaults through feature
unification. `default = ["full"]` is exactly the dependency set and the init order that existed
before, and `wasm/wasm-build.sh`'s new `PGRUST_WASM_FEATURES` defaults to `full`.

## 2. The keep set

`browser` = **every group feature still on**, plus four contribs: `pgvector`, `pgvector_hnsw`,
`pg_trgm`, `pgcrypto`. That is all of it. 43 of the 47 contribs are gated off.

Nothing core is switched off yet, and the features say why in the manifest:

- **Tier A — `replication`, `parallel`, `backup`.** Declared, untested off. The postmaster touches
  these at BOOT, and a seam the boot path calls with nothing installed panics `seam not installed`
  (`crates/_support/seam_core`). Switching one off is a separate bite with a boot lane behind it.
- **Tier B — `index-*`, `tsearch`, `geo`, `jsonpath`, `pgrcolumnar`, `plpgsql`.** Reached only
  through fmgr/pg_am dispatch, so safe off by construction — but also on in this profile, because
  this bite is about proving the mechanism, not about picking what a browser can live without.

## 3. The exclusion proof

A feature that is merely *declared off* proves nothing: the crate can still be in the module because
some other crate in `main_main`'s graph depends on it. So before the link the script asks cargo which
`seams_init` features actually resolved (`cargo tree -f '{p}|{f}'`), maps them to the optional
dependencies they enable, and diffs that against the crates in the link graph. Verbatim, from the
`wasm32-wasip1-threads` build:

```
wasm-build: profile browser excludes 40 crates: amcheck auto_explain btree_gin btree_gist citext
  contrib_cube contrib_earthdistance contrib_lo contrib_seg dblink file_fdw fuzzystrmatch hstore
  injection_points intarray isn ltree pageinspect passwordcheck pg_buffercache pg_freespacemap
  pg_logicalinspect pg_overexplain pg_prewarm pg_stat_statements pg_surgery pg_visibility
  pg_walinspect pgoutput pgrowlocks pgstattuple postgres_fdw sslinfo tablefunc tcn
  test_custom_types test_decoding test_oat_hooks unaccent uuid_ossp
wasm-build: profile browser leaves 3 gated crates linked (another crate in the graph depends on
  them; their seams are still not installed):
    bloom <- amapi bloom_build indexam
    tsm_system_rows <- tablesample
    tsm_system_time <- tablesample
wasm-build: exclusion proof OK (no excluded crate is reachable in the link graph)
```

40 of the 43 genuinely leave. The 3 that do not are reported with the core crate that keeps them —
`amcheck`'s neighbour `bloom` is named directly by the access-method registry, and the two
tablesample methods by `tablesample` — and they are left exactly as they are. **Where a gate cannot
remove a crate, the feature is still declared** (it still stops `seams_init` installing the seams)
**and the crate stays**; no core code was restructured to make the number bigger. Counting the
transitive dependencies that leave with the 40, the package graph goes 922 → 878.

The `full` profile prints `excludes 0 crates (every gate on; nothing to prove)` and links exactly
what it always did.

## 4. Sizes

All four rows are after `wasm-opt -Oz` (Binaryen 132), the pass `2026-09-16-wasm-opt-pass.md` put in
the build:

| Module | features | .wasm raw | gzip -9 | vs `full` raw |
| --- | --- | --- | --- | --- |
| `postgres-threads.wasm` | full | 39 040 753 | 13 434 230 | — |
| `postgres-threads.wasm` | **browser** | **37 209 731** | **12 821 035** | −1 831 022 (−4.7%) |
| `postgres.wasm` | full | 38 410 184 | 13 519 294 | — |
| `postgres.wasm` | **browser** | **36 584 849** | **12 908 762** | −1 825 335 (−4.8%) |

sha256 of the two shipped (browser) modules:

```
439df68ba2892023f6a3216d34956e0c428935a49dbe5c46135785dcf94c0a2d  postgres-threads.wasm
3fb1ad313c5f49ddbded04d9174cb2e281eefa1da7af4c9da9b03efc466d8b28  postgres.wasm
```

**The gates cost nothing when they are all on.** The `full` threads row is not the baseline number
carried forward — it is a third release build, made with the gates in place, and it came out at
39 040 753 raw and 13 434 230 gzipped: the same two numbers, to the byte, as the module before this
commit. (Its sha differs — a `[features]` table changes the crates' metadata hashes and so their
symbol names — but not one byte of size.) Before the Binaryen pass the same comparison is
53 414 445 → 50 830 789 raw, so the pass keeps about 70% of the saving.

Forty contribs are worth 1.8 MB of a 37 MB module. That is the honest answer to "how much of this
module is the extensions": **about five percent**, and it is the least interesting number here. The
interesting one is what a `browser` profile is worth once Tier A can be switched off, which this bite
deliberately did not attempt.

## 5. Lanes

All six on the `browser` threads module, `--fs broker`:

| Lane | Result | The decisive line |
| --- | --- | --- |
| 1. postmaster | PASS | `VERDICT: postmaster-node PASS fs=broker` |
| 2. tablespace over a mount | PASS | `VERDICT: threads-node PASS fs=broker` |
| 3. in-place tablespace | PASS | `VERDICT: threads-node PASS fs=broker` |
| 4. `tablespace-host-proof.mjs` | PASS | `VERDICT: tablespace-host-proof PASS` |
| 5. `sab-pipe-host-gate.test.mjs` | PASS | `pass 6, fail 0` |
| 6a. `browser-profile-proof.sql` | PASS | `VERDICT: threads-node PASS fs=broker` |
| 6b. `browser-profile-refusal.sql` | refusal, as designed | `ERROR: could not access file "dblink": No such file or directory` |

Lane 6 is new and is two files because the runner records any `ErrorResponse` as a lane failure.
6a is the keep set: `LOAD 'pg_trgm'`, `LOAD 'pgcrypto'` and `LOAD 'vector'` (pgvector registers under
its extension name) all answer, and a GIN index over a jsonb column is built and queried — `index-gin`
is a group feature and it is on, so putting the access methods behind features did not cost the
browser an index method. 6b is one statement, `LOAD 'dblink'`, and its verdict is FAIL on purpose;
the evidence is the error text, SQLSTATE 58P01.

**`LOAD` and not `CREATE EXTENSION`**, which is worth recording because the brief asked for the
latter. The seeded image (`wasm/assets/vfs.img`) has a datadir and `share/timezone` and nothing else
— there is no `share/extension` directory in it at all — so `CREATE EXTENSION pg_trgm` fails with
`extension "pg_trgm" is not available` (0A000) on **every** profile, the `full` one included, and
distinguishes nothing. `LOAD 'name'` goes straight to the `dfmgr` named-builtin-library lookup, which
is precisely the registration a feature gate removes, and it comes with a control:

| statement | `full` module (`e5f4bd9e71`) | `browser` module |
| --- | --- | --- |
| `LOAD 'pg_trgm'` | `LOAD` | `LOAD` |
| `LOAD 'pgcrypto'` | `LOAD` | `LOAD` |
| `LOAD 'vector'` | `LOAD` | `LOAD` |
| `LOAD 'dblink'` | `LOAD` | `ERROR: could not access file "dblink": No such file or directory` |
| `LOAD 'hstore'` | `LOAD` | `ERROR: could not access file "hstore": No such file or directory` |

That control is the whole proof: the same statement, the same image, two modules, one commit apart.

## 6. The Suite, and the single-session smoke

`bun run test:pgxsinkit-on-pgrust` against pgxsinkit `develop`, on the `browser` threads module:
**2073 pass, 0 fail** in 473.3 s — the same 2073 as the baseline in
`2026-09-07-pgxsinkit-unit-suite-on-pgrust.md` and every release since. Nothing in that suite names a
contrib the profile removed.

`bun run bench --no-build --suite rtt --iterations 1 --configurations pgrust-memory` on the
single-session module: 12 of 12 tests answered, exit 0.

## 7. What this note does not claim

- **No speed measurement.** The pass touches no hot code — it decides which crates are linked, not
  what any of them do — so no Speedtest, no Concurrency Suite, no RTT comparison. The RTT run above
  is a smoke that the module boots and answers, on one iteration; it is not a number to compare with
  anything.
- **Nothing about Tier A.** `replication`, `parallel` and `backup` are declared and ON. Whether the
  boot path survives without them is unmeasured, and the manifest says so where someone switching one
  off will read it.
- **Not a claim that 4.7% is what feature gates are worth.** It is what *contribs* are worth. The
  subsystems that would move the number are the ones this bite left on.
- **Nothing about Safari, iOS or the browser at all.** Every number here is node and bun on Linux;
  the browser lanes were not re-run, and `2026-09-08-webkit-memory-diet.md` §8 still describes what a
  Linux number does not say about a phone.
- **No claim that the excluded code is unreachable, only that it is absent.** The three gated crates
  that stay (`bloom`, `tsm_system_rows`, `tsm_system_time`) are still in the module and still
  reachable through the access-method and tablesample registries; only their `seams_init`
  registration is gone.

## 8. Incidental, and worth knowing

`bun run sync:pgrust` re-read the pre-release store bundle from the pgxsinkit checkout and it had
moved underneath this repo: `feat/repacked-sync-broker@537835b4` → `develop@06ba3690`, 1 007 941 →
1 009 593 bytes. That is the bundle the four broker columns load, it is what the Suite above ran
against, and it is what `pgrust-assets/53845b16` carries. `src/vendor/pgrust/SOURCE.md` records it.

`pgrust:bundle` has no flag for the feature profile — its flags cover the cargo profile, the targets
and the toolchain — so `PGRUST_WASM_FEATURES=browser` was added to the release's `NOTES.md` build
recipe by hand before publishing, rather than by adding a flag. Omitting that variable reproduces a
different, larger binary, so it belongs in the recipe and not in a footnote.
