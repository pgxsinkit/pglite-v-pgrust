# The copy finding 0001 let go: sharing the portal's source text takes 31% off the Suite

- Date: 2026-09-18
- Runtime: bun 1.4.2 and node v26.9.0 on Linux 7.0.0-31-generic (x86_64, 8 logical cores); the
  browser lanes in headless Chromium 149.0.7827.55
- Engine: pgrust `31b5259d22` on `spike/wasip1-threads` — three commits on top of `53845b1675`, the
  browser-profile line of `2026-09-16-browser-profile.md`, upstream base `79ad992ede`
  (PostgreSQL 18.6)
- Baseline: `53845b1675`, published as `pgrust-assets/53845b16` — threads module 37 209 731 bytes,
  single-session 36 584 849, both `browser` profile after `wasm-opt -Oz`
- Drivers: `wasm/wasm-build.sh` in the pgrust checkout (two release builds), its six node proof
  lanes, `bun run test:pgxsinkit-on-pgrust`, `bun run bench --suite speedtest` and
  `tmp/agents/diet/chromium-check.ts` here
- Release: `pgrust-assets/31b5259d`

## 1. Whose change this is

The three commits are **malisper's**, the pgrust maintainer's, opened against this fork's spike
branch as [pgxsinkit/pgrust#1](https://github.com/pgxsinkit/pgrust/pull/1) and taken here by
rebase, unmodified, with his authorship intact:

```
31b5259d22 portalmem: trim the new doc comments to keep the crate under its comment-ratchet line
5a811a9766 portalmem: keep the source-text lifetime extension inside PortalDefineQuerySharedText
d50769a1e4 portalmem: share the caller's source text in exec_simple_query instead of copying the
           whole message per statement
```

Eight files, +54/−23. `PortalData.sourceText` becomes `Option<&'mcx str>` instead of an owned
`PgString`; `PortalDefineQuery` keeps copying for its four other callers (`PREPARE`, the
extended-query path, `PerformCursorOpen`, SPI), whose text genuinely outlives the message; and a new
`unsafe fn PortalDefineQuerySharedText` shares the caller's pointer — used by exactly one caller,
`exec_simple_query`, where the message is the `MessageContext` buffer and provably outlives the
unnamed portal. That is what C does (`portal->sourceText = sourceText`), and the safety contract is
written out at both ends.

The same change is open upstream. It will drop out of this line at the next squash rebase onto
upstream, which is the intended end state.

## 2. The correction to finding 0001

[`docs/findings/0001-pgrust-multi-statement-memory.md`](../findings/0001-pgrust-multi-statement-memory.md)
looked straight at this copy and let it go. Its parenthesis reads:

> (A first attempt blamed `PortalDefineQuery`'s `PgString::from_str_in(sourceText, mcx)`; that copy
> goes to `TopPortalContext` and is freed at `PortalDrop`, so removing it moved the failure from
> statement 2 047 to 2 048.)

Every word of that is true and the conclusion drawn from it was wrong. 0001 was hunting a hard
wasm32 failure — a 4 GiB linear-memory ceiling hit at statement 2 047 — so it scored each candidate
copy by **one statement of headroom**. This copy bought one statement, so it was dropped and the
parse-analyze copy (which bought all of them) was fixed instead. The test was the right test for the
question 0001 was asking.

What 0001 never did was **time** it. A copy that is freed promptly still costs its memcpy, and this
one runs once per statement with the whole message as its argument: on Speedtest script 2 that is
2 MB copied 25 003 times, about 50 GB of memcpy that never appears as a memory number because every
byte of it is handed back immediately. Finding 0001 measured the right thing for its own symptom and
never asked what the copy cost in time. This note is that question, answered: **31% of the Suite**.

0001 stays as written. It is the dated record of what was found on 2026-08-29 against `438c8c420b`,
and it was not wrong about memory.

## 3. The gate

Everything below ran on `31b5259d22` with both modules rebuilt from it at
`PGRUST_WASM_FEATURES=browser`, `wasm-release`, `wasm-opt -Oz` (Binaryen 132).

| Lane | Result |
| --- | --- |
| `cargo build -p main_main` | clean |
| `cargo test -p portalmem -p pquery -p portalcmds -p pg_proc -p postgres` | **111 pass, 0 fail** (portalmem 30, postgres 49, pquery 15, portalcmds 11 + 1 ignored, pg_proc 6) |
| `--dispatch postmaster --fs broker` | `VERDICT: postmaster-node PASS fs=broker` — delta 5 files / 139 636 bytes into the one store |
| `--dispatch stdio-wire-threaded … --mount /pgeph=memory --sql wasm/tablespace-proof.sql` | `VERDICT: threads-node PASS fs=broker` |
| `… --mount /pgdata/pg_tblspc=memory --sql wasm/tablespace-inplace-proof.sql` | `VERDICT: threads-node PASS fs=broker` |
| `node wasm/tablespace-host-proof.mjs` | `VERDICT: tablespace-host-proof PASS` |
| `node --test wasm/test/sab-pipe-host-gate.test.mjs` | `pass 6, fail 0` |
| `--sql wasm/browser-profile-proof.sql` | `VERDICT: threads-node PASS fs=broker` |
| `bun run test:pgxsinkit-on-pgrust` | **2073 pass, 0 fail** in 370.6 s — the same 2073 as the 0.3 rebase |
| `bun run bench --suite rtt --configurations pgrust-memory` (single-session module) | 12 of 12 |

Modules, both `browser` profile after `-Oz`:

| Module | raw | vs baseline | gzip -9 | vs baseline | sha256 |
| --- | ---: | ---: | ---: | ---: | --- |
| `postgres-threads.wasm` | 37 210 023 | +292 B | 12 820 994 | −41 B | `7737d8b3ab8360f73e960b124adefe51530d4524e02837cca4604489bf4280d9` |
| `postgres.wasm` | 36 585 135 | +286 B | 12 909 074 | +312 B | `b677b7cd969de2c9c4e7a058b34b0ec474d05c5de3e1eac29c9944d5a08981b9` |

Three hundred bytes each. The change is not a size change.

## 4. Lifetime smoke: does the shared pointer survive what it must?

The one thing a shared pointer can get wrong is outliving its buffer, and a benchmark will not
notice. Three cases, run through the bun engine (`createPgrustPglite`, memory backend) on the new
module — scratch, not committed:

| Case | Result |
| --- | --- |
| (a) `SELECT 1; SELECT 1/0; SELECT 2;` in one message, then a later `SELECT 3` | the error raised is `division by zero`; the next message answers `3`. The aborted portal's text is released by `error_recovery` before `MessageContext` resets, as the contract says. |
| (b) `BEGIN; DECLARE c CURSOR WITH HOLD FOR SELECT g FROM generate_series(1,5) g; COMMIT;`, then a **later** message `FETCH ALL FROM c` | 5 rows, `[1,2,3,4,5]`; `SELECT statement FROM pg_cursors` returns the DECLARE message text intact. The held portal is defined by `PerformCursorOpen`, which is still on the **copying** `PortalDefineQuery` — it owns its text and does not point into the freed message. |
| (c) one message of 5 000 `INSERT` statements, then `SELECT count(*)` | `count(*) = 5000` in 524 ms |

Case (b) is the one that would have shown a dangling pointer as garbage or a crash on the next
message. It shows the DECLARE text.

## 5. Speedtest: before and after, interleaved

`bun run bench --suite speedtest --configurations pglite-memory,pgrust-postmaster-opfs-repacked-relaxed
--baseline pglite-memory`, headless Chromium, the published `53845b16` threads module against the new
one **in the same dist, swapped between runs**: BEFORE, AFTER, BEFORE, AFTER, each started with the
1-minute load at 1.91–1.96 on the same box. (A first AFTER pair taken straight after the 6-minute
pgxsinkit suite is discarded: its PGlite control was 10% slow, so the machine, not the module, was
being measured. The interleaved BEFORE runs reproduce the morning's pre-rebuild pair — pgrust Suite
totals 35 059 / 35 097 ms against 34 370 / 35 504 — which is why the interleaved numbers are the ones
published here.)

pgrust Postmaster OPFS repacked (relaxed), both runs each, with the PGlite Memory control beside it:

| Benchmark | BEFORE 1 | BEFORE 2 | AFTER 1 | AFTER 2 | speedup | PGlite B1/B2 | PGlite A1/A2 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1: 1000 INSERTs | 1174.2 | 1198.2 | 1279.2 | 1372.7 | 0.92× | 57.7 / 61.3 | 67.6 / 68.6 |
| 2: 25000 INSERTs in a transaction | 5201.1 | 5241.6 | **1997.4** | **1894.6** | **2.75×** | 579.1 / 602.8 | 645.2 / 681.7 |
| 2.1: 25000 INSERTs in single statement | 524.7 | 532.4 | 516.1 | 510.9 | 1.03× | 142.7 / 144.8 | 146.6 / 142.0 |
| 3: 25000 INSERTs into an indexed table | 6134.5 | 6285.6 | **3433.3** | **3484.1** | **1.79×** | 754.9 / 785.2 | 787.9 / 787.7 |
| 3.1: 25000 INSERTs indexed, single statement | 701.8 | 706.0 | 712.1 | 716.7 | 0.99× | 183.3 / 168.5 | 172.7 / 171.5 |
| 4: 100 SELECTs without an index | 471.4 | 443.4 | 495.1 | 454.2 | 0.98× | 323.4 / 344.6 | 318.7 / 324.9 |
| 5: 100 SELECTs on a string comparison | 776.8 | 779.2 | 800.1 | 824.0 | 0.97× | 821.1 / 856.8 | 833.3 / 811.7 |
| 6: Creating an index | 156.8 | 162.2 | 155.2 | 159.5 | 1.01× | 29.2 / 33.3 | 30.7 / 32.3 |
| 7: 5000 SELECTs with an index | 1241.9 | 1292.0 | 1172.6 | 1157.2 | 1.07× | 474.2 / 497.4 | 523.5 / 526.7 |
| 8: 1000 UPDATEs without an index | 276.6 | 277.4 | 276.5 | 269.4 | 1.03× | 162.3 / 191.6 | 180.9 / 183.4 |
| 9: 25000 UPDATEs with an index | 5670.9 | 5476.8 | **3951.6** | **3943.3** | **1.39×** | 1388.7 / 1428.1 | 1474.1 / 1468.6 |
| 10: 25000 text UPDATEs with an index | 7871.8 | 7859.8 | **5237.8** | **5172.4** | **1.52×** | 1759.2 / 1745.7 | 1833.0 / 1803.6 |
| 11: INSERTs from a SELECT | 2183.0 | 2181.3 | 2219.8 | 2185.8 | 1.00× | 289.5 / 286.0 | 312.6 / 303.9 |
| 12: DELETE without an index | 57.4 | 56.4 | 58.0 | 67.8 | 0.97× | 24.3 / 24.4 | 27.7 / 24.5 |
| 13: DELETE with an index | 149.9 | 148.8 | 148.8 | 152.1 | 1.00× | 33.2 / 34.9 | 32.5 / 33.2 |
| 14: A big INSERT after a big DELETE | 905.8 | 887.5 | 906.4 | 896.0 | 0.99× | 172.0 / 179.6 | 177.2 / 174.6 |
| 15: A big DELETE then many small INSERTs | 1529.7 | 1539.4 | **721.7** | **700.9** | **2.18×** | 252.2 / 252.4 | 260.3 / 259.1 |
| 16: DROP TABLE | 30.7 | 28.6 | 31.4 | 45.9 | 0.91× | 4.8 / 4.9 | 4.9 / 4.7 |
| **Suite total** | **35 059** | **35 097** | **24 113** | **24 007** | **1.46×** | 7452 / 7642 | 7829 / 7803 |

Speedup is the better BEFORE run over the better AFTER run.

The five rows that move — 2, 3, 9, 10, 15 — are exactly the five scripts finding 0001 tabulated as
multi-statement messages of 12 000–25 000 statements. Nothing else moves by more than the PGlite
control does, which is the shape the change predicts: one memcpy of the message removed per
statement, so the win is proportional to (statements × message bytes) and zero everywhere else.

Two rows want naming rather than averaging away. **Row 1 is 9% slower in both AFTER runs**, and it
was slower in the discarded pair too. It is 1 000 single-statement messages, the case where the
change removes work, so there is no mechanism here — but two consistent runs is not noise either.
Row 1's own run-to-run spread on an unchanged module was 7.6% in `2026-09-16-wasm-opt-pass.md`, which
covers it; this note records the observation and does not claim a regression. **Row 16** (DROP TABLE,
a 30 ms cell) swings 31.4 → 45.9 between the two AFTER runs and is below the resolution of this lane.

The PGlite control is 3–5% *slower* in the AFTER runs than the BEFORE runs, so if the interleaving
has any residual bias it is against the new module, not for it.

## 6. Memory: unchanged, as expected

The controlled single-column lane of `2026-09-08-webkit-memory-diet.md` §3, on the new threads
module:

```
DIST=$PWD/dist bun tmp/agents/diet/chromium-check.ts \
  "?configurations=pgrust-postmaster-opfs-repacked-relaxed&postmasterTuning=pool:8,max_stack_depth=2048" \
  speedtest
```

| Module | wasm memory | Suite total |
| --- | --- | --- |
| `e5f4bd9e71` `-Oz`, last measurement in this lane (2026-09-16) | 276 365 312 B = **263.6 MiB** | 51 263 ms |
| `31b5259d22`, this note | 273 940 480 B = **261.3 MiB** | **33 004 ms** |

Memory is 2.3 MiB lower, which is within what this number moves between runs and is not claimed as a
win: the change removes an allocation that was freed at the end of every message anyway, so the peak
it contributes to is a *within-message* peak, and this lane reports
`WebAssembly.Memory.buffer.byteLength` at the end. The Suite total in this lane spans two engine
commits — nothing has run it since `e5f4bd9e71`, so the browser-profile change of `53845b1675` is
inside that 18-second difference. §5 is the controlled comparison; this row is the memory claim.

## 7. What this note does not claim

- **Nothing about Safari or phones.** Every browser number here is headless Chromium on Linux
  x86_64. iOS and the WebKit ceiling were not re-measured; `2026-09-08-webkit-memory-diet.md` §8
  still governs what a Chromium number does not say about them.
- **Not that the other thirteen columns moved.** Two were measured — the postmaster broker column and
  the PGlite Memory control — plus a 12-of-12 RTT smoke on the single-session module.
- **Not a claim about the memory ceiling.** Finding 0001's ceiling was fixed by the parse-analyze
  borrow and stays fixed; this change is orthogonal to it and buys one statement of headroom, exactly
  as 0001 measured.
- **Not a correctness proof beyond the gate.** 111 native tests in the touched crates, six proof
  lanes, 2073 suite tests and three lifetime cases. The `unsafe` here is a lifetime contract that no
  test can discharge in general — it rests on the reasoning in the commit, which matches C's.
