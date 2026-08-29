/**
 * Hand-written types for the vendored `pgrust-wasi.js` (the WASI host).
 *
 * Ours, not pgrust's. It declares only what this repo touches — the in-memory VFS handed to a
 * `WireSession`, and the exit signal the session start promise rejects with.
 */

/** One packed file in the datadir image: a byte range of `vfs.img`. */
export interface VfsManifestFile {
  readonly path: string;
  readonly off: number;
  readonly len: number;
  readonly mode?: number;
  readonly mtime?: number;
}

/** `vfs.json` as `pack-vfs.mjs` emits it, over the single concatenated `vfs.img` byte image. */
export interface VfsManifest {
  readonly dirs: readonly string[];
  readonly files: readonly VfsManifestFile[];
}

/**
 * The in-memory WASI filesystem holding the Postgres data directory.
 *
 * The VFS takes ownership of `image`: guest writes mutate subarrays of it, so pass a copy when the
 * image must survive for a later instance.
 */
export declare class Vfs {
  constructor(image: Uint8Array, manifest: VfsManifest);
  /** Remove a path if present; a no-op when it is absent. */
  unlink(path: string): void;
}

/** Thrown by the WASI host when the guest calls `proc_exit`. */
export declare class GuestExit extends Error {
  constructor(code: number);
  readonly code: number;
}
