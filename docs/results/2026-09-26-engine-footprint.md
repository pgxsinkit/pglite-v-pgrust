# Six engine commits and a re-collected profile: pgrust's threads module 10% faster on the Speedtest, on the desktop and on a Galaxy S22+

- Date: 2026-09-26
- pgrust: `spike/wasip1-threads` at `efe65be6d4`: the absent-fork cache and the WASI watchdog change
  (`ea6c68b2e4`, `be79c78758`; [their note](2026-09-26-absent-fork-cache.md)) and six engine commits
  on top, `086670f362..efe65be6d4`; the profile re-collected on that source is `95d4750995`
- Modules, all `postgres-threads.wasm` (`wasm32-wasip1-threads`):

  | arm | module | built from | profile | raw (B) | gzip (B) | functions | sha256 |
  | --- | --- | --- | --- | ---: | ---: | ---: | --- |
  | C | `c499994c` (the page's default, release `e2e7a2f9`) | `e2e7a2f9cd` | collected on `e2e7a2f9cd` | 39 759 752 | 14 017 177 | 37 186 | `c499994c…` |
  | N | release `efe65be6` | `efe65be6d4` | none | 36 668 521 | 12 703 549 | 33 601 | `62a71e31…` |
  | P | release `95d47509` | `efe65be6d4` (+ `95d4750995`, the profile only) | re-collected on `efe65be6d4` | 33 974 686 | 12 009 678 | 37 263 | `dd1d4780…` |

- Bench: `5a29882` carries N and P as `?pgrustModule=efe65be6` and `?pgrustModule=95d47509`; the
  page's default stays pinned to release `e2e7a2f9` (C)
- Desktop: headless Chromium in the bench's persistent context (`bun run bench`'s lane)
- Phone: Samsung Galaxy S22+ (SM-S9060, Snapdragon 8 Gen 1), Android 16, Chrome 153.0.8010.53, the
  published page at `5a29882`

**Read the arms carefully: N against C is not "the engine commits" alone.** C is the module the page
has run since the [profile-guided build](2026-09-26-wasm-pgo.md): `e2e7a2f9cd`'s source, built with
a profile. N is `efe65be6d4`'s source, which also carries the two absent-fork commits, built with
**no** profile. So N against C is the engine commits plus the absent-fork cache minus PGO; N comes out
slower on the desktop, where the first profile had been worth 16%. P against N is PGO on the new
code, and P against C is the whole change the page would take: new code, new profile.

**Findings.**

1. **P, the new code with its own profile, is 10% faster than the page's default on both machines.**
   The Speedtest's pgrust total is 0.90× C on the desktop and 0.90× on the Galaxy (11 546–11 645 ms
   against 12 775–13 102, the ranges apart). pgrust moves from 1.79× PGlite Memory to 1.61× on the
   phone. The Prepared Suite, one Run each on the phone, is 0.87×.
2. **The profile is worth 10% on the phone and 17% on the desktop.** P is 0.90× N on the Galaxy and
   0.83× on the desktop; without a profile the new code (N) is level with C on the phone (1.00×) and
   8% slower on the desktop.
3. **The Warm-up is a third shorter** on both new modules, on both machines (phone means: 838 and 847
   against 1 258 ms; desktop: about 540 against 840 ms).
4. **P and N cost the phone less CPU.** Chrome's CPU time per Run falls from 55.8 s (C) to 48.5 (P) and
   46.6 (N), nearly all of it in the first five seconds of the pgrust column, where the Engine opens
   and the Warm-up runs.
5. **P carries the absent-fork cache**, so its guest opens are 113–114 a Suite as in
   [that note](2026-09-26-absent-fork-cache.md), and the Session backend's blocked time is 14% lower.

## 1. The six engine commits, as their messages report them natively

Each was measured natively on the Speedtest's warm rows 7, 9, 1 and 2 (backend CPU µs per
statement, eight interleaved processes per arm, medians) against the commit before it, and with
callgrind. What each one takes out of every statement is a copy, a dispatch or a call that C does not
make:

