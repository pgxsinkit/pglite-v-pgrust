# A 200 µs broker spin on a Galaxy S22+: the pgrust Speedtest total 6.8% lower and the Session backend blocked 33% less, and now the default

- Date: 2026-09-26
- Device: Samsung Galaxy S22+ (SM-S9060, Snapdragon 8 Gen 1: 4× A510 at 1.79 GHz, 3× A710 at
  2.50 GHz, 1× X2 at 2.99 GHz), Android 16, on USB and charging throughout
- Browser: Chrome 153.0.8010.53 for Android, the page in front, one fresh tab per Run
- Page: the published bench page, build `8dfc389` (the one that added `?brokerSpin=` and
  `?storeLevers=`): pgrust host JS `a230ad7d08`, the modules from release `e2e7a2f9cd` (the threads
  module `c499994c…`), store bundle `7e912a53…`. From the page's own header:
  `@pgxsinkit/pglite 0.5.8-pgx.2 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust e2e7a2f9cd |
  wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available`
- Columns: `pglite-memory` (the Baseline, and the control: no switch touches it) and
  `pgrust-postmaster-opfs-repacked-relaxed` (pgrust), both in one page per Run, with `?brokerStats=1`
  on every Run
- Driver: a scratch adb + raw-CDP driver (`tmp/agents/s22/drive.ts`, untracked): one fresh tab per
  Run, the environment line checked before every click, the page's own visibility log and the OS's
  focus, keyguard and wakefulness every 30 s, a screenshot at the click and at completion. Every table
  below is printed from the Runs' own Markdown exports by `tmp/agents/s22/report.ts` and
  `tmp/agents/spin-adopt/tables.ts` (untracked).

## What this answers

On the desktop the two broker levers of build `8dfc389` moved the Speedtest inside its own spread: a
headless Chromium's broker hand-off is already short, and the Speedtest's requests are about a
millisecond apart. The question was whether a phone, where the phase-1 Runs had the Session backend
blocked about 1.8 s of every Suite and 32–47% of every blocked request as hand-off, says otherwise.

**Four findings.**

1. **The spin is the lever, and 200 µs is most of it.** Two Runs at `?brokerSpin=200` put pgrust's
   Speedtest total at 13 009 and 13 156 ms against 13 841–14 237 ms for the three uncapped Runs
   without it: **−6.8%** on the mean, both Runs outside that spread. The Session backend's blocked
   time fell **33%** (1 202 and 1 246 ms against 1 790–1 926 ms). The gain sits where the hand-off
   dominates: rows 11 and 14 halve (673 → 320 ms and 527 → 254 ms), rows 2.1, 3.1 and 6 lose a
   quarter to a third, row 3 loses 17%; rows 2, 9 and 10 do not move.
