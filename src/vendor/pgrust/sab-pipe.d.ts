/**
 * Hand-written types for the vendored `sab-pipe.js`: a single-producer/single-consumer byte ring
 * over a `SharedArrayBuffer`, which is what the `wasm32-wasip1-threads` guest's stdin and stdout
 * ride on.
 *
 * Ours, not pgrust's. `sab-pipe.js` is copied byte-verbatim by `bun run sync:pgrust`, and this
 * declaration is what lets `allowJs: false` see it. It describes only the surface this repo uses.
 *
 * The blocking half of the API (`readInto`, `waitReadable`, `waitWritable`, and `write` with
 * `block: true`) parks the calling agent in `Atomics.wait` and belongs to the guest's own workers.
 * The engine worker drives the pipes from the asynchronous half — `readAsync`, and `write` with
 * `block: false` — because a driver that blocked would never drain the other direction.
 */

/** A `SabPipe` as it crosses an agent boundary: `SharedArrayBuffer` is cloned by reference. */
export interface SabPipeDescriptor {
  readonly sab: SharedArrayBuffer;
  readonly capacity: number;
}

export declare class SabPipe {
  /** `capacity` must be a power of two. */
  static create(capacity?: number): SabPipe;
  /** Rehydrate the same ring in another agent from a transferred descriptor. */
  static from(descriptor: SabPipeDescriptor): SabPipe;

  readonly capacity: number;
  /** True once the producer has said it will never write again. */
  readonly closed: boolean;

  descriptor(): SabPipeDescriptor;
  /** Bytes produced but not yet consumed. */
  available(): number;
  /** Bytes that fit right now. */
  room(): number;
  /** Announce EOF to the consumer. */
  close(): void;
  /**
   * Enqueue bytes, returning how many were taken. With `block: false` a full ring short-writes
   * rather than parking, which is the only form an agent that must stay responsive may use.
   */
  write(bytes: Uint8Array, options?: { readonly block?: boolean }): number;
  /** Consumer side, non-blocking: -1 would block, 0 EOF, >0 the byte count. */
  readIntoNow(target: Uint8Array, maxLength: number): number;
  /** Consumer side for an agent that must not block; resolves with the byte count (0 at EOF). */
  readAsync(target: Uint8Array, maxLength: number): Promise<number>;
  /** One chunk, or null at EOF. */
  readChunk(maxLength?: number): Promise<Uint8Array | null>;
}

export default SabPipe;
