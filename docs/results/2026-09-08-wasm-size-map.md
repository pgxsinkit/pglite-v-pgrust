# Where the 46 MB is: a size map of pgrust's threads wasm, and what a tab pays for it

- Date: 2026-09-08
- Module: `target/wasm32-wasip1-threads/wasm-release/postgres.wasm`, pgrust `spike/wasip1-threads`
  `46cb91c6cd` — **46 431 092 bytes**, sha256 `0558dd88…40d427`. The bench ships a byte-identical copy
  at `public/pgrust/postgres-threads.wasm`, which is what the browser lanes below load.
- Build: `LC_ALL=C PGRUST_WASM_TARGET=wasm32-wasip1-threads PGRUST_WASM_PROFILE=wasm-release
  wasm/wasm-build.sh` — nightly-2026-07-17, `-Zbuild-std=std,panic_unwind`, `-C panic=unwind
  -C target-feature=+exception-handling`, `[profile.wasm-release]` = `opt-level = "s"`, `lto = false`,
  `codegen-units = 16`, inherits `release` (`strip = "symbols"`).
- Tools: `twiggy 0.8.0` for the symbol map, Binaryen `wasm-opt 132` for the optimiser pass, headless
  Chromium 149.0.7827.55 and real Safari 26.6.2 on mac001 for the instantiation lanes.
- Nothing in pgrust changed. The names-kept build below was an **environment override only**
  (`CARGO_PROFILE_WASM_RELEASE_STRIP=none`); the shipped artefact was backed up first and restored
  afterwards, `cmp`-verified byte-identical (proof at the end).

## 0. The short version

| Question | Answer |
| --- | --- |
| What is the 46 MB? | 84.8% code section, 14.9% data section, 0.3% everything else. |
| Which subsystem dominates? | **None.** The largest is the executor at 16.8% of the module. |
| What actually dominates? | **Duplicated monomorphizations.** 8 105 542 bytes — 20.6% of the code section — are redundant copies of functions that already exist elsewhere in the module under the identical mangled name. `core::ptr::drop_glue::<types_error::pg_error::PgError>` is in there **810 times**. |
| What can a browser-oriented trim remove? | 2.24 MB of code (4.8% of the module) for things a browser can never reach at all; 4.90 MB (10.6%) if you also drop non-btree index AMs, PL/pgSQL, full-text search, geometry, jsonpath and EXPLAIN. |
| What does one Binaryen pass remove? | **12.64 MB — 27.2% — in 152 seconds**, and the postmaster lane still passes. |
| What does the module cost a tab before any SQL? | Chromium: +146 MiB renderer RSS to compile, +1 MiB to claim the 256 MiB shared memory, +8.6 MiB to instantiate. Safari: +347 MiB, +0 MiB, +12 MiB. |

## 1. The module, as sections

Parsed straight out of the binary by `scripts/probe-wasm-instantiate.ts`, which needs the numbers
anyway to build the memory the module imports.

| Section | bytes | % of module |
| --- | --- | --- |
| code | 39 369 538 | 84.79% |
| data | 6 929 678 | 14.92% |
| function | 82 411 | 0.18% |
| element | 43 514 | 0.09% |
| type | 4 442 | 0.01% |
| import | 1 341 | 0.00% |
| export | 80 | 0.00% |
| global, table, tag, start, data count | 44 | 0.00% |

There is no name section, no debug section and no `producers` section: `strip = "symbols"` took them.
The module imports **36 things** — `env.memory`, 34 `wasi_snapshot_preview1` functions and
`wasi.thread-spawn` — and exports **5**: `memory`, `_start`, `__main_void`, `pgrust_guc_tls_probe`,
`wasi_thread_start`. The memory import declares **4096 pages (256 MiB) minimum, 65536 pages (4 GiB)
maximum, shared**, matching `--initial-memory`/`--max-memory` in `wasm/wasm-build.sh`. There is a
**start section** (function 38, `__wasm_init_memory`), which is why instantiation alone already
copies the 6.9 MB data section into the shared memory.

Compressed, as a CDN would serve it:

| | raw | `gzip -9` | `brotli` q11, lgwin 24 |
| --- | --- | --- | --- |
| shipped module | 46 431 092 | 13 304 912 (28.7%) | 8 205 443 (17.7%) |

## 2. The names-kept build, and why its numbers apply to the shipped one

