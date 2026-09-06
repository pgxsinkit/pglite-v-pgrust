/**
 * Hand-written types for the vendored `storage-worker.js`: the dedicated storage coordinator of the
 * `--fs broker` lane, which owns one repacked store and answers every instance's file calls over a
 * `SharedArrayBuffer` channel.
 *
 * Ours, not pgrust's. Like `thread-worker.js` it is a **worker entry point** and exports nothing;
 * this file is here so `src/vendor/pgrust/` type-checks as a whole under `allowJs: false`.
 *
 * Its contract, in the order it matters: it is booted with `{ kind: "boot", bundleUrl, image,
 * manifest, channels, doorbell, options }`, answers `storage-ready` once the store is open and the
 * datadir seeded, and then enters a blocking serve loop from which no `postMessage` can reach it —
 * only `doorbell.requestStop()`, after which it answers `storage-stopped`. A failure comes back as
 * `storage-error` carrying the store error's own class name.
 */

export {};
