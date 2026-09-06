# Vendored from pgrust

Copied byte-verbatim by `bun run sync:pgrust`. **Do not edit these files by hand** — re-run the
script against an updated pgrust checkout instead. They are excluded from oxlint and oxfmt so
they stay identical to their source.

- Commit: `08a306441f0b0649e23888c32f06300ff2de23cc`
- Version: `08a306441f`
- Source: `/home/anton/dev/tmp/pgrust`
- Working tree: clean
- Synced: 2026-09-06T10:20:52.287Z

## Files

- `wasm/pgrust-wasi.js`
- `wasm/wiresession.js`
- `wasm/wire.js`
- `wasm/threads-host.js`
- `wasm/thread-worker.js`
- `wasm/sab-pipe.js`
- `wasm/broker-fs.js`
- `wasm/storage-worker.js`
- `LICENSE`
- `NOTICE`

pgrust is AGPL-3.0-only; its `LICENSE` and `NOTICE` are vendored alongside the source.
<!-- store-bundle:begin -->
## Pre-release store bundle in `public/pgrust/host/`

Copied by `bun run sync:pgrust` from a **pgxsinkit checkout**, not from npm. The
`pgrust Threads Memory (broker, pre-release store)` column is the only thing that loads it, and
it is a gitignored build output; only this record of it is committed.

- Package: `@pgxsinkit/pglite-opfs-repacked` (manifest version `0.0.0`)
- Commit: `de10f883516226a6f7c6f24eb46ca39b25d6b51a`
- Source: `/home/anton/dev/pgxsinkit/pgxsinkit`
- Working tree: clean
- Copied to: `public/pgrust/host/vendor/pglite-opfs-repacked.js` (986176 bytes)
- Copied: 2026-09-06T10:20:52.318Z

The `RepackedSyncBroker` + `createWasiPreview1Fs` pair this column needs is **not** in any
published version of the package, so no npm release corresponds to these bytes. The two OPFS
repacked columns are unaffected: they run the published dependency in `package.json`.
<!-- store-bundle:end -->

<!-- pgrust-assets:begin -->
## Binary assets in `public/pgrust/`

Copied by `bun run sync:pgrust` from a local pgrust checkout. They are gitignored build
outputs; only this record of them is committed.

- Source: `/home/anton/dev/tmp/pgrust`
- Version: `08a306441f`
- Copied: 2026-09-06T10:20:52.310Z

pgrust is AGPL-3.0-only; these binaries were built locally from the checkout named above.
<!-- pgrust-assets:end -->