2. **More spin buys little more.** 500 µs is −7.8% and 1000 µs −9.6% (−3.0% on 200's mean, inside
   1000's own 270 ms range); 50 µs is −2.6% and leaves rows 11 and 14 where they were. The Session
   backend's blocked time is −35% at 500 µs and −38% at 1000 µs.
3. **The store levers do what they say, and it does not show in the total.** `grow,coalesce` takes
   row 3's OPFS handle writes from 1 666–1 668 to 911–913 and its truncates from 498 to 2, and row 3
   from 1 591 to 1 240 ms; but rows 9 and 10 come out slower and the Suite total is inside the
   no-switch spread. They are parked (§6).
4. **Adopted:** every pgrust broker Configuration now spins 200 µs by default, and `?brokerSpin=0` is
   the page as it was (§7).

## 1. Method

Every Run is the Speedtest Suite on

`https://pgxsinkit.github.io/pglite-v-pgrust/?brokerStats=1&configurations=pglite-memory,pgrust-postmaster-opfs-repacked-relaxed&baseline=pglite-memory`

plus one arm: **X0** nothing, **S\<N\>** `&brokerSpin=<N>`, **L** `&storeLevers=grow,coalesce`,
**LS1000** both, the spin at 1000 µs because S1000 had the lowest round-1 pgrust total of the four
spins (S1000 12 829, S500 12 945, S200 13 156, S50 13 674 ms). Sixteen Runs in three rounds, the
second in reverse order:

| round | order |
| --- | --- |
| 1 | X0, S50, S200, S500, S1000, L, X0 |
| 2 | LS1000, L, S1000, S500, S200, S50, X0 |
| 3 | X0, LS1000 |

Before every click the driver read the page's environment line and refused the Run unless it named
`broker stats: on`, `pgrust e2e7a2f9cd` and exactly the arm's switches (quoted per Run in the
[appendix](#appendix-environment-lines)); it also fetched `pgrust/host/broker-spin.js` with
`cache: 'no-store'`, which only build `8dfc389` serves, and it answered 200 every time. Totals are
the sums of the 18 `Test` rows; the Warm-up is in no total. PGlite Memory is the control: no switch
touches it, and its total ranged over 7 075–7 587 ms across all sixteen Runs, so a pgrust ÷ PGlite
ratio carries that ±3.5% too and **the pgrust totals are the cleaner comparison**.

**The thermal gate, and why it was tightened.** Phase 1 had found that this phone caps its CPUs
(A510 1 786 → 1 363, A710 2 496 → 1 882, X2 2 995 → 2 170 MHz) with thermal status still 0 and the
battery under 35 °C, after 30–41 s of sustained load, and lifts the caps only when the battery is back
at about 31.5–31.8 °C. So the gate before every Run waited, polling every 15 s for at most 10 minutes,
for thermal status 0, the battery under 35.0 °C **and every cpufreq policy's `scaling_max_freq` back
at its `cpuinfo_max_freq`**. That was not enough: two round-1 Runs that started with the battery at
32.1–32.7 °C, `r1-02-S50` and `r1-07-X0`, hit the hard cap (A710 1 882, X2 2 170 MHz) in the second
half of their pgrust column. **From round 2 the gate also waited for the battery at or below
31.8 °C**; the waits became 232–403 s, and no round-2 or round-3 Run hit the hard cap inside its
pgrust column except `r3-02-LS`, which shows it only in the reading after the Run, the last second of
its column at most. The cap log was sampled every 10 s in round 1 and every 5 s from round 2. **Hard**
below is the cap the phone settles on (A710 ≤ 1 882 or X2 ≤ 2 170 MHz); **step** is a smaller,
transient cap of one step on the X2 or the A710, which lifted again. Every per-arm figure is over the Runs
whose pgrust column never hit the hard cap.

Five further Runs were refused before their click and are not measurements: the first attempt at
round 1 demanded `pgrust a230ad7d08` (the host JS) in the environment line, which names the module
release, `e2e7a2f9cd`. Round 1 was then run again from the start. The first X0 Run was the first after
the redeploy and loaded cold (the pgrust column took 130 s from start to finish, most of it fetching
assets over a ~160 ms round trip with the CPUs idle); its cells are timed inside the worker and are in
line with the other X0 Runs.

## 2. Per Run

Thermal cells are `status / battery (0.1 °C) / AP °C / skin °C / caps MHz (A510/A710/X2)`; a bold cap
is below the hardware maximum. Every Run was visible from click to completion with no visibility,
freeze or pagehide event, and the OS reported the phone awake, unlocked and Chrome focused at every
30-s check.

| Run | arm | click (UTC) | gate | gate wait | before | after | caps in the pgrust column | wall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1-01 | X0 | 07:04:47 | phase 1 | 0 s | 0 / 310 / 31.0 / 31.3 / 1786/2496/2995 | 0 / 326 / 36.4 / 33.3 / 1786/2496/2995 | none (130 s column) | 174 s |
| r1-02 | S50 | 07:08:48 | phase 1 | 0 s | 0 / 321 / 32.3 / 32.5 / 1786/2496/2995 | 0 / 329 / 40.0 / 34.3 / 1786/**1882**/**2170** | hard, seen after the Run: onset after +10 s of an 18 s column | 30 s |
| r1-03 | S200 | 07:14:00 | phase 1 | 216 s | 0 / 318 / 31.9 / 32.0 / 1786/2496/2995 | 0 / 330 / 42.5 / 34.1 / 1786/2496/2995 | none (17 s column) | 30 s |
| r1-04 | S500 | 07:15:37 | phase 1 | 1 s | 0 / 327 / 33.1 / 33.0 / 1786/2496/2995 | 0 / 333 / 47.3 / 34.2 / 1786/2496/2995 | step from +8 s of an 18 s column | 30 s |
| r1-05 | S1000 | 07:23:08 | phase 1 | 355 s | 0 / 319 / 31.8 / 32.0 / 1786/2496/2995 | 0 / 332 / 41.3 / 34.3 / 1786/2496/2995 | none (18 s column) | 30 s |
| r1-06 | L | 07:30:08 | phase 1 | 324 s | 0 / 319 / 31.8 / 32.0 / 1786/2496/2995 | 0 / 332 / 36.2 / 33.8 / 1786/2496/2995 | step from +9 s of a 20 s column | 41 s |
| r1-07 | X0 | 07:31:55 | phase 1 | 0 s | 0 / 327 / 33.0 / 33.0 / 1786/2496/2995 | 0 / 334 / 44.9 / 34.5 / **1363**/**1882**/**2170** | hard, seen after the Run: onset after +10 s of a 20 s column | 30 s |
| r2-01 | LS1000 | 07:40:33 | + battery ≤ 31.8 °C | 401 s | 0 / 318 / 32.2 / 32.0 / 1786/2496/2995 | 0 / 327 / 44.7 / 33.5 / 1786/2496/2995 | step from +9 s of a 19 s column | 31 s |
| r2-02 | L | 07:47:51 | + battery ≤ 31.8 °C | 342 s | 0 / 318 / 31.8 / 32.0 / 1786/2496/2995 | 0 / 328 / 42.6 / 33.9 / 1786/2496/2995 | none (18 s column) | 31 s |
| r2-03 | S1000 | 07:53:20 | + battery ≤ 31.8 °C | 232 s | 0 / 318 / 31.7 / 32.0 / 1786/2496/2995 | 0 / 325 / 44.7 / 33.9 / 1786/2496/2995 | step from +9 s of a 19 s column | 31 s |
| r2-04 | S500 | 08:00:06 | + battery ≤ 31.8 °C | 310 s | 0 / 318 / 31.8 / 32.0 / 1786/2496/2995 | 0 / 328 / 45.0 / 33.7 / 1786/2496/2995 | step from +5 s of a 17 s column | 31 s |
| r2-05 | S200 | 08:07:24 | + battery ≤ 31.8 °C | 341 s | 0 / 318 / 31.8 / 31.9 / 1786/2496/2995 | 0 / 331 / 39.9 / 34.0 / 1786/2496/2995 | none (20 s column) | 36 s |
| r2-06 | S50 | 08:14:32 | + battery ≤ 31.8 °C | 326 s | 0 / 318 / 31.8 / 32.0 / 1786/2496/2995 | 0 / 329 / 43.6 / 34.0 / 1786/2496/2995 | none (18 s column) | 31 s |
| r2-07 | X0 | 08:21:03 | + battery ≤ 31.8 °C | 295 s | 0 / 318 / 32.6 / 32.0 / 1786/2496/2995 | 0 / 330 / 38.9 / 33.9 / 1786/2496/2995 | none (22 s column) | 36 s |
| r3-01 | X0 | 08:28:39 | + battery ≤ 31.8 °C | 403 s | 0 / 318 / 31.6 / 31.9 / 1786/2496/2995 | 0 / 328 / 40.5 / 34.0 / 1786/2496/2995 | none (18 s column) | 31 s |
| r3-02 | LS1000 | 08:36:13 | + battery ≤ 31.8 °C | 355 s | 0 / 318 / 31.7 / 31.9 / 1786/2496/2995 | 0 / 329 / 38.9 / 34.0 / **1363**/**1882**/**2170** | hard, seen after the Run: onset after +19 s of a 20 s column | 36 s |

Totals, the Warm-up, and the store work summed over the 18 `Test` rows (the **Broker** table of each
export); row 3's handle calls are from its **OPFS access handles** table:

| Run | arm | pgrust total (ms) | PGlite Memory total (ms) | pgrust ÷ PGlite | Warm-up pgrust / PGlite (ms) | Session backend blocked ms | every thread blocked ms | coordinator serving ms | row 3 handle writes / truncates | caps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1-01 | X0 | 14 237.1 | 7 208.1 | 1.98× | 1 365.7 / 79.4 | 1 802.8 | 2 263.0 | 1 355.9 | 1 666 / 498 | none |
| r1-02 | S50 | 13 673.9 | 7 310.7 | 1.87× | 1 336.6 / 70.8 | 1 707.1 | 2 117.2 | 1 274.4 | 1 668 / 498 | hard |
| r1-03 | S200 | 13 156.5 | 7 365.0 | 1.79× | 1 181.5 / 69.4 | 1 245.5 | 1 518.6 | 929.9 | 1 669 / 498 | none |
| r1-04 | S500 | 12 945.2 | 7 367.6 | 1.76× | 1 112.1 / 94.3 | 1 211.2 | 1 463.8 | 948.4 | 1 666 / 498 | step |
| r1-05 | S1000 | 12 828.6 | 7 075.5 | 1.81× | 1 252.5 / 62.7 | 1 114.0 | 1 387.2 | 911.3 | 1 666 / 498 | none |
| r1-06 | L | 14 093.3 | 7 311.8 | 1.93× | 1 308.2 / 68.4 | 1 739.9 | 2 027.4 | 1 122.0 | 911 / 2 | step |
| r1-07 | X0 | 15 767.3 | 7 124.5 | 2.21× | 1 313.2 / 68.1 | 1 897.2 | 2 454.1 | 1 463.6 | 1 668 / 498 | hard |
| r2-01 | LS1000 | 12 595.3 | 7 120.9 | 1.77× | 1 262.4 / 63.3 | 1 093.9 | 1 217.6 | 737.7 | 911 / 2 | step |
| r2-02 | L | 13 885.0 | 7 075.7 | 1.96× | 1 303.9 / 72.4 | 1 675.5 | 2 004.3 | 1 088.0 | 912 / 2 | none |
| r2-03 | S1000 | 12 559.0 | 7 158.9 | 1.75× | 1 241.7 / 85.8 | 1 173.6 | 1 446.3 | 943.0 | 1 668 / 498 | step |
| r2-04 | S500 | 12 939.7 | 7 350.8 | 1.76× | 1 289.1 / 67.9 | 1 186.1 | 1 453.6 | 963.7 | 1 668 / 498 | step |
| r2-05 | S200 | 13 009.1 | 7 244.5 | 1.80× | 1 158.2 / 71.5 | 1 202.1 | 1 470.0 | 921.6 | 1 667 / 498 | none |
| r2-06 | S50 | 13 679.2 | 7 355.7 | 1.86× | 1 325.4 / 72.3 | 1 639.5 | 1 999.9 | 1 190.9 | 1 667 / 498 | none |
| r2-07 | X0 | 14 038.0 | 7 415.3 | 1.89× | 1 313.8 / 76.1 | 1 926.2 | 2 426.6 | 1 426.9 | 1 668 / 498 | none |
| r3-01 | X0 | 13 840.9 | 7 425.0 | 1.86× | 1 373.1 / 104.6 | 1 790.1 | 2 268.8 | 1 422.8 | 1 666 / 498 | none |
| r3-02 | LS1000 | 12 708.1 | 7 586.8 | 1.68× | 1 371.6 / 69.0 | 1 100.5 | 1 246.3 | 740.3 | 913 / 2 | hard |

µs per broker request on the seven rows where the hand-off is largest, **blocked / serving**: what a
guest thread was blocked on a request, and what the coordinator spent answering it. The difference is
the hand-off.

| Run | arm | row 2 | row 3 | row 3.1 | row 9 | row 10 | row 11 | row 14 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1-01 | X0 | 603 / 330 | 334 / 216 | 319 / 231 | 436 / 229 | 478 / 255 | 378 / 256 | 367 / 236 |
| r1-02 | S50 | 641 / 347 | 273 / 182 | 244 / 183 | 370 / 188 | 433 / 239 | 393 / 241 | 455 / 299 |
| r1-03 | S200 | 564 / 291 | 231 / 160 | 172 / 123 | 352 / 178 | 392 / 196 | 132 / 108 | 130 / 106 |
| r1-04 | S500 | 638 / 363 | 208 / 151 | 157 / 127 | 330 / 170 | 379 / 194 | 150 / 123 | 133 / 114 |
| r1-05 | S1000 | 573 / 331 | 197 / 143 | 162 / 137 | 334 / 170 | 367 / 191 | 122 / 102 | 128 / 112 |
| r1-06 | L | 473 / 214 | 248 / 160 | 288 / 180 | 389 / 175 | 425 / 203 | 354 / 211 | 466 / 316 |
| r1-07 | X0 | 566 / 286 | 259 / 181 | 328 / 238 | 461 / 236 | 778 / 391 | 432 / 291 | 418 / 276 |
| r2-01 | LS1000 | 602 / 279 | 163 / 115 | 110 / 97 | 333 / 176 | 340 / 168 | 93 / 79 | 103 / 88 |
| r2-02 | L | 562 / 237 | 220 / 139 | 279 / 180 | 426 / 182 | 536 / 260 | 333 / 199 | 350 / 239 |
| r2-03 | S1000 | 821 / 472 | 186 / 135 | 152 / 133 | 344 / 175 | 374 / 192 | 123 / 108 | 116 / 102 |
| r2-04 | S500 | 585 / 377 | 207 / 149 | 148 / 126 | 362 / 198 | 387 / 198 | 138 / 122 | 150 / 129 |
| r2-05 | S200 | 627 / 316 | 229 / 164 | 160 / 128 | 336 / 176 | 383 / 194 | 127 / 104 | 152 / 124 |
| r2-06 | S50 | 641 / 309 | 243 / 171 | 226 / 183 | 368 / 188 | 420 / 216 | 356 / 223 | 378 / 248 |
| r2-07 | X0 | 541 / 312 | 429 / 277 | 329 / 225 | 426 / 194 | 542 / 259 | 403 / 260 | 432 / 299 |
| r3-01 | X0 | 523 / 312 | 290 / 187 | 323 / 226 | 412 / 238 | 500 / 266 | 408 / 278 | 546 / 365 |
| r3-02 | LS1000 | 620 / 316 | 167 / 107 | 102 / 87 | 297 / 128 | 318 / 139 | 132 / 115 | 127 / 108 |

## 3. Per arm

Mean (range), over the Runs whose pgrust column never hit the hard cap:

| arm | Runs | pgrust total (ms) | vs X0 | PGlite Memory total (ms) | pgrust ÷ PGlite | Session backend blocked ms | vs X0 | every thread blocked ms | row 3 writes / truncates |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| X0 | 3 | 14 039 (13 841–14 237) | — | 7 349 (7 208–7 425) | 1.91× (1.86–1.98) | 1 840 (1 790–1 926) | — | 2 319 (2 263–2 427) | 1 666–1 668 / 498 |
| S50 | 1 | 13 679 | −2.6% | 7 356 | 1.86× | 1 640 | −11% | 2 000 | 1 667 / 498 |
| S200 | 2 | 13 083 (13 009–13 156) | **−6.8%** | 7 305 (7 244–7 365) | 1.79× (1.79–1.80) | 1 224 (1 202–1 246) | **−33%** | 1 494 (1 470–1 519) | 1 667–1 669 / 498 |
| S500 | 2 | 12 942 (12 940–12 945) | −7.8% | 7 359 (7 351–7 368) | 1.76× (1.76–1.76) | 1 199 (1 186–1 211) | −35% | 1 459 (1 454–1 464) | 1 666–1 668 / 498 |
| S1000 | 2 | 12 694 (12 559–12 829) | −9.6% | 7 117 (7 075–7 159) | 1.78× (1.75–1.81) | 1 144 (1 114–1 174) | −38% | 1 417 (1 387–1 446) | 1 666–1 668 / 498 |
| L | 2 | 13 989 (13 885–14 093) | −0.4% | 7 194 (7 076–7 312) | 1.94× (1.93–1.96) | 1 708 (1 676–1 740) | −7% | 2 016 (2 004–2 027) | 911–912 / 2 |
| LS1000 | 1 | 12 595 | −10.3% | 7 121 | 1.77× | 1 094 | −41% | 1 218 | 911 / 2 |

Over every valid Run instead, the hard-capped three included, only three cells move: X0 becomes
14 471 (13 841–15 767) ms over four Runs, S50 13 677 (13 674–13 679) over two, and LS1000 12 652
(12 595–12 708) over two. The capped S50 Run matches the uncapped one to 5 ms.

pgrust ms per row, the same Runs:

| arm | Runs | row 2 | row 2.1 | row 3 | row 3.1 | row 6 | row 9 | row 10 | row 11 | row 14 | Suite total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| X0 | 3 | 1 489 | 303 | 1 591 | 373 | 90 | 2 801 | 3 286 | 673 | 527 | 14 039 |
| S50 | 1 | 1 544 | 312 | 1 324 | 299 | 89 | 2 815 | 3 253 | 630 | 474 | 13 679 |
| S200 | 2 | 1 645 | 231 | 1 319 | 248 | 57 | 2 820 | 3 316 | 320 | 254 | 13 083 |
| S500 | 2 | 1 574 | 231 | 1 269 | 261 | 57 | 2 805 | 3 271 | 321 | 254 | 12 942 |
| S1000 | 2 | 1 522 | 228 | 1 203 | 242 | 48 | 2 791 | 3 271 | 328 | 243 | 12 694 |
| L | 2 | 1 535 | 289 | 1 240 | 365 | 80 | 2 964 | 3 449 | 646 | 519 | 13 989 |
| LS1000 | 1 | 1 464 | 204 | 1 165 | 222 | 41 | 2 813 | 3 260 | 315 | 233 | 12 595 |

## 4. What each spin did

The reference is the three uncapped X0 Runs: pgrust 13 841–14 237 ms (mean 14 039), Session backend
blocked 1 790–1 926 ms (mean 1 840).

**`brokerSpin=50`.** Slightly beyond the X0 spread, and small: 13 674 and 13 679 ms, 1.2% under the
lowest X0 and 2.6% under its mean; the Session backend blocked 1 707 and 1 640 ms, 5–8% under the
lowest X0. It trims rows 3 and 3.1 per request and leaves rows 11 and 14 where X0 has them (356–455 µs
blocked per request).

**`brokerSpin=200`.** Clearly beyond the spread: 13 009 and 13 156 ms (−6.8%), Session backend blocked
1 202 and 1 246 ms (−33%), every thread blocked 1 470 and 1 519 ms against 2 263–2 427. The gain is
concentrated where the broker hand-off dominates:

- row 11: 673 → 320 ms, blocked 127–132 µs per request against 378–408 µs at X0;
- row 14: 527 → 254 ms, 130–152 µs against 367–546 µs;
- row 3: 1 591 → 1 319 ms, 229–231 µs against 290–429 µs;
- rows 2.1, 3.1 and 6: −24%, −34% and −37%.

Rows 9 and 10, the two UPDATE rows and more than two-fifths of the Suite, do not move. Their requests
do get shorter — row 9's blocked time per request falls from 412–436 to 336–352 µs — but at about
745 requests that is some 60 ms of a 2.8 s row: those rows are the guest's own work. Neither does
row 2, which is the noisiest row on this phone (1 451–1 564 ms at X0, 1 579 and 1 710 at S200,
1 462–1 665 at S500 and S1000). Coordinator serving time falls with the spin (922–930 ms
against 1 356–1 427 ms at X0), because the coordinator's own wake-up is inside what it counts as
serving.

**`brokerSpin=500`.** Beyond the spread, and indistinguishable from 200 at two Runs each: 12 940 and
12 945 ms (−7.8%), Session backend blocked 1 186 and 1 211 ms (−35%), per-request figures the same as
200's within Run-to-Run noise.

**`brokerSpin=1000`.** The best spin by total: 12 559 and 12 829 ms (−9.6%; −3.0% on 200's mean, which
is inside 1000's own 270 ms range), Session backend blocked 1 114 and 1 174 ms (−38%). Past 200 µs the
returns are small, and every µs a waiting thread spins is a core polling instead of parked. The
after-Run temperatures of the spin Runs, the LS Runs included (battery 32.5–33.3 °C, AP
38.9–47.3 °C), and their cap history are no worse than the X0 Runs' (battery 32.6–33.4 °C, AP
36.4–44.9 °C), but that is heat over 30 seconds, not energy.

## 5. Why the desktop barely saw it

On the desktop (headless Chromium 149 on an i7-1165G7, in the commit that added the switches) 200 µs
moved the Speedtest inside its own spread and trimmed 10–25 µs a request off the heavy rows (row 9:
61–70 → 48–57 µs, as that commit reports it). On this phone a row-9 request was blocked 412–436 µs, of
which 174–232 µs was hand-off (blocked minus serving), and a row-11 request was blocked 378–408 µs
for 256–278 µs of the coordinator's serving. With 200 µs of spin, row 11's blocked time per request fell to 127–132 µs and
its serving to 104–108 µs: both halves shrink, because the coordinator's own wake-up is inside what it
counts as serving. So what the spin removes on the phone is the cost of parking and waking a thread on
either side of the seam, which is several times what it is on the desktop. Why a wake costs that much
here — which cores the guest and the coordinator ran on, and at what frequency — was not measured.

## 6. The store levers, and why they are parked

`?storeLevers=grow,coalesce` is levers U1 and U2 of [the store-levers note](2026-09-24-store-levers.md),
carried as a wrapper around the port in pgrust's coordinator: the arena file grows in 4 MiB chunks
(trimmed back on close) instead of one truncate per allocation, and contiguous arena writes inside one
store call are one access handle write. On the phone they do exactly that:

- row 3's OPFS handle writes fall from 1 666–1 668 to 911–913, and its truncates from 498 to 2;
- row 3 is faster, 1 591 → 1 240 ms, and its blocked time per request falls from 290–429 to 220–248 µs.

But rows 9 and 10 are slower in both L Runs (2 964 / 3 449 ms against 2 801 / 3 286 at X0), and the
Suite total, 13 885 and 14 093 ms, is inside X0's 13 841–14 237 ms. The Session backend's blocked
time is 3–6% under the lowest X0. On top of the spin (LS1000) the levers take every thread's blocked
time about 13% under S1000's (1 218 and 1 246 against 1 387–1 446 ms) and leave the total where S1000
has it (12 595 and 12 708 against 12 559–12 829 ms).

So on this phone the number of store calls is not what the pgrust total waits on; the hand-off is.
The levers change the store's file layout on OPFS, and the store-levers note already found them worth
0–4% of the Suite on a disk-backed desktop profile, with no crash or reopen test run against them.
A change to on-disk behaviour that no measured total rewards is not worth making the default. They
stay behind `?storeLevers=`, and are the lever to try again if a phone or a browser shows the store's
call count in its totals.

## 7. Adopted (2026-09-26)

The owner accepted 200 µs as the default on 2026-09-26. Every pgrust broker Configuration — the three
`pgrust Threads` broker columns and the two `pgrust Postmaster` columns — now opens with
`brokerSpinUs: 200` unless the URL sets another spin, on the page and therefore in `bun run bench`
(`src/broker-switches.ts`, `BROKER_SPIN_DEFAULT_US`). The PGlite columns, the two single-session
`pgrust` columns and `pgrust Threads Memory` (the copy seam, which has no broker) are untouched, as is
the engine's own default for any other caller of `src/client/pgrust-browser-engine.ts` (the pgxsinkit
store factory keeps no spin).

- `?brokerSpin=N` (0–1000) still overrides it, and `?brokerSpin=0` is the page as it was: the broker
  columns then open with no spin option at all, byte for byte the options every result in this
  directory before this note was produced with. `bun run bench --broker-spin 0` is the same.
- The environment line names the spin on **every** Run, the default included: `broker spin: 200 µs`
  without a parameter, `broker spin: <N> µs` with one. An export therefore says which hand-off its
  broker columns ran on without the reader knowing when the default moved. The header shows it as a
  `pgrust broker spin` row, marked non-standard when it is not the default.
- `bun run bench` fails a Run whose page does not announce the spin it expects: the `--broker-spin`
  value, or `broker spin: 200 µs` without the flag.

200 rather than 1000: past 200 µs the phone bought another 3% of total for five times the spin
bound, and every µs of it is a waiting thread polling on a core that could otherwise sleep.

## 8. What this does not show

- **The OnePlus, or any other phone.** One Galaxy S22+, one Chrome. The spin trades a parked wait
  for a poll, and what a wake-up costs is the core's and the kernel's; another SoC can move the
  balance either way.
- **Safari.** WebKit's `Atomics.wait` and its worker scheduling are its own; the spin is unmeasured
  there.
- **Any other Suite.** Every Run here is the Speedtest. The RTT Suite's single statements, the
  Concurrency Suite's several backends at once (where a spinning thread competes with a working one
  for a core) and the Prepared Suite were not run with the spin on this phone.
