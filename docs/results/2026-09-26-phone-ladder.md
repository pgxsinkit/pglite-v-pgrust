# The phone ladder on module P: of pgrust's 4.1 s over PGlite Memory on a Galaxy S22+, about 1.0 s is the broker and its store, and 2.9 s is the engine

- Date: 2026-09-26
- Device: Samsung Galaxy S22+ (SM-S9060, Snapdragon 8 Gen 1), Android 16, on USB and charging, the
  screen at minimum brightness for the session
- Browser: Chrome 153.0.8010.53 for Android, the page in front, one fresh tab per Run
- Page: the published bench page at `5a29882`; every pgrust Run on `?pgrustModule=95d47509`, module P
  of [the engine-footprint note](2026-09-26-engine-footprint.md) (pgrust `efe65be6d4` with the profile
  of `95d4750995`). The page's default was still `c499994c` during the session: every pgrust Run's
  environment line named `pgrust e2e7a2f9cd | … | pgrust module: 95d47509 (alternate)`.
- Every Run: the Speedtest with `?brokerStats=1` on `pglite-memory` (the Baseline) and one other
  column, so each column's store work is its own table; the 200 µs broker spin, the default, on the
  broker columns
- Driver: `tmp/agents/spin-adopt/drive.ts`, tables by `tmp/agents/spin-adopt/ladder.ts` (both scratch,
  untracked)

## What this answers

The owner asked how much of pgrust's remaining gap to PGlite is the broker. The ladder takes the
product column, `pgrust Postmaster OPFS repacked (relaxed)`, apart one step at a time, each step a
Configuration the page already has:

| column | what it adds to the one above |
| --- | --- |
| PGlite Memory | the Baseline |
| `pgrust-threads-memory` (TM) | pgrust itself: one backend on a spawned thread, its files in an in-memory VFS each worker builds from its own copy of the image (the copy seam, no broker) |
| `pgrust-threads-memory-broker` (TB) | the broker: every file call a request to a coordinator worker, whose store is the store package's in-memory port |
| `pgrust-postmaster-memory-broker` (PB) | a real postmaster: `--host-pipes`, a startup process, checkpointer, background writer, WAL writer and a standby pool, the backend one of its children |
| `pgrust-postmaster-opfs-repacked-relaxed` (PO) | the coordinator's store on OPFS instead of its heap: the product |
| `pglite-opfs-repacked-relaxed` (GO) | PGlite's own step from memory to the same OPFS store |

**Findings.**

1. **The engine is most of the gap.** TM, pgrust with no broker at all, is 1.39× PGlite Memory: 2.87 s,
   against the product column's 4.08 s.
2. **The broker and its store are about 1.0 s of it.** In the product column the Session backend was
   blocked in file calls for 1 139 ms a Suite (1 094 and 1 184), against 137–143 ms for the same
   backend's calls into TM's in-memory VFS. The product column minus that blocked time is 10 285 ms,
   within 60 ms of TM's 10 226.
3. **The ladder's steps say the same, with a caveat each.** The broker step (TB ÷ TM) is 1.12×,
   1.26 s, but it is measured on pgrust's default settings, which send the broker three times the
   requests the product column does. The postmaster step is 0.97× (−0.35 s): the postmaster boots
   the adopted settings, and the fewer requests outweigh the extra processes. The OPFS step is 1.03×,
   0.28 s.
4. **On the phone, OPFS costs PGlite more than it costs pgrust.** PGlite OPFS is 1.22× PGlite Memory,
   1.61 s. pgrust's step from the memory store to OPFS is 0.28 s: the per-call hand-off is already paid
   on the memory store. So against PGlite OPFS, the product column's real
   competitor, pgrust is 1.27× (2.42 s), less than the engine's own 2.87 s.

## 1. Method and conditions

Five URLs, each `https://pgxsinkit.github.io/pglite-v-pgrust/?brokerStats=1&configurations=pglite-memory,<X>&baseline=pglite-memory`
with `&pgrustModule=95d47509` for the four pgrust columns (not for GO, which has none), in two rounds,
the second reversed: TM TB PB PO GO, GO PO PB TB TM, ten Runs, two per column. Before every click the
driver refused the Run unless the environment line named `broker stats: on`, `broker spin: 200 µs`
and no other spin, `pgrust module: 95d47509 (alternate)` on the pgrust Runs and no `pgrust module:`
entry on GO, the header had the `pgrust broker spin` row, and a no-store `HEAD` of both alternates'
modules answered 200. Every Run passed.

