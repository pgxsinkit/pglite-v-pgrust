# Four files, not four thousand: a prepared store against a datadir tarball

> **2026-09-24: both browser legs ran in an off-the-record context** (`browser.newContext()`), where
> Chromium keeps OPFS in memory in the browser process, so the "265.9 MiB written into OPFS in
> 0.54 s" and both legs' OPFS time went to that memory, not to disk. `probe:prepared-store` now uses
> an on-disk profile (`--ephemeral-context` for the old one) and has not been re-run — see
> [2026-09-24, the persistent context](2026-09-24-persistent-context.md). No number here was
> changed.

- Date: 2026-09-07
- Runtime: bun 1.4.2 on linux 7.0.0-30-generic (x64, 11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz)
- Browser: Chromium 149.0.7827.55 (Playwright's `chromium` channel, headless)
- Engines: pgrust `d13d781fb9` (`PostmasterMain` over host pipes, wasm32-wasip1-threads) and `@electric-sql/pglite` npm:@pgxsinkit/pglite@0.5.5-pgx.3, both on the `opfs-repacked` store (format version 2, limits profile 1, 8192-byte extents)
- Driver: `bun run probe:prepared-store --target-mib 250`
- Page: @pgxsinkit/pglite 0.5.5-pgx.3 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust d13d781fb9 | wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36

## The question

Shipping a ready-made Postgres to a browser means shipping a data directory, and the way that is done today is a tarball of the directory itself — a tree of a thousand files and up, each of which has to be created through the filesystem it is being restored INTO. A repacked store is not a directory: it is **four files**, and its format lives above its port, so the four files a Node host wrote can be written into a browser's OPFS and opened as the same store. Nothing is replayed and nothing is converted. How much of the wall time between *the bytes arrived* and *the database answered* does that remove?

## Method

One dataset, built twice under bun, restored twice in a real browser. Both legs fetch their artefact over HTTP from the same local static server and are timed from the moment the fetch starts to the moment the first query answers.

- **Prepared store.** A pgrust postmaster on the **file port** — a directory on this machine — fills `prepared_payload` until `/pgdata` passes 250 MiB, runs `CHECKPOINT`, and shuts down (a real Postgres shutdown, ending in its shutdown checkpoint). `prepareStoreTar` then reopens those four files directly, `repack()`s the arena, syncs, closes, and writes `pgrust.repacked.tar.gz` — the four files plus a `manifest.json` carrying the store's format identity, the pgrust commit and a SHA-256 per file. In the browser a dedicated worker gunzips it, untars it, checks every digest, writes the four files into the OPFS store directory, and the coordinator then opens that directory with `reset: false`.
- **PGlite datadir tarball (the reference).** The same rows built in PGlite memory under bun and dumped with `dumpDataDir("gzip")` — an ordinary datadir tarball. In the browser it is handed to the `opfs-repacked` store's PGlite factory as `loadDataDir`, which untars it file by file into the store before the database boots.

Both legs then run `SELECT count(*)` — whose value must equal what was written, or the leg
fails — and `SELECT sum(length(payload))` over the whole payload column.

## The dataset

`prepared_payload` holds **600000** rows of a 100-character payload column. The pgrust datadir (`/pgdata`) came to **260.5 MiB in 1013 entries**; filling it took 12.25 s, its `CHECKPOINT` 0.13 s, and the server's own shutdown 0.46 s.

## Sealing the store (bun, file port)

| store file | before repack | after repack |
| --- | --- | --- |
| `arena.bin` | 265.0 MiB | 265.0 MiB |
| `metadata-a.bin` | 0.5 MiB | 0.5 MiB |
| `metadata-b.bin` | 0.0 MiB | 0.4 MiB |
| `activation.bin` | 0.0 MiB | 0.0 MiB |
| **four files** | **265.5 MiB** | **265.9 MiB** |

The repack took 0.02 s and the strict sync after it 0.00 s; the arena the store reports holding afterwards is 265.0 MiB. The tarball is **265.9 MiB raw** and **110.2 MiB gzipped** (tar 0.13 s, gzip 5.54 s). Preparing the whole artefact took **6.14 s**.

Store format: version 2, limits profile 1, 8192-byte extents. pgrust asset commit `d13d781fb9`.

The reference artefact — the same 600000 rows built in PGlite memory and dumped with `dumpDataDir("gzip")` — is **99.5 MiB gzipped** (build 6.48 s, dump 6.08 s).

## In the browser

| pipeline | artefact | download (s, loopback) | restore (s) | boot (s) | first query (s) | after download (s) | total (s) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| prepared store (4 files -> OPFS, pgrust postmaster) | 110.2 MiB | 0.15 | 2.42 | 1.34 | 1.76 | **6.98** | 7.13 |
| PGlite datadir tarball (loadDataDir -> OPFS repacked) | 99.5 MiB | 0.15 | — | 4.90 | 3.36 | **8.54** | 8.69 |

The prepared leg's restore breaks down as gunzip 1.21 s, untar 0.13 s, verify (sha256 over all four files) 0.54 s, and 265.9 MiB written into OPFS in 0.54 s. The reference leg has no restore column of its own: PGlite's `loadDataDir` happens inside the create call and there is no honest seam to time it at, so the whole of it is that leg's boot.

The download column is a loopback copy off a Bun static server on 127.0.0.1, reported separately because it says nothing about a real network. The column that answers the question is **after download**.

## What the numbers say

The same 260.5 MiB datadir is answering queries **6.98 s** after its bytes arrive through four files, against **8.54 s** through the datadir tarball: 1.2x. Of the prepared leg's time, 2.42 s is turning the tarball into a store (most of it gunzip and SHA-256, not I/O — the four OPFS writes themselves are 0.54 s) and 1.34 s is the postmaster's own boot, which no restore format can remove.

**Read the reference leg's cost against the datadir's SHAPE, not just its size.** This datadir is 260.5 MiB in **1013 entries** — one big table and its index, plus the catalogs — so `loadDataDir` creates about a thousand files, not tens of thousands. That is the cheap end of its range, and it is why the reference here is seconds rather than the minute-plus a datadir of many small relations costs: the per-file cost is what the tarball path pays, and this dataset does not have many files. The prepared store's cost, by contrast, is four writes whatever the datadir holds — its restore column is a function of the arena's SIZE alone, and the gap widens with every additional file on the other side.