- **Any other column.** Only `pgrust Postmaster OPFS repacked (relaxed)` was measured; the default
  also reaches the Memory broker columns and the two threads OPFS columns.
- **What the spin costs in energy.** CPU time, heat and battery drain were not measured; the
  after-Run temperatures above are 30 seconds of heat, not a battery figure.
- **Spins between 200 and 500, or above 1000.** 1000 µs is pgrust's own bound.
- **A significance test.** Two Runs per spin arm; the verdicts are against the spread of three
  uncapped X0 Runs, not a statistical test.

## Reproduction

The Runs are the published page's, driven from the scratch driver (untracked):

```
# round 1 was run with the phase-1 gate, rounds 2 and 3 with --cool 318 (battery <= 31.8 C)
bun tmp/agents/s22/drive.ts --p2 r1-01-X0,r1-02-S50,r1-03-S200,r1-04-S500,r1-05-S1000,r1-06-L,r1-07-X0
bun tmp/agents/s22/drive.ts --p2 r2-01-LS,r2-02-L,r2-03-S1000,r2-04-S500,r2-05-S200,r2-06-S50,r2-07-X0 --ls-spin 1000 --cool 318
bun tmp/agents/s22/drive.ts --p2 r3-01-X0,r3-02-LS --ls-spin 1000 --cool 318
# the tables
bun tmp/agents/s22/report.ts
bun tmp/agents/spin-adopt/tables.ts p2
```

