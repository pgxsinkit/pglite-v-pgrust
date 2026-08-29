/**
 * Hand-written types for the vendored `wiresession.js`: one long-lived `postgres --stdio-wire` wasm
 * instance spoken to in pgwire frames.
 *
 * Ours, not pgrust's. The session needs JSPI (`WebAssembly.Suspending` on `fd_read` plus
 * `WebAssembly.promising` on `_start`) — see `jspiSupported()`.
 */

import type { Vfs } from "./pgrust-wasi.js";
import type { WireMessage } from "./wire.js";

export interface WireSessionOptions {
  readonly wasmModule: WebAssembly.Module;
  /** The datadir VFS. The session mutates it for the whole of its life. */
  readonly vfs: Vfs;
  /** Defaults to `defaultWireArgv()`. */
  readonly argv?: readonly string[];
  /** Defaults to the host's own environment block (USER, PGRUST_* …). */
  readonly env?: Readonly<Record<string, string>>;
  /** Raw guest stderr chunks; a multi-byte character may straddle two chunks. */
  readonly onStderr?: (bytes: Uint8Array) => void;
  /** Optional tap on every backend message, called before it is collected. */
  readonly onMessage?: (t: string, body: Uint8Array) => void;
}

export interface WireStartOptions {
  readonly user?: string;
  readonly database?: string;
}

/** Thrown when the guest has exited: the session cannot be used again. */
export declare class WireSessionDead extends Error {}

export declare class WireSession {
  constructor(options: WireSessionOptions);
  /** True once the guest has exited, for any reason. */
  readonly dead: boolean;
  /** The guest exit code; null until it exits, -1 when it failed other than by exiting. */
  readonly exitCode: number | null;
  /** Run the startup handshake; resolves with the messages up to the first ReadyForQuery. */
  start(options?: WireStartOptions): Promise<WireMessage[]>;
  /**
   * One simple-query cycle: `Q(sql)` through ReadyForQuery. Multi-statement SQL is fine. A backend
   * error arrives as an `E` message in the returned list — it is *not* thrown, and the session
   * stays alive. Throws `WireSessionDead` if the guest has exited, and a plain `Error` if a query
   * is already in flight.
   */
  query(sql: string): Promise<WireMessage[]>;
  /** Send Terminate, close stdin, and await the guest's clean exit. Resolves with the exit code. */
  terminate(): Promise<number | null>;
  /** Bytes received after the last complete message; 0 after a clean Terminate. */
  leftoverBytes(): number;
}

/** Whether this engine has JS Promise Integration, without which the wire session cannot run. */
export declare function jspiSupported(): boolean;

/** `postgres --stdio-wire` argv with the same engine GUCs the pgrust demo uses. */
export declare function defaultWireArgv(extraGucs?: readonly string[]): string[];

export { canonMessage, parseMessage } from "./wire.js";
