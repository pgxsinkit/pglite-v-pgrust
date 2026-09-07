# Is a data directory portable between PGlite and pgrust? No — by one control-file field

- Date: 2026-09-07
- Runtime: bun 1.4.2 on Linux 7.0.0-30-generic (x86_64, i7-1165G7), no browser
- Engines: `@pgxsinkit/pglite` 0.5.5-pgx.3 (PostgreSQL 18.3, wasm32-unknown-linux-gnu, emcc 3.1.74,
  32-bit) and pgrust `9bab6bff11` (`PostmasterMain` over host pipes, broker store on the memory
  port, wasm32-wasip1-threads)
- Driver: steps (h) and (i) of `bun run scenario:pgxsinkit-factory`
  (`scripts/pgxsinkit-factory-scenario.ts`)

## The question

The pgrust-backed store factory (`src/client/pgrust-factory.ts`) writes its `dumpDataDir` tarballs
in PGlite's own layout so pgxsinkit's restore path treats a backup from either engine identically.
That raises a sharper question the format alone does not answer: is the **data directory inside**
the tarball portable too? Both engines are PostgreSQL 18.3, both declare `PG_CONTROL_VERSION` 1800
and `CATALOG_VERSION_NO` 202506291, and pgrust's own `GOAL.md` states the intent as "same on-disk
format (a C 18.3 binary can boot our data directory and vice versa)".

## Method

Both directions, in one run, each one a real boot rather than an inspection:

- **(h) PGlite → pgrust.** A plain in-memory `PGlite` creates a table, writes five rows, runs
  `CHECKPOINT` and `dumpDataDir()`. That tarball goes to
  `createPgrustPglite("memory://from-pglite", { loadDataDir })`, which unpacks it over the broker
  into `/pgdata` before the postmaster starts.
- **(i) pgrust → PGlite.** The tarball from step (d) of the same scenario — a pgrust datadir holding
  the three rows `@pgxsinkit/client` wrote — goes to `PGlite.create({ loadDataDir })`.

A refusal is a result here, so each direction records the SERVER's own words: pgrust's through the
engine's `onServerLog`, PGlite's by booting once more with `debug: 1` and collecting the console
(PGlite routes `printErr` to `console.error` only when `debug` is on, and hands the text back no
other way).

## Result: both refused, symmetrically, on `USE_FLOAT8_BYVAL`

```
(h) source version(): PostgreSQL 18.3 (PGlite 0.5.5) on wasm32-unknown-linux-gnu, compiled by emcc … 32-bit
(h) REFUSED: pgrust would not boot PGlite's datadir — pgrust postmaster: the server exited with code 1
(h)   server: FATAL:  database files are incompatible with server
(h)   server: DETAIL:  The database cluster was initialized without USE_FLOAT8_BYVAL but the server was compiled with USE_FLOAT8_BYVAL.
(h)   server: HINT:  It looks like you need to recompile or initdb.
(i) REFUSED: PGlite would not boot pgrust's datadir — PGlite failed to initialize properly
(i)   server: FATAL:  database files are incompatible with server
(i)   server: DETAIL:  The database cluster was initialized with USE_FLOAT8_BYVAL but the server was compiled without USE_FLOAT8_BYVAL.
(i)   server: HINT:  It looks like you need to recompile or initdb.
```

| Direction | Artefact | Outcome | Reason |
| --- | --- | --- | --- |
| PGlite → pgrust | `pglite-source.tar.gz`, 4,596,158 bytes, dumped in 725 ms | refused before the first backend | cluster has `float8ByVal` false, server requires true |
| pgrust → PGlite | `factory-a.tar.gz`, 4,960,508 bytes, 1031 entries, dumped in 978 ms | refused during `PGlite.create` | cluster has `float8ByVal` true, server requires false |

For scale, the same tarballs restored into their OWN engine boot fine: the pgrust backup boots a
second pgrust store in 1.9–5.9 s (step (e), three rows intact), and PGlite reads its own dumps as
usual.

## What the failure proves about everything it did NOT complain about

`ReadControlFile` — and pgrust's `control_file.rs`, which mirrors it check for check — validates in
a fixed order:

1. `PG_CONTROL_VERSION`, then the control file's CRC, then `CATALOG_VERSION_NO`;
2. `MAXALIGN`, float format, `BLCKSZ`, `RELSEG_SIZE`, `XLOG_BLCKSZ`, `NAMEDATALEN`,
   `INDEX_MAX_KEYS`, `TOAST_MAX_CHUNK_SIZE`, `LOBLKSIZE`;
3. **`float8ByVal`**;
4. the WAL segment size.

Both engines reached step 3 — and the CRC in step 1 passed, which means each engine read the
other's `pg_control` as its own struct, byte for byte (pgrust asserts
`offset_of!(ControlFileData, float8ByVal) == 248`). So every field before step 3 MATCHED, on a real
cluster written by the other engine: same control version, same catalog version, same 8-byte
MAXALIGN, same float format, same 8 KiB block size, same 1 GB segment size, same 8 KiB WAL block,
same `NAMEDATALEN`, same `INDEX_MAX_KEYS`, same TOAST chunk size, same LOBLKSIZE. The two data
directories are compatible in every dimension the control file records except one.

That one is a build-time consequence of the Datum width. PGlite is a **32-bit** emscripten build —
`Datum` is a `uintptr_t`, four bytes, so a `float8` cannot be passed by value and `USE_FLOAT8_BYVAL`
is off. pgrust pins `SIZEOF_DATUM = 8` on every target (`types_spgist`), wasm32 included, so its
`float8ByVal` is true and its `check_control_file` refuses a cluster where it is not. Neither engine
is wrong; they are two builds with different Datum widths, and PostgreSQL has always refused to
share a data directory across that line.

## What this means for pgxsinkit

- **The tarball format is shared; the datadir is not.** A pgxsinkit store backup taken on either
  engine is the same kind of artefact — same tar flavour, same entry layout, same gzip rule — and
  restores into a store of the **same** engine. It is not an engine-migration path.
- **A store cannot be handed from one engine to the other by copying it.** Moving a store between
  PGlite and pgrust needs a logical dump (`pg_dump`/`COPY`), not `dumpDataDir`/`loadDataDir`. The
  wire-level `pg_dump` lane already proven here (`docs/results/2026-09-07-pg-dump-over-wire-bun.md`)
  is that path.
- **pgrust's `GOAL.md` claim is untouched by this.** An ordinary 64-bit C 18.3 binary has
  `USE_FLOAT8_BYVAL` on, exactly as pgrust does, so a pgrust datadir is what that claim says it is.
  What cannot boot it is specifically a 32-bit build — which is what PGlite is.
- **If either direction ever boots, this note is wrong.** The scenario asserts the refusal in both
  directions and by its reason, and fails loudly (`VERDICT: datadir-portability CHANGED`) if a run
  ever does anything else — a PGlite built with 8-byte Datums, or a pgrust with four, would be news.