Any single arm by hand, on any phone:
<https://pgxsinkit.github.io/pglite-v-pgrust/?brokerStats=1&brokerSpin=0&configurations=pglite-memory,pgrust-postmaster-opfs-repacked-relaxed&baseline=pglite-memory>
with `brokerSpin` set to the spin (or removed, for the default), and `&storeLevers=grow,coalesce` for
the levers.

## Appendix: environment lines

Every line begins `@pgxsinkit/pglite 0.5.8-pgx.2 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust
e2e7a2f9cd | wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access
available | Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko)
Chrome/153.0.0.0 Mobile Safari/537.36 | broker stats: on`, and goes on:

| Runs | the rest of the line |
| --- | --- |
| r1-01, r1-07, r2-07, r3-01 (X0) | (nothing) |
| r1-02, r2-06 (S50) | `\| broker spin: 50 µs` |
| r1-03, r2-05 (S200) | `\| broker spin: 200 µs` |
| r1-04, r2-04 (S500) | `\| broker spin: 500 µs` |
| r1-05, r2-03 (S1000) | `\| broker spin: 1000 µs` |
| r1-06, r2-02 (L) | `\| store levers: grow, coalesce (pgrust columns only)` |
| r2-01, r3-02 (LS1000) | `\| broker spin: 1000 µs \| store levers: grow, coalesce (pgrust columns only)` |
