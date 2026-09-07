# Vendored from pgrust

Copied byte-verbatim by `bun run sync:pgrust`. **Do not edit these files by hand** — re-run the
script against an updated pgrust checkout instead. They are excluded from oxlint and oxfmt so
they stay identical to their source.

- Commit: `d74e9744265bd647dcd47f1c34c9c79ee480a20d`
- Version: `d74e974426`
- Source: `/home/anton/dev/tmp/pgrust`
- Working tree: clean
- Synced: 2026-09-07T10:22:46.031Z

## Files

- `wasm/pgrust-wasi.js`
- `wasm/wiresession.js`
- `wasm/wire.js`
- `wasm/threads-host.js`
- `wasm/thread-worker.js`
- `wasm/thread-worker.mjs`
- `wasm/storage-worker.mjs`
- `wasm/sab-pipe.js`
- `wasm/broker-fs.js`
- `wasm/storage-worker.js`
- `LICENSE`
- `NOTICE`

pgrust is AGPL-3.0-only; its `LICENSE` and `NOTICE` are vendored alongside the source.
<!-- store-bundle:begin -->
## Pre-release store bundle in `public/pgrust/host/`

Written by `bun run sync:pgrust`, from a published release of this repo or from a **pgxsinkit
checkout** — not from npm. The four `pgrust Threads` and `pgrust Postmaster` broker columns are
the only things that load it — the Memory ones on the store's memory port, the OPFS repacked
ones on its OPFS port — and it is a gitignored build output; only this record of it is
committed.

- Package: `@pgxsinkit/pglite-opfs-repacked` (manifest version `0.0.0`)
- Repository: [`feat/repacked-sync-broker`](https://github.com/pgxsinkit/pgxsinkit/tree/feat/repacked-sync-broker)
- Commit: [`5e5d168a991546655b09ce7638c36c5bb5c4408e`](https://github.com/pgxsinkit/pgxsinkit/commit/5e5d168a991546655b09ce7638c36c5bb5c4408e)
- Licence: MIT
- Built with: `bun run build:public-packages` -> `packages/pglite-opfs-repacked/dist/browser-bundle.js`
- Installed at: `public/pgrust/host/vendor/pglite-opfs-repacked.js` (987191 bytes)

The `RepackedSyncBroker` + `createWasiPreview1Fs` pair those columns need is **not** in any
published version of the package, so no npm release corresponds to these bytes. The two
`PGlite OPFS repacked` columns are unaffected: they run the published dependency in
`package.json`.
<!-- store-bundle:end -->

<!-- pgrust-assets:begin -->
## Binary assets in `public/pgrust/`

Downloaded by `bun run sync:pgrust --release pgrust-assets/d74e9744` — **not** from the checkout above.
They are gitignored build outputs; only this record of them is committed.

- Release: [`pgrust-assets/d74e9744`](https://github.com/pgxsinkit/pglite-v-pgrust/releases/tag/pgrust-assets/d74e9744)
- pgrust commit: [`d74e9744265bd647dcd47f1c34c9c79ee480a20d`](https://github.com/pgxsinkit/pgrust/commit/d74e9744265bd647dcd47f1c34c9c79ee480a20d)
- Branch: [`spike/wasip1-threads`](https://github.com/pgxsinkit/pgrust/tree/spike/wasip1-threads)
- Upstream base: `438c8c420b96b23ca61927ba57e608839f86e935` (https://github.com/malisper/pgrust)
- Build: `wasm-release` / `wasm32-wasip1` / `nightly-2026-07-17`
- Threads build: `wasm-release` / `wasm32-wasip1-threads` (postgres-threads.wasm)
- VFS: `initdb` from PostgreSQL 18, built 2026-09-07T10:22:46.051Z
- Downloaded: 2026-09-07T10:23:24.241Z
- Fetched from: `file:///home/anton/dev/tmp/pglite-v-pgrust/tmp/pgrust-assets/pgrust-assets-d74e9744` (PGLITE_V_PGRUST_RELEASE_BASE_URL)

pgrust is AGPL-3.0-only. The complete corresponding source for these binaries is the commit
linked above; the release's `manifest.json` records the same thing in machine-readable form.
<!-- pgrust-assets:end -->
