/**
 * Hand-written types for the vendored `broker-fs.js`: the `--fs broker` seam, where one instance's
 * WASI **file** calls leave its private copy of the packed image and land on the single repacked
 * store a coordinator worker owns.
 *
 * Ours, not pgrust's. It declares only what this repo touches. The two halves `broker-fs.js` wires
 * together — `RepackedSyncClient` and `createWasiPreview1Fs` — come from
 * `@pgxsinkit/pglite-opfs-repacked`, and this repo never calls them directly: it loads the bundle,
 * mints a doorbell and one channel per agent, and hands them on.
 *
 * That bundle is a **pre-release** build of the package (its broker and WASI adapter are in no
 * published version), copied out of a pgxsinkit checkout by `bun run sync:pgrust` and recorded in
 * `SOURCE.md`. `RepackedBundle` below is therefore the surface of a moving target, deliberately
 * kept to the four members the broker Configuration needs.
 */

/** A `RepackedChannel` as it crosses an agent boundary. */
export interface RepackedChannelTransfer {
  readonly id: number;
  readonly channel: SharedArrayBuffer;
  readonly doorbell: SharedArrayBuffer;
}

/**
 * The shared word every blocked agent waits on, and the only way to reach the coordinator once it
 * has entered its blocking serve loop: it is parked in `Atomics.wait` and no `postMessage` will be
 * delivered to it again.
 */
export interface RepackedDoorbell {
  readonly buffer: SharedArrayBuffer;
  /** Ask the coordinator's loop to return. */
  requestStop(): void;
}

/** One request channel. The protocol is one request in flight per channel, so agents never share. */
export interface RepackedChannel {
  readonly id: number;
  transfer(): RepackedChannelTransfer;
}

/** The slice of `@pgxsinkit/pglite-opfs-repacked` the broker Configuration uses. */
export interface RepackedBundle {
  readonly RepackedDoorbell: { create(): RepackedDoorbell };
  readonly RepackedChannel: {
    create(options: { readonly id: number; readonly doorbell: RepackedDoorbell }): RepackedChannel;
  };
}

/** Where the bundle sits relative to the host files: `./vendor/pglite-opfs-repacked.js`. */
export declare const VENDOR_BUNDLE_PATH: string;

/** How long a guest waits for a coordinator that has gone away before failing rather than parking. */
export declare const DEFAULT_REQUEST_TIMEOUT_MS: number;

/** The bundle URL, resolved from the module URL of whatever is asking. */
export declare function repackedBundleUrl(base: string | URL): string;

/**
 * Load the library bundle.
 *
 * A function rather than a static import because the URL is a run-time decision, and because a
 * worker must be able to load it before it builds a host.
 */
export declare function loadRepackedBundle(url: string): Promise<RepackedBundle>;
