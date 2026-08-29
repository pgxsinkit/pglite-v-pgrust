# Prototype `opfs-repacked` as a pgrust VFS

Status: backlog (recorded 2026-08-29)

## Why

Phase 1 of pglite-v-pgrust is memory-only: pgrust's wasm build runs on an in-memory WASI VFS
(`pgrust/wasm/pgrust-wasi.js` `Vfs`), and its only persistence is a whole-datadir OPFS snapshot
taken after each statement. That is not comparable to PGlite's page-level persistent filesystems,
so the persistent Configurations (the interesting ones for an offline-first product) cannot be
benchmarked until pgrust has a real VFS.

`@pgxsinkit/pglite-opfs-repacked` (pgxsinkit ADR-0048/0049) packs a whole Postgres data directory
into a constant four OPFS files behind a narrow port (`RepackedPort`) with a pure core state machine
(`RepackedVfs`) that never imports browser OPFS types. The core is engine-agnostic; only the PGlite
`Filesystem` adapter (`OpfsRepackedFS`) is Emscripten-shaped.

## What

Prototype a second adapter that exposes the `RepackedVfs` core through pgrust's WASI host
filesystem (the `Vfs` object `makeWasi()` reads/writes through — `fd_read`, `fd_write`, `fd_seek`,
`path_open`, `fd_filestat_get`, `fd_sync`, `unlink`, …) so that the pgrust `wire` session boots a
datadir that lives in the four repacked OPFS files instead of a heap image.

## Questions the prototype must answer

- Sync-vs-async: `RepackedVfs` host syncs are awaited (`await` at strict/relaxed boundaries). pgrust's
  WASI imports are synchronous except the single JSPI suspension point (`fd_read` on stdin). Can
  `fd_sync`/`fd_write` become additional `WebAssembly.Suspending` imports, or must the adapter
  buffer and flush on the existing suspension point?
- Boot path: the initial datadir comes from the packed `vfs.img`/`vfs.json` template. Does the
  prototype seed the four repacked files from the image on first boot (recreate-only, per
  ADR-0048), and how is "fresh datadir" (Reset) expressed?
- Durability mapping: pgrust's shutdown checkpoint and WAL writes vs `opfs-repacked`'s
  `relaxed`/`strict` boundaries — which pgrust calls map to a "host sync"?
- Worker topology: `opfs-repacked` requires `createSyncAccessHandle()` to succeed (dedicated worker
  on Chromium/Firefox, SharedWorker on real Safari). pgrust's `worker.js` is a dedicated worker
  already; confirm the JSPI + sync-access-handle combination works in the same worker.

## Done when

- A pgrust Configuration "pgrust OPFS repacked" (relaxed and strict) can run both phase-1 Suites
  end to end in Chrome and Firefox, surviving a page reload with data intact.
- Timings are recorded alongside the PGlite `opfs-repacked` columns using the same SQL.
- Findings (including "not feasible because …") are written up in `docs/` and the adapter, if it
  survives, is proposed upstream to pgxsinkit as a sibling package rather than kept here.

## Out of scope

- Upstreaming into pgrust itself.
- Supporting pgrust `single` mode (per-statement boot) on the repacked store.
