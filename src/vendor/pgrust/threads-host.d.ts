/**
 * Hand-written types for the vendored `threads-host.js`: the JS host for pgrust's
 * `wasm32-wasip1-threads` build.
 *
 * Ours, not pgrust's. Three things make this host different from the single-session one
 * (`pgrust-wasi.js` + `wiresession.js`), and all three show up in the surface below:
 *
 * 1. **Memory is imported and shared.** The target spec pins `--import-memory --shared-memory`, so
 *    the host creates one `WebAssembly.Memory` and hands the same object to every instance.
 * 2. **`wasi` `thread-spawn` is the host's job**, answered out of a worker pool that must already
 *    be instantiated — a spawn handler is microseconds from a futex park and may not await.
 * 3. **No JSPI.** The guest's blocking `read(0)` blocks a Worker in `Atomics.wait`, which is what a
 *    Worker is allowed to do.
 *
 * This module is loaded at run time from `public/pgrust/host/`, never bundled, so these types are
 * reached with `typeof import("…/threads-host.js")` rather than by importing values from here.
 */

import type { SabPipe, SabPipeDescriptor } from "./sab-pipe.js";

/** 64 KiB, the wasm page size. */
export declare const PAGE_BYTES: number;
/** Must equal `wasm/wasm-build.sh`'s `PGRUST_WASM_INITIAL_MEMORY`: 256 MiB. */
export declare const DEFAULT_INITIAL_BYTES: number;
/** Must equal `PGRUST_WASM_MAX_MEMORY`: 4 GiB, the wasm32 ceiling. */
export declare const DEFAULT_MAX_BYTES: number;
/** Whether this host is running under Node rather than in a browser. */
export declare const IS_NODE: boolean;

/**
 * The one shared memory every instance imports.
 *
 * Its limits must match the module's declared limits, which is why the defaults are pinned to the
 * build script's own numbers rather than derived.
 */
export declare function createSharedMemory(options?: {
  readonly initialBytes?: number;
  readonly maxBytes?: number;
}): WebAssembly.Memory;

/** One import the module asks for. */
export interface ImportDescriptor {
  readonly module: string;
  readonly name: string;
}

/** What a module wants from the host: its memory import, its thread-spawn import, and the rest. */
export interface ModuleImports {
  readonly all: readonly ImportDescriptor[];
  readonly memory: ImportDescriptor;
  readonly threadSpawn: ImportDescriptor | null;
  readonly modules: readonly string[];
}

/** Read a module's imports, so the memory import's real module/name is found rather than assumed. */
export declare function inspectImports(wasmModule: WebAssembly.Module): ModuleImports;

/** The host-owned fd registry, as descriptors that cross an agent boundary. */
export type PipeDescriptors = Readonly<
  Record<string, { readonly in?: SabPipeDescriptor; readonly out?: SabPipeDescriptor }>
>;

export declare class PipeRegistry {
  static from(descriptors: PipeDescriptors): PipeRegistry;
  register(fd: number, ends: { readonly in?: SabPipe; readonly out?: SabPipe }): void;
  descriptors(): PipeDescriptors;
}

/** `PGRUST_HOSTPIPES_LISTEN_FD` — the postmaster lane's listener; unused by the wire lanes. */
export declare const HOSTPIPES_LISTEN_FD: number;
/** `PGRUST_HOSTPIPES_WAKE_FD` — the postmaster lane's wake channel; unused by the wire lanes. */
export declare const HOSTPIPES_WAKE_FD: number;
export declare function sessionFds(k: number): { readonly inFd: number; readonly outFd: number };
/** Where session wake fds start, counted downward from the postmaster's own so both windows are disjoint. */
export declare const HOSTPIPES_SESSION_WAKE_FD_BASE: number;
/**
 * Session `k`'s wake fd — the fd a blocked backend adds to its own `poll`, so a `SetLatch` from
 * another backend (an async NOTIFY, a cancel, a fast shutdown) ends the block at once instead of at
 * the end of the guest's 100 ms interrupt poll. Its number travels in the connection record.
 */
export declare function sessionWakeFd(k: number): number;

/** Where the process instance's own file descriptors start. */
export declare const PROCESS_FD_BASE: number;
export declare const SLOT_FD_STRIDE: number;
export declare function slotFdBase(slot: number): number;

/**
 * Create a worker for a module URL, in whichever host this is.
 *
 * In a browser this is `new Worker(url, { type: "module", name })`, with `url` computed at run
 * time — which is exactly why the vendored host is served as a static asset instead of bundled.
 */
export declare function makeWorker(url: string | URL, options?: { readonly name?: string }): Worker;

/** Subscribe to a worker's messages, unwrapping the browser's `MessageEvent` for you. */
export declare function onWorkerMessage(worker: Worker, callback: (message: unknown) => void): void;

/** Subscribe to a worker's errors. */
export declare function onWorkerError(worker: Worker, callback: (error: Error) => void): void;

/**
 * A channel a spawned thread reports on directly.
 *
 * From the moment the guest joins, the process worker's JS thread is parked in a futex and will
 * relay nothing, so every pool slot gets its own port straight to the driver.
 */
export declare function newMessageChannel(): MessageChannel;

/** Subscribe to a port's messages and start it. */
export declare function onPortMessage(port: MessagePort, callback: (message: unknown) => void): void;

/** `./thread-worker.js` resolved against `base`; `base` must be an absolute URL. */
export declare function threadWorkerUrl(base: string | URL): URL;

/** `./storage-worker.js` resolved against `base`; `base` must be an absolute URL. */
export declare function storageWorkerUrl(base: string | URL): URL;

export { SabPipe } from "./sab-pipe.js";
export { GuestExit } from "./pgrust-wasi.js";