| commit | what it changes | native µs per statement, rows 7 / 9 / 1 / 2 | callgrind |
| --- | --- | --- | --- |
| `086670f362` execmain | every `PlanStateNode` variant boxed, so a plan-state node moves as 24 bytes instead of 1 000 (about 13 KB of memcpy in every `ExecutorStart`) | 74.68 → 73.62, 57.81 → 56.86, 16.74 → 16.50, 16.19 → 16.15 (−1.4, −1.6, −1.4, −0.2%) | instructions −0.9 / −1.2 / −2.1%, D1 misses −8 / −14 / −23% (rows 7 / 9 / 1) |
| `54fff541de` pathnodes | base and upper rels filled in their arena slot, the planner arenas sized for a small statement | 73.62 → 72.65, 56.86 → 57.03, 16.50 → 16.41, 16.15 → 16.03: within noise | instructions −1.0% on row 7 (planning −2.3%), D1 misses −6% (row 7), −4% (row 9) |
| `3b927278d4` nbtree | the insert path's scan key filled in place (two 2 336-byte copies an index insert), `_bt_first`'s start keys not zero-filled (a 2 304-byte memset every index scan) | row 9 57.03 → 55.72 (−2.3%), row 7 72.65 → 72.53, rows 1 and 2 level | instructions −1.1% (row 7), −2.2% (row 9) |
| `5350cfcf38` vendor | allocator-api2 0.2.21 vendored with `RawVec`'s growth path out of line, as std keeps it: every push and reserve site had carried the whole growth path inline | row 7 72.53 → 67.95 (−6.3%), row 9 55.72 → 52.05 (−6.6%), the ranges apart; rows 1 and 2 −2.1% and −2.5% | 2–3% more instructions, but hot code −5.6%, I-cache misses −4%, indirect mispredictions −10 to −13%; native `.text` 43.2 → 39.9 MB |
| `4cc1f206c4` mcx | only the bump arms of the allocator dispatch inlined at allocation sites; the other four backends through one out-of-line call | row 7 67.95 → 66.48 (−2.2%), row 2 15.90 → 15.54 (−2.3%), rows 9 and 1 level | indirect mispredictions −6 / −13 / −12%, instructions −1.2% (row 7); `.text` 39.85 → 39.52 MB |
| `efe65be6d4` stack_depth_core | `stack_is_too_deep` inlined natively (143 checks a statement on row 7); out of line on wasm, where inlining would force a shadow-stack frame into every caller | 66.48 → 66.17, 52.02 → 51.57, 16.18 → 16.12, 15.54 → 15.62: under 1% | — |

Together, natively: row 7 74.68 → 66.17 µs a statement (−11%), row 9 57.81 → 51.57 (−11%), a little
over half of it from the allocator-api2 change. On wasm the last commit changes nothing, since the
check stays out of line there.

## 2. The profile, re-collected

The committed profile had been collected at `e2e7a2f9cd`. The allocator-api2 commit changes the
control flow of every function that pushes or reserves, so `95d4750995` replaces it with one trained
the same way on `efe65be6d4`'s source: the instrumented module (`PGRUST_WASM_PGO=generate`, browser
features, release settings, no Binaryen; 91 426 070 B) ran `pgo/train.sql` through this repo's node
postmaster lane, every statement its own simple query, 51 556 statements in 27.2 s, and the
postmaster's own `exit(0)` dumped the profile into the store. 13 712 784-byte `.profraw`; the indexed
profile is 22 722 184 B (2 128 338 B compressed), 66 535 function records, 9 120 executed (13.7%).
The use build misses 21 spill-set functions and reports no hash mismatch.

## 3. The desktop A/B

Headless Chromium, persistent context, the Speedtest on
`pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed`, only
`dist/pgrust/postgres-threads.wasm` swapped between Runs, in the order C N P P N C, every Run behind a
1-minute load under 2.5 and no compiler running. PGlite OPFS control 8 352–8 573 ms.

| arm | pgrust Suite (ms) | ÷ C (means) | Warm-up (ms) |
| --- | --- | ---: | --- |
| C `c499994c` | 10 102.2 / 9 814.6 | — | 798.0 / 881.2 |
| N `efe65be6` (no profile) | 10 781.9 / 10 802.5 | 1.08× | 532.4 / 546.8 |
| P `95d47509` (profile re-collected) | 8 948.7 / 8 901.5 | 0.90× | 515.6 / 572.2 |

P is 0.83× N: the profile is worth 17% on the new code, as it was worth 16% on the old. The ranges of
all three are apart. The Warm-up, which the first profile-guided build had made 20–35% slower, is a
third shorter on both new modules.

