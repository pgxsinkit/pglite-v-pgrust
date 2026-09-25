# Vendored from pgrust

Copied byte-verbatim by `bun run sync:pgrust`. **Do not edit these files by hand** — re-run the
script against an updated pgrust checkout instead. They are excluded from oxlint and oxfmt so
they stay identical to their source.

- Commit: `6ed7984bf08ac1f2a1622083df2a6bad9117cec8`
- Version: `6ed7984bf0`
- Source: `/home/anton/dev/tmp/pgrust`
- Working tree: clean
- Synced: 2026-09-25T15:00:05.098Z

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
- Repository: [`develop`](https://github.com/pgxsinkit/pgxsinkit/tree/develop)
- Commit: [`f4777b4e1f80c17fdb95f6db1e0973ac1753fc7f`](https://github.com/pgxsinkit/pgxsinkit/commit/f4777b4e1f80c17fdb95f6db1e0973ac1753fc7f)
- Licence: MIT
- Built with: `bun run build:public-packages` -> `packages/pglite-opfs-repacked/dist/browser-bundle.js`
- Installed at: `public/pgrust/host/vendor/pglite-opfs-repacked.js` (1010981 bytes)

The `RepackedSyncBroker` + `createWasiPreview1Fs` pair those columns need is **not** in any
published version of the package, so no npm release corresponds to these bytes. The two
`PGlite OPFS repacked` columns are unaffected: they run the published dependency in
`package.json`.
<!-- store-bundle:end -->

<!-- pgrust-assets:begin -->
## Binary assets in `public/pgrust/`

Copied by `bun run sync:pgrust` from a local pgrust checkout. They are gitignored build
outputs; only this record of them is committed.

- Source: `/home/anton/dev/tmp/pgrust`
- Version: `6ed7984bf0`
- Copied: 2026-09-25T15:00:05.117Z

pgrust is AGPL-3.0-only; these binaries were built locally from the checkout named above.
<!-- pgrust-assets:end -->