The gate before every Run: thermal status 0, the battery at or below 33.0 °C, every CPU cluster at
its hardware maximum, 15-s polls, at most 15 minutes. It cleared in under a second before every Run;
the battery was 26.5–28.2 °C before the click and 27.1–28.9 °C after (AP 36.3–40.7 °C, skin
28.3–30.4 °C after). No Run hit the hard cap; a one-step cap came and went inside the pgrust column of
`l2-PB` only. The phone stayed awake and unlocked (wakefulness read every 5 s), every Run was visible
from click to completion, and `stay_on_while_plugged_in` stayed 7; the screen was dimmed to 1 for the
session and the owner's 4 (automatic) restored after. The first Run, `l1-TM`, loaded cold: its PGlite
column took 97 s and its pgrust column 276 s from start to finish, most of it fetching assets; its
cells are timed inside the workers and are in line with `l2-TM`.

PGlite Memory, the Baseline in every Run, was 7 028–7 458 ms across the ten (mean 7 253). Each
column's ratio below is taken against the PGlite Memory of its own two Runs.

## 2. Per Run

Blocked and serving ms are sums over the 18 `Test` rows of the **Broker** table; the guest file-call
ms are from the **pgrust guest file calls** table (on a broker column the same thing as the blocked
time, on TM the in-memory VFS's own time).

| Run | column | column total (ms) | PGlite Memory (ms) | ratio | Warm-up (ms) | Session backend blocked ms | every thread blocked ms | coordinator serving ms | broker requests | guest file-call ms, backend / every thread | caps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| l1-TM | TM | 10 278.0 | 7 260.4 | 1.42× | 894.9 | — | — | — | — | 137.0 / 137.0 | none |
| l1-TB | TB | 11 338.6 | 7 086.7 | 1.60× | 898.8 | 1 079.9 | 1 079.9 | 675.5 | 15 453 | 1 079.9 / 1 079.9 | none |
| l1-PB | PB | 11 051.5 | 7 027.5 | 1.57× | 923.4 | 811.0 | 933.1 | 478.3 | 5 358 | 811.0 / 933.1 | none |
| l1-PO | PO | 11 485.8 | 7 364.1 | 1.56× | 830.1 | 1 183.5 | 1 429.0 | 892.1 | 5 200 | 1 183.5 / 1 429.0 | none |
| l1-GO | GO | 9 061.7 | 7 320.4 | 1.24× | 103.3 | — | — | — | — | — | none |
| l2-GO | GO | 8 938.4 | 7 458.3 | 1.20× | 117.4 | — | — | — | — | — | none |
| l2-PO | PO | 11 361.4 | 7 314.5 | 1.55× | 914.3 | 1 094.5 | 1 348.8 | 881.9 | 5 074 | 1 094.5 / 1 348.8 | none |
| l2-PB | PB | 11 231.5 | 7 113.4 | 1.58× | 861.4 | 807.5 | 920.4 | 483.4 | 5 225 | 807.5 / 920.4 | step |
| l2-TB | TB | 11 643.3 | 7 137.0 | 1.63× | 748.6 | 1 059.4 | 1 059.4 | 688.2 | 15 453 | 1 059.4 / 1 059.4 | none |
| l2-TM | TM | 10 174.9 | 7 445.7 | 1.37× | 869.1 | — | — | — | — | 143.3 / 143.3 | none |

The column's ms on nine rows:

| Run | column | row 1 | row 2 | row 2.1 | row 3.1 | row 6 | row 7 | row 9 | row 11 | row 14 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| l1-TM | TM | 138 | 1 020 | 161 | 181 | 26 | 727 | 2 331 | 202 | 142 |
| l1-TB | TB | 134 | 1 089 | 223 | 207 | 35 | 803 | 2 652 | 322 | 179 |
| l1-PB | PB | 104 | 1 109 | 210 | 203 | 35 | 825 | 2 473 | 251 | 182 |
| l1-PO | PO | 196 | 1 127 | 221 | 229 | 64 | 850 | 2 555 | 295 | 240 |
| l1-GO | GO | 50 | 628 | 161 | 210 | 39 | 608 | 1 940 | 399 | 236 |
| l2-GO | GO | 54 | 632 | 179 | 205 | 37 | 589 | 1 821 | 385 | 231 |
| l2-PO | PO | 145 | 1 038 | 237 | 228 | 68 | 815 | 2 512 | 329 | 240 |
| l2-PB | PB | 164 | 1 104 | 223 | 204 | 44 | 825 | 2 540 | 261 | 181 |
| l2-TB | TB | 196 | 1 227 | 215 | 221 | 37 | 719 | 2 707 | 325 | 183 |
| l2-TM | TM | 139 | 1 062 | 158 | 163 | 27 | 688 | 2 298 | 225 | 141 |

## 3. Per column

Means of the two Runs (both Runs in brackets for the totals):

| column | column total (ms) | PGlite Memory (ms) | ratio | Warm-up | row 1 | row 2 | row 2.1 | row 3.1 | row 6 | row 7 | row 9 | row 11 | row 14 | Session backend blocked | every thread blocked | serving |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PGlite Memory (all ten Runs) | 7 253 | — | 1.00× | 75 | 41 | 556 | 133 | 162 | 33 | 540 | 1 394 | 256 | 159 | — | — | — |
| TM, threads, copy seam | 10 226 (10 278, 10 175) | 7 353 | 1.39× | 882 | 139 | 1 041 | 159 | 172 | 26 | 708 | 2 315 | 213 | 141 | — | — | — |
| TB, threads, broker, memory store | 11 491 (11 339, 11 643) | 7 112 | 1.62× | 824 | 165 | 1 158 | 219 | 214 | 36 | 761 | 2 680 | 324 | 181 | 1 069.7 | 1 069.7 | 681.8 |
| PB, postmaster, broker, memory store | 11 142 (11 052, 11 232) | 7 070 | 1.58× | 892 | 134 | 1 107 | 216 | 204 | 40 | 825 | 2 506 | 256 | 182 | 809.3 | 926.8 | 480.8 |
| PO, postmaster, broker, OPFS (the product) | 11 424 (11 486, 11 361) | 7 339 | 1.56× | 872 | 171 | 1 083 | 229 | 229 | 66 | 833 | 2 533 | 312 | 240 | 1 139.0 | 1 388.9 | 887.0 |
| GO, PGlite OPFS | 9 000 (9 062, 8 938) | 7 389 | 1.22× | 110 | 52 | 630 | 170 | 208 | 38 | 599 | 1 880 | 392 | 233 | — | — | — |

## 4. The decomposition

| step | columns | ratio | seconds |
| --- | --- | ---: | ---: |
| engine | TM ÷ PGlite Memory (TM's own Runs) | 1.39× | 2.87 s |
| broker | TB ÷ TM | 1.12× | 1.26 s |
| postmaster | PB ÷ TB | 0.97× | −0.35 s |
| OPFS, pgrust | PO ÷ PB | 1.03× | 0.28 s |
| OPFS, PGlite | GO ÷ PGlite Memory (GO's own Runs) | 1.22× | 1.61 s |
| the product against PGlite Memory | PO ÷ PGlite Memory (PO's own Runs) | 1.56× | 4.08 s |
| the product against PGlite OPFS | PO ÷ GO | 1.27× | 2.42 s |

**The steps are not all on the same settings, and that moves two of them.**

- **The threads columns boot pgrust's default settings; the postmaster columns boot the adopted ones**
  ([the store-levers note](2026-09-24-store-levers.md), "Adopted"): `wal_init_zero=off`,
  `wal_buffers=4MB` and, on a relaxed store, `fsync=off`. With the defaults the guest zero-fills every
  new WAL segment 8 KiB at a time, flushes a 1 MB WAL buffer more often and syncs: TB sent the broker
  15 453 requests and 130 840 KiB of writes a Suite, the postmaster columns 5 074–5 358 requests and
  81 688 KiB (row 3: 3 245 requests against 642; row 11: 3 663 against 1 156). So **the broker step,
  1.26 s, is the broker carrying three times the product column's traffic**, and the postmaster step
  (−0.35 s) is a whole postmaster minus that traffic: neither is the broker's or the postmaster's
  cost alone. TM carries the same heavy stream, but into its own in-memory VFS, where it costs
  137–143 ms a Suite.
- **The memory broker's store is the store package's in-memory port** (`MemoryRepackedPort`, in the
  coordinator's heap), a test double under which the repacked store keeps its own bookkeeping as it
  does on OPFS. So the OPFS step is what the access handles add on top, not the store's whole cost,
  and the memory columns are not "no store".

**The better-grounded figure for the broker is the product column's own blocked time.** Its Session
backend spent 1 139 ms a Suite (1 094 and 1 184) blocked on the broker, requests and store together,
where TM's backend spent 137–143 ms on the same kind of calls in memory: about **1.0 s**. The product
column's total minus that blocked time is 10 285 ms, TM's is 10 226. So of the product column's 4.08 s
over PGlite Memory, about **1.0 s (a quarter) is the broker and its store, and about 2.9 s (seven
tenths) is the engine**. Every-thread blocked time is 1 389 ms, but the threads other than the
Session backend (checkpointer, WAL writer, background writer) run beside it and only the Session
backend's waits are on the Suite's clock.

**Where each part sits, by row** (column ms, means; the engine is TM − PGlite Memory, the rest is
PO − TM):

| row | PGlite Memory | TM | PO | engine | broker, postmaster and OPFS | PGlite's own OPFS step (GO − PGlite Memory, GO's Runs) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1: 1000 INSERTs | 41 | 139 | 171 | +98 | +32 | +8 |
| 2: 25000 INSERTs in a transaction | 556 | 1 041 | 1 083 | +485 | +42 | +64 |
| 2.1: 25000 INSERTs in single statement | 133 | 159 | 229 | +26 | +70 | +37 |
| 3.1: 25000 INSERTs into an indexed table in single statement | 162 | 172 | 229 | +10 | +57 | +43 |
| 6: Creating an index | 33 | 26 | 66 | −7 | +40 | 0 |
| 7: 5000 SELECTs with an index | 540 | 708 | 833 | +168 | +125 | +44 |
| 9: 25000 UPDATEs with an index | 1 394 | 2 315 | 2 533 | +921 | +218 | +438 |
| 11: INSERTs from a SELECT | 256 | 213 | 312 | −43 | +99 | +140 |
| 14: A big INSERT after a big DELETE | 159 | 141 | 240 | −18 | +99 | +75 |

The engine's gap is in the statement-heavy rows: row 9 alone is 0.92 s of the 2.87 s, rows 2 and 7
another 0.65 s, row 1 3.4× PGlite Memory. On the bulk-write rows the engine is close to PGlite Memory
or under it (rows 6, 11 and 14 faster, row 3.1 6% over, row 2.1 20% over), and there the broker, the
postmaster and OPFS add 40–100 ms a row, the same order as PGlite's own OPFS step on those rows
(0–140 ms).

## 5. What this does not show

- **The broker's cost on the adopted settings, as a step.** TB and TM boot pgrust's defaults, so the
  ladder's broker step carries three times the product's traffic; the 1.0 s above is read from the
  product column's own blocked time instead. A threads broker column on the adopted settings, or a
  postmaster on the copy seam (which cannot exist: its checkpointer would see its own copy), would
  measure the step directly.
- **What of the 1.0 s is hand-off and what is the store.** The coordinator's serving time (887 ms
  a Suite, summed over every thread's requests) includes its own wake-up at the 200 µs spin; the
  broker-spin note has the per-request split.
- **The engine's 2.9 s, taken apart.** Which statements, which functions: the desktop's native
  profiles (the [wasm PGO](2026-09-26-wasm-pgo.md) and [engine-footprint](2026-09-26-engine-footprint.md)
  notes) are the nearest answer; nothing here profiles the phone.
- **Any other Suite, phone or browser.** The Speedtest only, two Runs per column, one Galaxy S22+ in
  Chrome 153; no Safari, no OnePlus.
- **The module the page will ship.** Module P was an alternate during the session; if the adoption
  changes anything else about the page, these Runs do not include it.

## Reproduction

```
# scratch, untracked; the phone over adb, the page at 5a29882
bun tmp/agents/spin-adopt/drive.ts --runs l1-TM,l1-TB,l1-PB,l1-PO,l1-GO,l2-GO,l2-PO,l2-PB,l2-TB,l2-TM
bun tmp/agents/spin-adopt/ladder.ts
```

By hand, on any phone: `https://pgxsinkit.github.io/pglite-v-pgrust/?brokerStats=1&configurations=pglite-memory,<X>&baseline=pglite-memory&pgrustModule=95d47509`
with `<X>` each of the four pgrust columns in turn, and
`?brokerStats=1&configurations=pglite-memory,pglite-opfs-repacked-relaxed&baseline=pglite-memory`.