The gate, on both modules: the six pgrust node lanes PASS (`sab-pipe` 6/0), the leak probe 0.0 B per
statement on all 8 paths, the lifetime smoke PASS, wasm memory 256.0 MiB; pgxsinkit `f4777b4`'s unit
suite on P 2 100 passed, 0 failed, in 375.5 s.

## 4. The Galaxy A/B

The published page at bench `5a29882`, the Speedtest on
`pglite-memory,pgrust-postmaster-opfs-repacked-relaxed` with `?brokerStats=1`, one fresh tab per Run,
every arm on the default 200 µs broker spin: **C** the page's default, **N** `&pgrustModule=efe65be6`,
**P** `&pgrustModule=95d47509`, in the order C N P, P N C, C N P; then the Prepared Suite on the same
two columns without `brokerStats`, C then P. Before every click the driver refused the Run unless the
environment line said `broker spin: 200 µs`, N's and P's `pgrust module: <id> (alternate)` with
their own id and C's no `pgrust module:` entry, the header had the `pgrust broker spin` row, and a
no-store `HEAD` of the arm's module and of both alternates answered 200. Every Run passed. The driver
is the one of [the broker-spin note](2026-09-26-phone-broker-spin.md)'s §8: no key events, the screen
dimmed to 1 for the session (the owner's 0, automatic, restored after), `stay_on_while_plugged_in`
left at 7, wakefulness read every 5 s.

**Conditions.** The gate was thermal status 0, the battery at or below 33.0 °C and every CPU cluster
at its hardware maximum, 15-s polls, at most 15 minutes. It cleared in 0–1 s before every Run: the
battery was 26.3–28.2 °C before the click and 27.3–28.5 °C after (AP 34.3–41.0 °C, skin
28.6–30.4 °C after). No Run hit the hard cap; a one-step cap came and went inside the pgrust column
of r3-C and of the Prepared C Run, and nowhere else. The phone stayed awake and unlocked, and every
Run was visible from click to completion. **The first Run of each arm loaded its module cold**: 215,
137 and 149 s from click to completion for r1-C, r1-N and r1-P, against 27–32 s for the others,
with Chrome averaging half a core: waiting on the network for the page's assets and a 34–40 MB
module. Their cells are timed inside the worker
and are in line with the same arm's other Runs; they are left out of the CPU figures.

### Per Run

| Run | arm | pgrust total (ms) | PGlite Memory total (ms) | pgrust ÷ PGlite | Warm-up (ms) | row 1 | row 2 | row 7 | row 9 | row 11 | row 14 | Session backend blocked ms | Chrome CPU-s | caps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1-C | C | 12 774.9 | 7 205.1 | 1.77× | 1 258.6 | 189 | 1 569 | 895 | 2 768 | 349 | 312 | 1 300.6 | (cold) | none |
| r1-N | N | 12 970.3 | 7 037.3 | 1.84× | 793.3 | 158 | 1 014 | 937 | 2 914 | 418 | 271 | 1 080.9 | (cold) | none |
| r1-P | P | 11 645.4 | 7 418.8 | 1.57× | 882.0 | 179 | 1 116 | 901 | 2 523 | 304 | 243 | 1 101.5 | (cold) | none |
| r2-P | P | 11 598.8 | 7 152.4 | 1.62× | 751.9 | 170 | 1 241 | 838 | 2 555 | 314 | 234 | 1 179.3 | 49.11 | none |
| r2-N | N | 13 094.2 | 7 092.7 | 1.85× | 844.7 | 187 | 930 | 931 | 2 902 | 400 | 362 | 1 130.4 | 46.78 | none |
| r2-C | C | 12 803.0 | 7 331.2 | 1.75× | 1 407.9 | 198 | 1 363 | 912 | 2 878 | 390 | 297 | 1 277.0 | 55.88 | none |
| r3-C | C | 13 102.3 | 7 061.2 | 1.86× | 1 108.8 | 241 | 1 496 | 916 | 2 914 | 326 | 292 | 1 313.2 | 55.76 | step |
| r3-N | N | 12 695.9 | 7 422.5 | 1.71× | 903.5 | 117 | 886 | 971 | 2 854 | 415 | 274 | 1 053.0 | 46.50 | none |
| r3-P | P | 11 545.7 | 7 023.2 | 1.64× | 881.0 | 207 | 1 098 | 855 | 2 494 | 313 | 255 | 1 076.4 | 47.87 | none |

### Per arm (mean, range; ratios on the means)

| row | C | N | P | N ÷ C | P ÷ N | P ÷ C |
| --- | --- | --- | --- | ---: | ---: | ---: |
| **Suite** | 12 893 (12 775–13 102) | 12 920 (12 696–13 094) | 11 597 (11 546–11 645) | 1.00× | **0.90×** | **0.90×** |
| Warm-up | 1 258 (1 109–1 408) | 847 (793–904) | 838 (752–882) | 0.67× | 0.99× | 0.67× |
| 1: 1000 INSERTs | 209 (189–241) | 154 (117–187) | 185 (170–207) | 0.74× | 1.20× | 0.88× |
| 2: 25000 INSERTs in a transaction | 1 476 (1 363–1 570) | 943 (886–1 014) | 1 151 (1 098–1 241) | 0.64× | 1.22× | 0.78× |
| 3: 25000 INSERTs into an indexed table | 1 202 (1 164–1 277) | 1 252 (1 212–1 330) | 1 077 (1 066–1 097) | 1.04× | 0.86× | 0.90× |
| 4: 100 SELECTs without an index | 338 (326–357) | 464 (450–472) | 325 (299–351) | 1.37× | 0.70× | 0.96× |
| 7: 5000 SELECTs with an index | 908 (895–916) | 946 (931–971) | 865 (839–901) | 1.04× | 0.91× | 0.95× |
| 8: 1000 UPDATEs without an index | 181 (174–192) | 261 (249–268) | 192 (173–202) | 1.44× | 0.74× | 1.06× |
| 9: 25000 UPDATEs with an index | 2 853 (2 768–2 914) | 2 890 (2 854–2 914) | 2 524 (2 494–2 555) | 1.01× | 0.87× | 0.88× |
| 10: 25000 text UPDATEs with an index | 3 304 (3 244–3 400) | 3 371 (3 346–3 407) | 3 015 (2 987–3 063) | 1.02× | 0.89× | 0.91× |
| 11: INSERTs from a SELECT | 355 (326–390) | 411 (400–418) | 311 (304–314) | 1.16× | 0.76× | 0.87× |
| 14: A big INSERT after a big DELETE | 300 (292–312) | 302 (271–362) | 244 (234–255) | 1.01× | 0.81× | 0.81× |
| Session backend blocked ms | 1 297 (1 277–1 313) | 1 088 (1 053–1 130) | 1 119 (1 076–1 179) | 0.84× | 1.03× | 0.86× |
| guest opens (18 rows) | 874 | 113–114 | 113–114 | | | |
| Chrome CPU-s per Run (r2, r3) | 55.88, 55.76 | 46.78, 46.50 | 49.11, 47.87 | 0.83× | 1.04× | 0.87× |
| PGlite Memory total (the control) | 7 199 (7 061–7 331) | 7 184 (7 037–7 423) | 7 198 (7 023–7 419) | 1.00× | 1.00× | 1.00× |

### The Prepared Suite, one Run each

| Benchmark | C pgrust (ms) | P pgrust (ms) | P ÷ C |
| --- | ---: | ---: | ---: |
| Warm-up | 1 285.5 | 1 048.5 | 0.82× |
| 1: 1000 INSERTs (prepared) | 134.4 | 154.5 | 1.15× |
| 2: 25000 INSERTs in a transaction (prepared) | 1 352.7 | 912.1 | 0.67× |
| 3: 25000 INSERTs into an indexed table (prepared) | 918.7 | 820.4 | 0.89× |
| 7: 5000 SELECTs with an index (prepared) | 496.5 | 419.8 | 0.85× |
| 8: 1000 UPDATEs without an index (prepared) | 133.7 | 134.5 | 1.01× |
| 9: 25000 UPDATEs with an index (prepared) | 1 094.0 | 1 013.0 | 0.93× |
| 10: 25000 text UPDATEs with an index (prepared) | 1 372.7 | 1 335.8 | 0.97× |
| **Suite** | **5 502.7** | **4 790.2** | **0.87×** |

PGlite Memory beside them: 3 052.6 and 3 138.2 ms; pgrust ÷ PGlite 1.80× and 1.53×. Chrome CPU
39.9 and 34.7 s.

## 5. Verdicts

**N against C: no net change on the phone, and it is three changes, not one.** 12 696–13 094 ms
against 12 775–13 102, 1.00× on the means. Beneath the level total the rows split two ways, each
row below outside the other arm's range. Rows 4, 5, 7, 8, 11 and 15 are slower on N (row 4 1.37×,
row 8 1.44×, row 11 1.16×), which is what losing the profile looks like: with
[the first profile](2026-09-26-wasm-pgo.md) every row but DROP TABLE got faster. Row 2 (0.64×), row 1
(0.74×) and the Warm-up (0.67×) are much faster on N. The Session backend's blocked time is 16%
lower, more than the absent-fork cache, which N also carries, took off alone (6%, in the broker-spin
session). On the desktop the same module is 1.08× C,
so the phone loses less to the missing profile or gains more from the new code; this A/B cannot say
which.

