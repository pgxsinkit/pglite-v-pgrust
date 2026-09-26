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
  readonly payloadBytes: number;
  transfer(): RepackedChannelTransfer;
}

/** What a `stat`/`lstat`/`fstat` answers with. A symlink is reported as a file: the wire has two kinds. */
export interface RepackedStat {
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly size: bigint;
  readonly atimeMs: bigint;
  readonly mtimeMs: bigint;
  readonly ctimeMs: bigint;
}

/** Every broker answer carries an errno; 0 is success and anything else is a WASI error number. */
export interface RepackedErrno {
  readonly errno: number;
}

/**
 * The BLOCKING half of the broker protocol, as the WASI adapter uses it — and as this repo's own
 * host uses it, on a channel of its own, to read and write the coordinator's store directly.
 *
 * Every method parks the calling agent in `Atomics.wait` until the coordinator answers, so it may
 * only be called where blocking is allowed (bun's main thread, and any Worker). `fsync()` with NO
 * fd is the store-wide `strictSync()`: the broker ignores the fd and syncs the whole store.
 */
export interface RepackedSyncClient {
  /** The largest payload one request may carry; `read`/`write` chunk themselves against it. */
  readonly maxTransferBytes: number;
  open(path: string, flags: number, mode?: number): RepackedErrno & { readonly fd: number };
  close(fd: number): RepackedErrno;
  read(fd: number, length: number, position?: bigint): RepackedErrno & { readonly bytes: Uint8Array };
  write(fd: number, bytes: Uint8Array, position?: bigint): RepackedErrno & { readonly count: number };
  /** No fd: a store-wide `strictSync()`. With one: the same sync, after checking the fd is this client's. */
  fsync(fd?: number): RepackedErrno;
  stat(path: string): RepackedErrno & { readonly stat?: RepackedStat };
  lstat(path: string): RepackedErrno & { readonly stat?: RepackedStat };
  readdir(path: string): RepackedErrno & { readonly entries: readonly string[] };
  mkdir(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): RepackedErrno;
  rmdir(path: string): RepackedErrno;
  unlink(path: string): RepackedErrno;
  rename(oldPath: string, newPath: string): RepackedErrno;
}

/**
 * One `RepackedPort`: the four owned files, wherever they live. The bundle exports three (memory,
 * OPFS, file) and nothing here distinguishes them — the store's format lives ABOVE the port, which
 * is the whole reason a store built on one opens on another.
 */
export interface RepackedPort {
  readonly __repackedPort?: never;
}

/** The store itself, as the prepared-store lane drives it directly — no coordinator, no broker. */
export interface RepackedVfs {
  /**
   * Compact the arena: the store's own garbage collection, which is what turns a datadir that was
   * WRITTEN incrementally into four files whose size is the data rather than its history.
   */
  repack(reason?: string): void;
  /** Arena before metadata, and the store's health check inside it. */
  strictSync(): void;
  close(): void;
  metrics(): { readonly totalExtents: bigint; readonly generation: bigint; readonly repackCount: number };
}

/** The slice of `@pgxsinkit/pglite-opfs-repacked` the broker Configuration uses. */
export interface RepackedBundle {
  readonly RepackedDoorbell: { create(): RepackedDoorbell };
  readonly RepackedChannel: {
    create(options: {
      readonly id: number;
      readonly doorbell: RepackedDoorbell;
      /** The channel's payload; the library's own default is 64 KiB. */
      readonly payloadBytes?: number;
    }): RepackedChannel;
    attach(transfer: RepackedChannelTransfer): RepackedChannel;
  };
  readonly RepackedSyncClient: new (
    channel: RepackedChannel,
    options?: { readonly requestTimeoutMs?: number },
  ) => RepackedSyncClient;
  /** An errno's name (`ENOENT`), or `errno <n>` when the library does not know it. */
  readonly errnoName: (code: number) => string;
  /** The WASI error numbers by name; only `NOENT` is read here. */
  readonly WASI_ERRNO: Readonly<Record<string, number>>;
  readonly O_RDONLY: number;
  readonly O_WRONLY: number;
  readonly O_CREAT: number;
  readonly O_TRUNC: number;
  /**
   * The four owned files in an ordinary DIRECTORY, over `node:fs`. Node/bun only — the bundle
   * reaches `node:fs` through a dynamic import precisely so this member can exist in a browser
   * build without breaking it, and constructing one in a browser is what fails.
   */
  readonly FileRepackedPort: new (directory: string) => RepackedPort;
  /** Open the store on a port directly, with no coordinator worker and no broker in between. */
  readonly RepackedVfs: {
    open(port: RepackedPort, options?: { readonly extentSize?: number }): Promise<RepackedVfs>;
  };
}

/** Where the bundle sits relative to the host files: `./vendor/pglite-opfs-repacked.js`. */
export declare const VENDOR_BUNDLE_PATH: string;

/** How long a guest waits for a coordinator that has gone away before failing rather than parking. */
export declare const DEFAULT_REQUEST_TIMEOUT_MS: number;

/**
 * The broker's gather option: one broker write per `fd_pwrite` instead of one per iovec. A host that
 * turns it on (`brokerGather: true` to the process worker, which hands it to every pool slot) also
 * mints its guest channels at `GATHER_PAYLOAD_BYTES`: 256 KiB of data per request
 * (`GATHER_TRANSFER_BYTES`) plus room for the request's own fields, where the library's default is
 * 64 KiB of payload in all.
 */
export declare const GATHER_TRANSFER_BYTES: number;
export declare const GATHER_PAYLOAD_BYTES: number;

/** The bundle URL, resolved from the module URL of whatever is asking. */
export declare function repackedBundleUrl(base: string | URL): string;

/**
 * Load the library bundle.
 *
 * A function rather than a static import because the URL is a run-time decision, and because a
 * worker must be able to load it before it builds a host.
 */
export declare function loadRepackedBundle(url: string): Promise<RepackedBundle>;