twiggy needs a name section. Rebuilding the same profile with `CARGO_PROFILE_WASM_RELEASE_STRIP=none`
(cargo's `CARGO_PROFILE_<NAME>_<KEY>` override — no file in the tree was touched) produced a
56 810 635-byte module in ~5 minutes: the same binary plus a 9 863 506-byte name section and 516 KB of
`.debug_*` sections that `debug = 0` still emits at line-table granularity.

Section-by-section against the shipped module:

| Section | shipped | names build | delta |
| --- | --- | --- | --- |
| code | 39 369 538 | 39 368 609 | **−929 bytes (0.0024%)** |
| data | 6 929 678 | 6 929 654 | −24 |
| function | 82 411 | 82 386 | −25 |

The codegen is the same to within one part in 42 000, so every byte attributed below is a byte of the
shipped module. All percentages in §3–§7 are **of the 39.4 MB code section** unless stated otherwise;
twiggy sees 81 741 code items totalling 39 452 458 bytes (it folds the per-function section headers in,
hence 83 KB more than the code section itself).

## 3. Top crates

Two attributions, because one of them is a trap. **Shallow** is twiggy's own: the crate whose name
starts the mangled symbol. That charges every `core::ptr::drop_glue::<planner::Foo>` to `core`, and
makes `core` look like 22% of the binary. **Charged** re-attributes a generic instantiation to the
first non-generic-provider crate named in it — the crate that asked for the copy. Charged is the
column to read for "what would go away if this crate went away".

| # | crate | path | charged bytes | % of code | shallow bytes |
| --- | --- | --- | --- | --- | --- |
| 1 | `execmain` | crates/backend/executor/execmain | 2 486 970 | 6.30% | 2 060 768 |
| 2 | `planner` | crates/backend/optimizer/plan/planner | 2 004 781 | 5.08% | 1 924 296 |
| 3 | `types_error` | crates/_support/types/types_error | 1 903 826 | 4.83% | 44 631 |
| 4 | `mcx` | crates/_support/mcx | 1 647 940 | 4.18% | 892 437 |
| 5 | `nodeagg` | crates/backend/executor/nodeagg | 1 158 423 | 2.94% | 794 141 |
| 6 | `types_relscan` | crates/backend/access/index/relscan | 925 561 | 2.35% | 6 645 |
| 7 | `core` | (rustc) | 790 136 | 2.00% | 8 649 766 |
| 8 | `tablecmds` | crates/backend/commands/tablecmds | 718 151 | 1.82% | 710 716 |
| 9 | `execexpr` | crates/backend/executor/execexpr | 585 201 | 1.48% | 455 409 |
| 10 | `execscan` | crates/backend/executor/execscan | 565 092 | 1.43% | 558 540 |
| 11 | `types_pathnodes` | crates/_support/types/pathnodes | 524 572 | 1.33% | 202 065 |
| 12 | `tuplesort` | crates/backend/utils/sort/tuplesort | 449 926 | 1.14% | 442 732 |
| 13 | `pgrcolumnar` | crates/backend/access/pgrcolumnar | 449 515 | 1.14% | 169 734 |
| 14 | `nodemodifytable` | crates/backend/executor/nodemodifytable | 433 314 | 1.10% | 380 186 |
| 15 | `plpgsql` | crates/pl/plpgsql | 366 867 | 0.93% | 304 950 |
| 16 | `gram_core` | crates/backend/parser/gram_core | 342 637 | 0.87% | 342 637 |
| 17 | `copy_cmd` | crates/backend/commands/copy | 324 128 | 0.82% | 248 688 |
| 18 | `types_tuple` | crates/_support/types/types_tuple | 322 576 | 0.82% | 12 488 |
| 19 | `gin_vocab` | crates/backend/access/gin/gin_vocab | 309 811 | 0.79% | 3 871 |
| 20 | `elog` | crates/backend/utils/error/elog | 287 588 | 0.73% | 140 238 |
| 21 | `types_nodes` | crates/_support/types/nodes | 284 185 | 0.72% | 225 801 |
| 22 | `ruleutils` | crates/backend/utils/adt/ruleutils | 249 523 | 0.63% | 233 859 |
| 23 | `nbtree` | crates/backend/access/nbtree/nbtree | 236 754 | 0.60% | 228 835 |
| 24 | `relcache` | crates/backend/utils/cache/relcache | 232 344 | 0.59% | 89 671 |
| 25 | `nodewindowagg` | crates/backend/executor/nodewindowagg | 223 051 | 0.57% | 209 052 |
| 26 | `alloc` | (rustc) | 213 575 | 0.54% | 774 049 |
| 27 | `adt_jsonb` | crates/backend/utils/adt/jsonb | 211 979 | 0.54% | 197 178 |
| 28 | `genam` | crates/backend/access/index/genam | 205 314 | 0.52% | 18 480 |
| 29 | `runtime` | crates/backend/executor/runtime | 197 834 | 0.50% | 115 420 |
| 30 | `commands_analyze` | crates/backend/commands/analyze | 193 204 | 0.49% | 147 027 |
| 31 | `adt_numeric` | crates/backend/utils/adt/numeric | 189 151 | 0.48% | 172 920 |
| 32 | `gin` | crates/backend/access/gin/gin | 188 176 | 0.48% | 166 385 |
| 33 | `nodes_core` | crates/backend/nodes/nodes_core | 180 765 | 0.46% | 180 765 |
| 34 | `guc` | crates/backend/utils/misc/guc | 179 908 | 0.46% | 115 516 |
| 35 | `btree_gist` | crates/contrib/btree_gist | 175 498 | 0.44% | 158 869 |
| 36 | `statistics` | crates/backend/statistics/statistics | 174 394 | 0.44% | 165 142 |
| 37 | `catalog_objectaddress` | crates/backend/catalog/objectaddress | 173 644 | 0.44% | 172 591 |
| 38 | `indxpath` | crates/backend/optimizer/path/indxpath | 167 614 | 0.42% | 145 892 |
| 39 | `regex_core` | crates/backend/regex/regex_core | 160 839 | 0.41% | 133 024 |
| 40 | `pgcrypto` | crates/contrib/pgcrypto | 158 099 | 0.40% | 152 464 |

Rows 3, 6, 18 and 19 are the interesting ones. `types_error` writes 44 KB of code and is charged
**1.90 MB**: it is the crate every `Result<_, Box<PgError>>` in the tree is generic over.
`types_relscan` writes 6.6 KB and is charged **926 KB**. The size of this binary is not, mostly, code
anybody wrote.

## 4. Subsystems

Charged attribution, grouped by the crate's directory under `crates/`.

| subsystem | code bytes | % of code | % of the 46.4 MB module | crates |
| --- | --- | --- | --- | --- |
| executor | 7 801 150 | 19.77% | 16.80% | 62 |
| pgrust support / seams / shared types (`crates/_support`) | 5 627 364 | 14.26% | 12.12% | 33 |
| access methods (heap, index AMs, WAL/transam) | 4 476 507 | 11.35% | 9.64% | 129 |
| utils/adt (type I/O and SQL functions) | 3 270 958 | 8.29% | 7.04% | 89 |
| commands (DDL + utility statements) | 3 002 092 | 7.61% | 6.47% | 73 |
| planner / optimizer | 2 547 812 | 6.46% | 5.49% | 11 |
| utils (cache, mmgr, sort, error, misc) | 2 501 105 | 6.34% | 5.39% | 89 |
| **contrib/\*** | 1 765 649 | 4.48% | 3.80% | 47 |
| parser | 1 164 434 | 2.95% | 2.51% | 22 |
| std / alloc / core (residual, after charging) | 1 129 777 | 2.86% | 2.43% | 5 |
| catalog + bootstrap | 1 125 296 | 2.85% | 2.42% | 45 |
| tcop / libpq / postmaster | 832 587 | 2.11% | 1.79% | 55 |
| storage (buffer, smgr, lock, ipc) | 728 774 | 1.85% | 1.57% | 60 |
| **replication / logical decoding** | 659 409 | 1.67% | 1.42% | 31 |
| nodes (copy/equal/out/read funcs) | 517 002 | 1.31% | 1.11% | 7 |
| procedural languages (PL/pgSQL) | 366 867 | 0.93% | 0.79% | 1 |
| statistics + partitioning | 351 645 | 0.89% | 0.76% | 5 |
| third-party crates.io | 350 188 | 0.89% | 0.75% | 30 |
| tsearch | 322 347 | 0.82% | 0.69% | 6 |
| rewriter | 184 651 | 0.47% | 0.40% | 7 |
| regex engine | 161 407 | 0.41% | 0.35% | 2 |
| C runtime / wasi-libc / unwinder (unmangled) | 127 417 | 0.32% | 0.27% | — |
| common / port | 126 573 | 0.32% | 0.27% | 33 |
| **backup / basebackup** | 110 552 | 0.28% | 0.24% | 8 |
| interfaces / bin | 81 658 | 0.21% | 0.18% | 1 |
| backend, other | 80 091 | 0.20% | 0.17% | 11 |
| timezone code | 39 146 | 0.10% | 0.08% | 4 |
| **total** | **39 452 458** | 100% | 85.0% | 867 |

Two things this table settles. First, **there is no fat subsystem to delete**: the biggest is the
executor at 16.8% of the module, and the three subsystems a browser most obviously does not need —
contrib, replication, backup — are 3.80% + 1.42% + 0.24% = **5.5% of the module between them**.
Second, **unwinding is not the story either**: the entire unmangled C/wasi-libc/libunwind surface is
127 417 bytes. `panic=unwind` costs this binary landing pads inside the Rust functions, not a large
runtime; `std::panicking::catch_unwind` monomorphizes into 145 copies for 53 459 bytes.

There is no JIT crate on wasm: `jit_deform` contributes 4 500 bytes and `execexpr::jit::HelperEnv`
appears only in drop glue.

## 5. The finding: 8.1 MB of the code section is duplicate function bodies

Grouping all 81 741 code items by their **exact mangled name**:

| | |
| --- | --- |
| distinct names appearing more than once | 2 069 |
| redundant copies of them | 29 654 |
| bytes in the redundant copies | **8 105 542 — 20.59% of the code section, 17.46% of the module** |

Top of that list:

| wasted bytes | copies | name |
| --- | --- | --- |
| 1 339 289 | 810 | `core::ptr::drop_glue::<types_error::pg_error::PgError>` |
| 725 983 | 129 | `core::ptr::drop_glue::<types_relscan::IndexScanOpaque>` |
| 226 792 | 397 | `core::ptr::drop_glue::<mcx::Backend>` |
| 223 923 | 348 | `core::ptr::drop_glue::<alloc::boxed::Box<types_error::pg_error::PgError>>` |
| 198 612 | 529 | `<mcx::slab::SlabArena>::alloc` |
| 169 643 | 9 | `core::ptr::drop_glue::<execmain::procnode::PlanStateNode>` |
| 155 073 | 208 | `core::ptr::drop_glue::<types_tuple::tupdesc::TupleDescData>` |
| 151 393 | 103 | `core::ptr::drop_glue::<genam::SysScanArm>` |
| 140 896 | 113 | `core::ptr::drop_glue::<types_relscan::IndexScanDescData>` |
| 130 340 | 1 331 | `core::ptr::drop_glue::<alloc::vec::Vec<u8>>` |
| 127 920 | 131 | `core::ptr::drop_glue::<gin_vocab::GinScanKeyData>` |
| 127 296 | 885 | `core::ptr::drop_glue::<core::option::Option<types_error::pg_error::ErrorLocation>>` |
| 124 278 | 75 | `core::ptr::drop_glue::<elog::builder::ErrorBuilder>` |
| 102 810 | 496 | `<mcx::generation::GenArena>::alloc` |
| 94 154 | 359 | `core::ptr::drop_glue::<mcx::MemoryContext>` |

Drop glue in aggregate is **23 931 functions and 7 386 219 bytes — 18.76% of the code section**, which
is more than contrib, the parser, the catalog, storage and replication put together (5 443 562). 810 copies of one function is not
a compiler bug: it is `lto = false, codegen-units = 16` doing exactly what it says, emitting the same
monomorphization once per codegen unit that needs it, with no cross-unit merge afterwards. (Copies of
the same name differ slightly in size — 23 753 vs 23 726 bytes for `PlanStateNode` — so a few are
inlined differently and not every byte is recoverable by pure merging.)

This is corroborated from two directions. `wasm/BUILD-PROFILES.md` measured `lto = "fat"` at
41 659 871 bytes, **4.77 MB below** this profile while also being 10–25% faster on writes. And
Binaryen's `-Oz`, whose passes include duplicate-function elimination, takes 12.64 MB off (§9).

## 6. Generic bloat (`twiggy monos`, and a correction to it)

`twiggy monos -g` ranks the generics: 669 generic functions, 5 248 505 bytes total, 4 191 711 bytes of
"approximate bloat" (10.6% of the code section). Its top entries:

| generic | total bytes | approx. bloat |
| --- | --- | --- |
| `core::ptr::drop_glue` | 942 527 | 918 774 |
| `execscan::exec_scan_epq` | 338 856 | 315 619 |
| `execmain::lanev2::agg_plain_fold_drain_impl` | 203 187 | 174 916 |
| `execscan::exec_scan` | 177 422 | 155 222 |
| `core::slice::sort::stable::quicksort::stable_partition` | 113 156 | 111 592 |
| `nodes_core::walk_select_stmt` | 102 635 | 101 242 |
| `core::slice::sort::shared::smallsort::small_sort_general_with_scratch` | 70 604 | 69 875 |
| `tuplesort::bounded_backlog` | 68 640 | 65 830 |

**twiggy's drop_glue row is wrong by a factor of eight** — it accounts for 942 527 bytes where the full
item list has 23 931 `core::ptr::drop_glue::<…>` functions totalling 7 386 219. twiggy appears to stop
collecting monomorphizations for a generic long before it has seen them all. Re-doing the same
grouping over every item in `twiggy top -n 200000 --format json` (split at the outermost `::<`):

| | twiggy `monos` | same rollup over all 81 741 items |
| --- | --- | --- |
| generic functions | 669 | 2 445 |
| bytes in them | 5 248 505 (13.3% of code) | 13 863 674 (35.2% of code) |
| bloat (total minus one copy each) | 4 191 711 (10.6%) | **12 087 568 (30.7% of code, 26.0% of the module)** |

The top generic offenders by copies, from the full rollup:

| generic | copies | total bytes | % of code |
| --- | --- | --- | --- |
| `core::ptr::drop_glue` | 23 931 | 7 386 219 | 18.76% |
| `execscan::exec_scan_epq` | 15 | 338 856 | 0.86% |
| `execmain::lanev2::agg_plain_fold_drain_impl` | 8 | 203 187 | 0.52% |
| `execscan::exec_scan` | 8 | 177 422 | 0.45% |
| `<std::thread::local::LocalKey<RefCell<Option<ManuallyDrop<…>>>>>::…` | 58 | 127 473 | 0.32% |
| `core::slice::sort::stable::quicksort::stable_partition` | 162 | 113 156 | 0.29% |
| `nodes_core::walk_select_stmt` | 95 | 102 635 | 0.26% |
| `<std::sync::once::Once>::call_once_force` | 377 | 95 900 | 0.24% |
| `<types_nodes::node_tree::Node>::mk` | 421 | 92 747 | 0.24% |
| `core::slice::sort::*` (all sort generics together) | 2 058 | 919 189 | 2.33% |
| `mcx::vec_with_capacity_in` | 195 | 69 999 | 0.18% |
| `mcx::alloc_in` | 179 | 48 688 | 0.12% |

Rust's sort machinery alone is 919 189 bytes across 2 058 instantiations — more than the entire
replication tree (659 409).

## 7. The data section

twiggy attributes **no symbols** to the data section: it reports it as three opaque segments, so
there is no per-item table to give. The largest data items are the segments themselves.

| segment | bytes | what it is |
| --- | --- | --- |
| `.rodata` (passive) | 6 421 672 | constants, strings, static tables |
| `.data` (passive) | 320 144 | initialised mutable statics |
| `.tdata` (passive) | 187 848 | thread-local initialisers — one copy per thread at runtime |
| total | 6 929 664 | 14.9% of the module |

Scanning the bytes for what they are: **1 931 707 bytes (27.9%) are printable ASCII runs of 6+
characters**, in 30 282 runs; the remaining **4 997 957 bytes are binary tables** (catalog bootstrap
data, encoding conversion tables, collation and locale tables, numeric constants). Of the printable
part:

| bucket | bytes | runs |
| --- | --- | --- |
| other printable (identifiers, formats, fragments) | 1 620 914 | 22 356 |
| error/message sentences | 183 450 | 4 587 |
| Rust source paths (panic and `#[track_caller]` locations) | 104 845 | 1 919 |
| SQL keywords / grammar tokens | 12 405 | 277 |
| catalog/function/type identifiers | 10 093 | 1 143 |

The measurable trim in here is small and specific: **82 410 bytes of `crates/**/*.rs` path strings**
(1 751 distinct paths) plus 3 132 bytes of `library/`+`/rustc/` paths exist only so panics can name a
line. `-Z location-detail=none` (or `panic_immediate_abort`, which pgrust cannot use — it needs
`catch_unwind`) removes them. There are **no timezone-name strings at all** in the module: the tz
database is a runtime file, not linked in.

## 8. Trim candidates

Sizes are charged bytes, i.e. the crate's own code plus the generic instantiations it caused. "Gated
today" means: is there already a feature or `cfg` that turns it off?

### Tier A — a browser can never reach these at all

| candidate | crates | bytes | % of module | gated today? |
| --- | --- | --- | --- | --- |
| `contrib/*` minus the kept set (see below) | 40 | 1 254 681 | 2.70% | **No.** Every contrib is an unconditional `<crate>::init_seams()` call in `crates/_support/seams_init/src/lib.rs` (`init_all_with_transport`, the block at lines ~250–296) plus a hard dependency in that crate's `Cargo.toml`. Dropping one needs both edits; a `[features]` block with one feature per contrib would make this a build-time switch. |
| replication tree — walsender, walreceiver, slots, slotsync, origin, syncrep, reorderbuffer, snapbuild, logical worker/proto/decode, repl_gram | 31 | 659 409 | 1.42% | **No.** `crates/backend/replication/*`, all registered through `seams_init` (`walsender_seams`, `slot_seams`, `origin_seams`, `logicalworker::init_seams()`). Biggest members: `reorderbuffer` 91 787, `logicalworker` 76 565, `slot` 60 427, `walsender` 53 717. |
| parallel query + bgworker + bgjobs + vacuumparallel | 6 | 214 812 | 0.46% | **No.** `parallel` 113 940, `vacuumparallel` 44 277, `bgworker` 34 533, `bgjobs` 20 857. Note the browser postmaster already runs with `max_parallel_workers=2` warm standbys, so this is code that is linked and mostly unused rather than dead. |
| backup / basebackup / manifest / sink / throttle | 8 | 110 552 | 0.24% | **No.** `crates/backend/backup/*`; `basebackup` 65 587 is most of it. |
| **Tier A total (de-duplicated)** | **85** | **2 239 454** | **4.82%** | |

The contrib split, charged, with the keep-set from the brief (`pgvector`, `pgvector_hnsw`, `pg_trgm`,
`pgcrypto`, `uuid_ossp`, `hstore`):

| drop | bytes | | keep | bytes |
| --- | --- | --- | --- | --- |
| `btree_gist` | 175 498 | | `pgcrypto` | 158 099 |
| `postgres_fdw` | 126 042 | | `pg_trgm` | 93 857 |
| `ltree` | 124 825 | | `hstore` | 93 788 |
| `dblink` | 101 228 | | `pgvector_hnsw` | 84 822 |
| `amcheck` | 99 176 | | `pgvector` | 39 004 |
| `pageinspect` | 81 987 | | `pgvector_hnsw_build` | 37 065 |
| `intarray` | 72 632 | | `uuid_ossp` | 4 333 |
| `pg_stat_statements` | 53 700 | | **keep total** | **510 968** |
| `contrib_cube` | 49 911 | | | |
| `pgoutput` | 35 209 | | | |
| `pgstattuple` | 34 752 | | | |
| 29 more, each < 30 000 | 299 721 | | | |
| **drop total** | **1 254 681** | | | |

Named sub-groups inside the drop set: **fdw + dblink 252 079** (`postgres_fdw` 126 042, `dblink`
101 228, `file_fdw` 24 809); **inspection/debug contribs 301 182** (`amcheck`, `pageinspect`,
`pgstattuple`, `pg_visibility`, `pg_walinspect`, `pg_surgery`, `pg_buffercache`, `pg_freespacemap`,
`pgrowlocks`, `pg_overexplain`, `injection_points`, `pg_prewarm`, `pg_logicalinspect`);
**logical-decoding output plugins 51 418** (`pgoutput` 35 209, `test_decoding` 16 209);
**gist/gin operator-class contribs 203 480** (`btree_gist`, `btree_gin`, `bloom`, `bloom_build`).

### Tier B — defensible for an embedded browser profile, but somebody will miss them

| candidate | bytes | % of module | gated today? |
| --- | --- | --- | --- |
| non-btree index AMs in core: `gin` 522 820, `gist` 223 461, `spgist` 206 951, `brin` 132 588 | 1 085 820 | 2.34% | **No.** `crates/backend/access/{gin,gist,spgist,brin}`; each AM's handler is registered from `seams_init` and referenced by catalog rows, so removing one is a catalog change as well as a link change. |
| pgrust's columnar AM (`pgrcolumnar`) | 449 515 | 0.97% | **No.** pgrust-only code, `crates/backend/access/pgrcolumnar`. |
| PL/pgSQL | 366 867 | 0.79% | **No.** One crate, `crates/pl/plpgsql`, `plpgsql::init_seams()`. The cleanest single feature gate in the tree. |
| full-text search (`tsearch`) | 322 347 | 0.69% | **No.** `crates/backend/tsearch/*` (6 crates). |
| geometry (`adt_geo` + `gistproc`) | 206 611 | 0.44% | **No.** Plus `contrib_cube`/`seg`/`earthdistance`, already counted in Tier A. |
| EXPLAIN + query jumbling (`explain` 126 819, `queryjumble` 48 598) | 175 417 | 0.38% | **No**, and `explain` is worth keeping for developer experience. |
| jsonpath (`adt_jsonpath` + `adt_jsonpath_exec`) | 124 837 | 0.27% | **No.** |
| **Tier A + Tier B (de-duplicated)** | **4 896 241** | **10.55%** | |

### What is *not* worth trimming

- **Unwinding / EH machinery** — 127 417 bytes of unmangled runtime in total. Nothing to win.
- **The timezone code** — 39 146 bytes, and the tz database is not in the binary.
- **The regex engine** — 161 407 bytes; RE2 is already stubbed out on wasm (`PGRUST_FORCE_NO_RE2=1`
  selects the Spencer-only engine).
- **The data section** — 6.9 MB, of which the only clearly removable part is 85 KB of source paths.
- **The parser** — 1.16 MB including the 342 637-byte generated `gram_core`; there is no SQL.

The honest summary of this section: **every browser-motivated deletion in the tree, taken together,
is 10.6% of the module — less than one Binaryen pass gets for free.**

## 9. Binaryen `wasm-opt`

Run on a copy of the shipped module in `tmp/agents/`; the build tree was never touched.

| variant | raw bytes | vs shipped | `gzip -9` | `brotli` q11 | wall | peak RSS | loads? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shipped | 46 431 092 | — | 13 304 912 | 8 205 443 | — | — | PASS (control) |
| `-Oz --all-features` | 33 091 584 | −28.7% | 11 512 397 | — | 187 s | 1.62 GiB | **FAILS to compile** |
| `-Oz` with the module's exact feature list | **33 795 129** | **−27.2%** | **11 595 738** | **7 875 605** | **152 s** | 1.67 GiB | **PASS** |

The feature list that works — the shipped module has no `target_features` section (stripped), so
wasm-opt cannot detect them and they must be spelled out; this list is read off the names build's
`target_features` section:

```
wasm-opt -Oz --enable-threads --enable-bulk-memory --enable-bulk-memory-opt \
  --enable-call-indirect-overlong --enable-exception-handling --enable-extended-const \
  --enable-multivalue --enable-mutable-globals --enable-nontrapping-float-to-int \
  --enable-reference-types --enable-sign-ext  postgres-in.wasm -o postgres-oz2.wasm
```

`--all-features` produces a *smaller* module (33 091 584) that **V8 refuses**:
`CompileError: WebAssembly.compile(): unknown import kind 0x7e @+6661`. Recorded as a finding, not
investigated further: some feature outside the module's own set changes how the import section is
encoded. Use the explicit list.

Where the 12.64 MB comes from, by section:

| section | shipped | after `-Oz` | delta |
| --- | --- | --- | --- |
| code | 39 369 538 | 26 789 591 | **−12 579 947 (−32.0%)** |
| data | 6 929 678 | 6 929 678 | 0 |
| element | 43 514 | 37 259 | −6 255 |
| function | 82 411 | 33 616 | −48 795 |

The code section loses a third of itself and the data section loses nothing — consistent with §5:
what `-Oz` finds is the duplicate function bodies `lto = false` left behind.

**Boot check.** With `PGRUST_WASM_THREADS` pointed at the optimised copy:

```
cd /home/anton/dev/tmp/pgrust/wasm
PGRUST_WASM_THREADS=…/tmp/agents/wasmopt/postgres-oz2.wasm \
  node run-node-wire-threads.mjs --dispatch postmaster --fs broker
```

→ `VERDICT: postmaster-node PASS fs=broker`, 12 spawned threads, 0 EAGAIN refusals, the same
`975 files (40 783 051 bytes)` store delta as the control run on the shipped module. `-Oz` passes, so
`-O3`/`-O2`/`-Os` were not needed and were not run. **Not measured: whether the optimised module is
slower.** `-Oz` is a size-first pipeline and the Speedtest was not re-run on it.

## 10. What instantiation costs, in a real browser

`bun run probe:wasm-instantiate` (`scripts/probe-wasm-instantiate.ts`). The page does nothing but
`compileStreaming` → `new WebAssembly.Memory({initial: 4096, maximum: 65536, shared: true})` →
`WebAssembly.instantiate` against 35 stub imports (`() => 0`, and `thread-spawn` → `-1`). No
postmaster, no worker, no exported function is ever called. Served from the probe's own server with
the two cross-origin isolation headers. RSS comes from outside the browser: CDP
`SystemInfo.getProcessInfo` + `/proc/<pid>/status` on Chromium (spare renderer disabled, so there is
exactly one), `ps -axo pid=,rss=,comm=` over ssh against the WebContent processes on Safari.

### Chromium 149.0.7827.55, headless, Linux — shipped module, three runs

| Step | wall (ms) | renderer RSS (MiB) | Δ RSS (MiB) | wasm memory |
| --- | --- | --- | --- | --- |
| page loaded, nothing compiled | — | 101.4 / 101.5 / 102.0 | — | — |
| after `compileStreaming` | 153 / 155 / 148 | 247.6 / 247.6 / 249.2 | **+146.2 / +146.2 / +147.2** | — |
| after `new WebAssembly.Memory` (256 MiB, shared) | 0 / 0 / 0 | 248.6 / 248.7 / 248.7 | +1.0 / +1.0 / −0.4 | 256.0 MiB |
| after `instantiate` | 5 / 11 / 11 | 257.2 / 257.0 / 257.5 | **+8.6 / +8.3 / +8.8** | 256.0 MiB |

The module fetch inside the compile row was 128 / 131 / 124 ms of it, over localhost.

### Safari 26.6.2, macOS 26.6.2 (M2), real Safari over WebDriver — two runs

| Step | wall (ms) | WebContent RSS (MiB) | Δ RSS (MiB) | wasm memory |
| --- | --- | --- | --- | --- |
| page loaded, nothing compiled | — | 60.8 / 60.8 | — | — |
| after `compileStreaming` | 516 / 568 | 407.6 / 407.0 | **+346.8 / +346.2** | — |
| after `new WebAssembly.Memory` | 0 / 1 | 407.6 / 407.0 | +0.0 / +0.0 | 256.0 MiB |
| after `instantiate` | 60 / 42 | 419.6 / 419.2 | **+12.0 / +12.2** | 256.0 MiB |

Fetch (over the ssh reverse tunnel, so not comparable to Chromium's): 398 / 404 ms.

### The same page on the `wasm-opt -Oz` module

| lane | module | compile ms | Δ RSS compile | Δ RSS instantiate |
| --- | --- | --- | --- | --- |
| Chromium | shipped 46.4 MB | 148–155 | +146.2 MiB | +8.6 MiB |
| Chromium | `-Oz` 33.8 MB | 96–115 | **+105.6 MiB** | +7.5 MiB |
| Safari | shipped 46.4 MB | 516–568 | +346.5 MiB | +12.1 MiB |
| Safari | `-Oz` 33.8 MB | 563 | **+224.8 MiB** | +11.4 MiB |

Reading these numbers:

- **Compile memory scales with module size, near-linearly.** Chromium spends 3.30 bytes of RSS per
  byte of module (3.28 for the `-Oz` module); Safari spends **7.83** (6.98 for `-Oz`). Every megabyte
  cut from the module is ~3.3 MB off a Chromium tab and ~7 MB off a Safari tab, before anything runs.
- **The 256 MiB shared memory claim is nearly free at creation** — +1.0 MiB on Chromium, +0.0 on
  Safari. It is an address-space reservation; it becomes resident when the guest writes to it. That
  is consistent with `docs/results/2026-09-08-webkit-memory-diet.md`, where the memory a booted
  postmaster *grew* was the thing worth chasing, and it says the `--initial-memory=256MiB` claim is
  not itself a residency problem.
- **Instantiate is cheap and is the data section**: +8.6 MiB Chromium / +12.1 MiB Safari for a 6.93 MB
  data section copied in by the start function, plus instance metadata.
- **Chromium's compile row is not a full compile.** 148 ms for 39 MB of code is decode + validate;
  V8 compiles function bodies lazily on first call. The Chromium numbers are therefore a *lower
  bound* on both time and memory — the rest is paid during boot, spread out. Safari's 516 ms and
  +347 MiB look like JSC's eager baseline tier doing the whole module up front. Neither number was
  cross-checked against a booted engine here; `probe:memory`'s figures are the ones for that.

## 11. What a browser-profile build could realistically reach

Start: **46.43 MB raw / 13.30 MB gzip / 8.21 MB brotli**, +146 MiB of Chromium renderer RSS and
+347 MiB of Safari WebContent RSS to compile.

The three levers, measured here or in `wasm/BUILD-PROFILES.md`, in order of what they return:

1. **One Binaryen `-Oz` pass: −12.64 MB raw (−27.2%), −1.71 MB gzip, −0.33 MB brotli, 152 s, and the
   postmaster lane still passes.** No source change at all.
2. **`lto = "fat"`: −4.77 MB raw** (measured previously, 812 s build, also 10–25% faster on write
   benchmarks). It attacks the same duplicate-monomorphization mass that `-Oz` does, so the two do
   **not** simply add — an unmeasured assumption below.
3. **Every browser-motivated deletion in the tree: −4.90 MB (−10.6%)**, of which only 2.24 MB is
   uncontroversial, and all of it needs pgrust changes (feature gates in `seams_init` and its
   `Cargo.toml`, plus catalog work for the index AMs).

Assuming `-Oz` on a fat-LTO build recovers roughly what it recovers here minus the duplicates LTO
already merged (call it −9 MB rather than −12.6 MB), and that a Tier-A+B trim then removes ~10% of
what is left, a **browser profile lands around 28–30 MB raw, 9.8–10.5 MB gzipped and 6.6–7.1 MB
brotli** — a ~35% cut, and still 2.8× PGlite's 10.1 MB raw core. Resident cost follows the module
size at the ratios measured in §10: **≈90–100 MiB of Chromium renderer RSS and ≈195–220 MiB of Safari
WebContent RSS to compile**, plus ~8–12 MiB to instantiate, plus whatever the guest then makes
resident inside its 256 MiB claim (which the memory diet already put at 256 MiB for an idle
postmaster and 657 MiB under the Speedtest).

The assumptions in that estimate, stated plainly: (a) `-Oz` and fat LTO overlap substantially and are
not additive; (b) the trim percentage carries over to an already-optimised module, which it may not —
`-Oz` removes duplicates *of the code being trimmed* too, so trimming after optimising returns less;
(c) nothing was measured about `-Oz`'s effect on speed, and a size-first Binaryen pipeline on a module
that is already `opt-level = "s"` is exactly where a regression would hide; (d) gzip and brotli were
measured at maximum settings (`-9`, q11 lgwin 24), which a CDN may not use.

**The conclusion this report actually supports is narrower than the estimate:** the 46 MB is not made
of subsystems anybody can delete — the whole browser-irrelevant surface is 10.6% — it is made of
**duplicated monomorphizations, 8.1 MB of them by exact name, 20.6% of the code section**, produced by
a profile chosen for build speed. The largest single line item in this binary is `drop_glue`, at
7.39 MB. Two things that need no design work — a Binaryen pass, and a linker that is allowed to merge
— are worth more than every trim candidate in §8 put together.

## Appendix: reproduction, and the artefact proof

```bash
# names-kept build (environment override only; no file in pgrust changed)
cd /home/anton/dev/tmp/pgrust
cp target/wasm32-wasip1-threads/wasm-release/postgres.wasm tmp/agents/postgres.wasm.shipped-backup
LC_ALL=C PGRUST_WASM_TARGET=wasm32-wasip1-threads PGRUST_WASM_PROFILE=wasm-release \
  CARGO_PROFILE_WASM_RELEASE_STRIP=none wasm/wasm-build.sh
# → VERDICT: wasm-build PASS (846/847 crates @ nightly-2026-07-17, panic=unwind), 56 810 635 bytes

twiggy top -n 200000 -f json tmp/agents/postgres.names.wasm > tmp/agents/twiggy-top.json
twiggy monos --all-generics -g -f json tmp/agents/postgres.names.wasm > tmp/agents/twiggy-monos.json
cargo metadata --no-deps --format-version 1 > tmp/agents/members.json   # crate → path map

# the shipped artefact restored from the backup and verified
rm -f target/wasm32-wasip1-threads/wasm-release/postgres.wasm
cp tmp/agents/postgres.wasm.shipped-backup target/wasm32-wasip1-threads/wasm-release/postgres.wasm
cmp target/wasm32-wasip1-threads/wasm-release/postgres.wasm tmp/agents/postgres.wasm.shipped-backup
# → no output: identical. sha256 0558dd88a4b89cfdf10f47db0bac8e56046d8756bdc35e9841fa0d53ef40d427
#   (the same sha256 as public/pgrust/postgres-threads.wasm in this repo, and as before the build)
# → git status in pgrust: clean
```

```bash
# the browser lanes, from this repo
bun run probe:wasm-instantiate --repeats 3
bun run probe:wasm-instantiate --safari --no-chromium
bun run probe:wasm-instantiate --module …/tmp/agents/wasmopt/postgres-oz2.wasm
```