**P against N: the profile is worth 10% on the phone.** 0.90× on the Suite, the ranges apart, and
the rows the profile helps are where it shows: row 4 0.70×, row 8 0.74×, row 11 0.76×, row 14 0.81×,
rows 9 and 10 0.87–0.89×, all outside N's range. But row 2 is 1.22× slower with the profile, also
outside N's range, row 1 1.20× with the ranges overlapping, and the Warm-up does not move. On the desktop the profile was worth 17% (0.83×).

**P against C: the change the page would take is 10% on the phone, as on the desktop.** 11 546–11 645
ms against 12 775–13 102 (0.90×; desktop 0.90×), every one of the rows above faster or level but row 8
(1.06×, the ranges overlapping), rows 9, 10 and 14 by 9–19% with the ranges apart, row 2 by 22%, the
Warm-up by a third. The Prepared Suite agrees at one Run each (0.87×; row 2 0.67×, row 1 1.15×).
PGlite Memory, which no arm touches, is the same 7.2 s beside all three.

**CPU: P costs 13% less Chrome CPU per Run than C, and N 17% less.** 48.5 and 46.6 CPU-s against
55.8. The difference is almost all in the first five seconds of the pgrust column, where every
worker instantiates the module, the Engine opens and the Warm-up runs: Chrome ran 3.9–4.0 cores
there on C against 2.4–3.4 on N and P, and after that the three arms' rates are within half a core
of each other. Which part of that is compilation (N and P are 8–15% smaller modules) and which is the
shorter Warm-up was not measured. The absent-fork module alone, in the broker-spin session, cost the
same CPU as C (57.5 against 57.2 CPU-s), so the fix alone does not explain it.

## 6. What this does not show

- **The six commits apart, on wasm.** Their native effects are measured one by one (§1); on the
  phone and the desktop only the three whole modules were compared. N also carries the absent-fork
  cache and lacks the profile, so it is not "the engine commits" alone.
- **Why rows 1 and 2 are faster without the profile.** Rows 1 and 2 are 0.74× and 0.64× C on N, and
  P gives a fifth of that back. Row 2 is the noisiest row on this phone (the broker-spin note), but
  here the three arms' ranges are apart. The profile is trained on `pgo/train.sql`, not the
  Speedtest; whether its choices for the insert path are wrong for these rows was not investigated.
- **What the lower CPU is.** §5: in the column's first five seconds, cause not measured.
- **Any other phone or browser.** One Galaxy S22+ in Chrome 153. No OnePlus, no Safari.
- **Any other Suite on the phone beyond one Prepared pair.** No RTT or Concurrency Suite, and the
  Prepared figures are one Run each.
- **Energy.** CPU-seconds are the proxy, not joules; which cores ran was not recorded.
- **A significance test.** Three Runs per arm on the Speedtest, two on the desktop.
- **Correctness beyond the gate** (§3), which both modules passed: the node lanes, the leak and
  lifetime probes and pgxsinkit's unit suite.

## Reproduction

```
# pgrust: efe65be6d4 (six engine commits on be79c78758) built without a profile -> release
# pgrust-assets/efe65be6; the same source with the profile of 95d4750995 -> pgrust-assets/95d47509;
# bench 5a29882 carries both as ?pgrustModule=<id>

# the Galaxy A/B (scratch, untracked)
bun tmp/agents/spin-adopt/drive.ts --runs r1-C,r1-N,r1-P,r2-P,r2-N,r2-C,r3-C,r3-N,r3-P,pr-C,pr-P
SPIN_RUNS=tmp/agents/spin-adopt/runs-cnp SPIN_ROWS=1,2,7,9,11,14 SPIN_PER_REQUEST_ROWS=2,3,9,11,14 \
  bun tmp/agents/spin-adopt/tables.ts galaxy
```

By hand, on any phone:
<https://pgxsinkit.github.io/pglite-v-pgrust/?brokerStats=1&configurations=pglite-memory,pgrust-postmaster-opfs-repacked-relaxed&baseline=pglite-memory>
and the same with `&pgrustModule=efe65be6` or `&pgrustModule=95d47509`.

## Adopted (2026-09-26)

P is now the page's default. `.github/workflows/pages.yml` builds the site from
`--release pgrust-assets/95d47509` instead of `pgrust-assets/e2e7a2f9`, and the four alternates are
`e2e7a2f9` (C, the previous default), `3624f82c`, `be79c787` and `efe65be6` (N). `95d47509` is no
longer an alternate: it is the default, so `?pgrustModule=95d47509`, in §4's URLs and the
reproduction above, now names nothing the build carries and is ignored, and the page runs the same
bytes as its own module, with no `pgrust module:` entry in the environment line.

What moves with the pin, all verified against the release manifests:

| file | before (`pgrust-assets/e2e7a2f9`) | after (`pgrust-assets/95d47509`) |
| --- | --- | --- |
| `postgres-threads.wasm` (the six threads and postmaster columns) | `c499994c…`, 39 759 752 B | `dd1d4780…`, 33 974 686 B |
| `postgres.wasm` (the two `pgrust Memory` columns) | `4c010907…`, 39 137 339 B | `f0b145db…`, 35 830 277 B |
| `vfs.img`, `vfs.json`, the store bundle (pgxsinkit `f4777b4`) | | byte-identical |
| the vendored host JS | | byte-identical; its record now names `95d4750995` |

`src/vendor/pgrust/VERSION`, and so the environment line, reads `pgrust 95d4750995`. The
single-session `postgres.wasm` is the one N's release carries: `efe65be6d4`'s source, built without a
profile, as the one before it was. This note measured threads modules only; the `pgrust Memory`
columns' new module was not A/B'd.

**Why, in the numbers above.** On the Galaxy S22+ (fan-cooled, no throttling, three interleaved
rounds) P ran the Speedtest in 11.60 s against 12.89 s for C (0.90×, 11 546–11 645 ms against
12 775–13 102, the ranges apart); pgrust ÷ PGlite Memory went from 1.79× to 1.61×; the Warm-up
from 1 258 to 838 ms; Chrome's CPU time per Run fell 13% (55.8 to 48.5 CPU-s); the Prepared Suite,
one Run each, was 0.87×. On the desktop P was 0.90× C as well. P passed the full gate of §3: the six
pgrust node lanes, the leak probe at 0 bytes a statement on all eight paths, pgxsinkit's unit suite
2 100 passed and 0 failed, the lifetime smoke, wasm memory 256.0 MiB.

**After the switch, on the desktop.** One Speedtest Run on the synced tree (headless Chromium 149,
persistent context, `pglite-opfs-repacked-relaxed,pgrust-postmaster-opfs-repacked-relaxed`, 1-minute
load 0.23 at the start): the environment line said `pgrust 95d4750995` and `broker spin: 200 µs`
with no `pgrust module:` entry; pgrust 8 749.7 ms, PGlite OPFS 8 302.6 ms (1.05×), Warm-up 650.7 ms.
§3's P Runs were 8 948.7 and 8 901.5 ms, Warm-ups 515.6 and 572.2 ms, beside PGlite OPFS at
8 352–8 573 ms.

**Comparing with the previous default.** `?pgrustModule=e2e7a2f9` puts the six threads and
postmaster columns back on C, with this build's host JS, image and store bundle, and the environment
line says `pgrust module: e2e7a2f9 (alternate)`. On a phone, the same pair of URLs as §4:
<https://pgxsinkit.github.io/pglite-v-pgrust/?brokerStats=1&configurations=pglite-memory,pgrust-postmaster-opfs-repacked-relaxed&baseline=pglite-memory>
(P, the default) and the same with `&pgrustModule=e2e7a2f9` (C). Headlessly,
`bun run bench --suite speedtest --pgrust-module e2e7a2f9`. `&pgrustModule=efe65be6` is still the
new code without its profile.
