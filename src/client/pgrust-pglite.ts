/**
 * `PgrustPGlite` — PGlite's own client class, over a pgrust backend.
 *
 * **The claim this file exists to make.** Everything a pgxsinkit client asks of PGlite —
 * `query`/`sql`/`exec`/`transaction`, the type parser and serializer registries, `describeQuery`,
 * the notification map the `live` extension listens on — lives in `BasePGlite`, above a handful of
 * abstract transport hooks. `PGlite` implements those hooks against a wasm Postgres it runs in
 * process. This class implements the same hooks against a **pgwire session on a pgrust postmaster
 * backend**, reached over the two `SharedArrayBuffer` rings the vendored host owns. Nothing above
 * the hooks is re-implemented, overridden or forked: the client is PGlite's, verbatim, and so is
 * every extension that sits on it (`live` is loaded here unmodified).
 *
 * **The one hard part: framing.** `PGlite.execProtocolRawSync` hands a message to a wasm Postgres
 * and gets back whatever that call produced, synchronously — there is no question of when the
 * response is finished. On a wire there is. `BasePGlite` drives the EXTENDED query protocol one
 * message per `execProtocol*` call and it needs each answer before it sends the next (it reads the
 * `ParameterDescription` from `Describe('S')` to serialize the parameters it then `Bind`s), so
 * batching until `Sync` is not open to us. A real backend, though, buffers its output until a
 * `Sync` or a `Flush`. So every non-terminal frontend message goes out with a `Flush` behind it,
 * and this file reads until the message that ENDS that request's reply — `ParseComplete` for a
 * Parse, `BindComplete` for a Bind, `RowDescription`/`NoData` for a Describe, `CommandComplete` for
 * an Execute, `ReadyForQuery` for a Sync or a simple Query — or an `ErrorResponse`, after which the
 * backend discards everything up to the next `Sync`, which is exactly what `BasePGlite`'s `finally`
 * sends. The framing is the protocol's own: one type byte, one big-endian length that counts
 * itself. Bytes past the terminator (there are none in practice, but the ring does not promise it)
 * stay buffered for the next call.
 *
 * **Nothing here blocks, with one deliberate exception.** `SabPipe.readAsync` is
 * `Atomics.waitAsync`, which is the half of the API a driver may use on any thread — so this class
 * works unchanged on the main thread of bun and in a browser worker. The exception is
 * `execProtocolRawStream`, PGlite's own seam for callers that are wasm callbacks: `pglite-tools`'
 * pg_dump hands us protocol bytes from inside a blocking `callMain` and reads the reply back
 * SYNCHRONOUSLY, before its write callback returns, so a reply that arrives after an `await` arrives
 * after pg_dump has already concluded the server hung up. Where the agent is allowed to park
 * (`Atomics.wait`: bun's main thread, and any Worker) that one method therefore drives the ring with
 * the blocking half of the API instead — same framing, same terminators, no await before
 * `onRawData`. See {@link PgrustPGlite.execProtocolRawStream} for the exact rule.
 *
 * **The idle pump.** With one session, a `NOTIFY` and the `LISTEN` that wants it share a backend, so
 * the `NotificationResponse` rides back on the notifying statement's own reply and nothing has to
 * watch the ring. Two sessions is the other shape: the listening backend writes its notification
 * while this client is idle, and a client that only ever reads inside an exchange would not see it
 * until its next query. {@link PgrustPGlite.pumpNotifications} is the smallest thing that closes
 * that gap — an opt-in loop that reads the out-pipe ONLY when no exchange is in flight (so it can
 * never take a byte of a reply out of the ring) and feeds whole `NotificationResponse` frames
 * through the same listener dispatch `execProtocol` uses. It is what the future two-session split
 * needs; nothing in this file starts it.
 *
 * **What is deliberately absent.** There is no filesystem to sync (`syncToFs` is a no-op), no
 * `/dev/blob` device (the blob hooks are no-ops), and no data directory this side of the wire
 * (`dumpDataDir` throws — `PgrustClientPGlite` in `./pgrust-factory.ts` is the subclass that has
 * one, over the engine's own broker channel). Everything else mirrors
 * `packages/pglite/src/pglite.ts` line for line.
 */

import type {
  DebugLevel,
  ExecProtocolOptions,
  ExecProtocolOptionsStream,
  ExecProtocolResult,
  Extension,
  Extensions,
  ParserOptions,
  PGliteInterface,
  PGliteInterfaceExtensions,
  SerializerOptions,
  Transaction,
} from "@electric-sql/pglite";
import { BasePGlite, messages, Mutex, protocol } from "@electric-sql/pglite";

import type { SabPipe } from "../vendor/pgrust/sab-pipe.js";
import { encodeStartup, TERMINATE } from "../vendor/pgrust/wire.js";

/**
 * One pgrust session's pair of rings, as the host hands them out: `toGuest` is what the backend
 * reads, `fromGuest` is what it writes. The same two objects the postmaster Engine's own
 * `PipeSession` drives.
 */
export interface PgrustSessionPipes {
  readonly toGuest: SabPipe;
  readonly fromGuest: SabPipe;
}

/**
 * PGlite's `DumpTarCompressionOptions`, which its published types do not re-export from the package
 * entry (only `DumpDataDirResult` is). The three values are `packages/pglite/src/fs/tarUtils.ts`'s.
 */
export type PgrustDumpCompression = "none" | "gzip" | "auto";

/** Options for {@link PgrustPGlite.create}, the subset of `PGliteOptions` that means anything here. */
export interface PgrustPGliteOptions<TExtensions extends Extensions = Extensions> {
  readonly extensions?: TExtensions;
  readonly debug?: DebugLevel;
  readonly parsers?: ParserOptions;
  readonly serializers?: SerializerOptions;
  /** Startup-packet parameters. The postmaster lane's own defaults. */
  readonly user?: string;
  readonly database?: string;
  readonly applicationName?: string;
  /**
   * Whether `execProtocolRawStream` may take the blocking path when the rule allows it (see
   * {@link PgrustPGlite.execProtocolRawStream}). True by default, and worth turning off for exactly
   * one reason: to reproduce, on an agent that could block, what a caller which cannot wait for an
   * `await` sees when the reply does not arrive inside the call. `scripts/probe-pg-dump.ts --async`
   * is the only user.
   */
  readonly syncRawStream?: boolean;
}

/** Frontend message type bytes, in the order `BasePGlite` sends them. */
const FRONTEND_PARSE = 0x50; // "P"
const FRONTEND_BIND = 0x42; // "B"
const FRONTEND_DESCRIBE = 0x44; // "D"
const FRONTEND_EXECUTE = 0x45; // "E"
const FRONTEND_CLOSE = 0x43; // "C"
const FRONTEND_SYNC = 0x53; // "S"
const FRONTEND_QUERY = 0x51; // "Q"
const FRONTEND_FLUSH = 0x48; // "H"
const FRONTEND_TERMINATE = 0x58; // "X"
const FRONTEND_FUNCTION_CALL = 0x46; // "F"

/** Backend message type bytes this file has to recognise to know when a reply has ended. */
const BACKEND_PARSE_COMPLETE = 0x31; // "1"
const BACKEND_BIND_COMPLETE = 0x32; // "2"
const BACKEND_CLOSE_COMPLETE = 0x33; // "3"
const BACKEND_ROW_DESCRIPTION = 0x54; // "T"
const BACKEND_NO_DATA = 0x6e; // "n"
const BACKEND_COMMAND_COMPLETE = 0x43; // "C"
const BACKEND_EMPTY_QUERY = 0x49; // "I"
const BACKEND_PORTAL_SUSPENDED = 0x73; // "s"
const BACKEND_FUNCTION_CALL_RESPONSE = 0x56; // "V"
const BACKEND_ERROR_RESPONSE = 0x45; // "E"
const BACKEND_READY_FOR_QUERY = 0x5a; // "Z"
/** The one frame the idle pump takes off the ring by itself. */
const BACKEND_NOTIFICATION_RESPONSE = 0x41; // "A"

/** The `Flush` frame, byte for byte: type "H", length 4, no body. */
const FLUSH = new Uint8Array([FRONTEND_FLUSH, 0, 0, 0, 4]);

/** One ring read at a time; the session ring the backend writes is 4 MiB, so this is 64 turns of it. */
const READ_CHUNK_BYTES = 65_536;

/** A message header is the type byte plus a four-byte length that counts itself. */
const HEADER_BYTES = 5;

/**
 * How long the idle pump waits before looking at the ring again.
 *
 * The ring's own wakeup (`Atomics.waitAsync`) is not usable here: it would park the pump inside a
 * read that an exchange may need to make instead. A short poll is the honest alternative, and it is
 * two orders of magnitude below the thing it is measuring — the guest's own idle read is a 100 ms
 * poll, so this adds at most a millisecond to a notification's journey.
 */
const PUMP_IDLE_POLL_MS = 1;

/** The `SSLRequest`/`GSSENCRequest` packet: length 8, then the code, and no type byte. */
const SSL_REQUEST_BYTES = 8;
const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
/** The one-byte "no, and carry on unencrypted" answer to either of them. */
const DENIED = new Uint8Array([0x4e]); // "N"

/**
 * Whether this agent may park in `Atomics.wait`.
 *
 * True on bun's (and Node's) main thread and in every Worker; false on a browser's main thread,
 * where the call throws, and false anywhere `SharedArrayBuffer` is withheld. Computed once, by
 * asking rather than by sniffing the environment: the mismatched value makes the call return
 * `"not-equal"` immediately, so on an agent that may block this costs nothing and never sleeps.
 */
const CAN_BLOCK = ((): boolean => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0);
    return true;
  } catch {
    return false;
  }
})();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Which backend message ends the reply to `frontendType`.
 *
 * `ErrorResponse` ends every one of them: after it the backend discards frontend messages until the
 * next `Sync`, and `BasePGlite`'s `finally` sends exactly that.
 */
function endsReplyTo(frontendType: number): (backendType: number) => boolean {
  switch (frontendType) {
    // A startup packet has no type byte; the handshake ends at the first ReadyForQuery.
    case 0:
    case FRONTEND_QUERY:
    case FRONTEND_SYNC:
      return (type) => type === BACKEND_READY_FOR_QUERY;
    case FRONTEND_PARSE:
      return (type) => type === BACKEND_PARSE_COMPLETE || type === BACKEND_ERROR_RESPONSE;
    case FRONTEND_BIND:
      return (type) => type === BACKEND_BIND_COMPLETE || type === BACKEND_ERROR_RESPONSE;
    case FRONTEND_DESCRIBE:
      // Describe('S') answers ParameterDescription first and then one of these two; Describe('P')
      // answers one of these two alone.
      return (type) => type === BACKEND_ROW_DESCRIPTION || type === BACKEND_NO_DATA || type === BACKEND_ERROR_RESPONSE;
    case FRONTEND_EXECUTE:
      return (type) =>
        type === BACKEND_COMMAND_COMPLETE ||
        type === BACKEND_EMPTY_QUERY ||
        type === BACKEND_PORTAL_SUSPENDED ||
        type === BACKEND_ERROR_RESPONSE;
    case FRONTEND_CLOSE:
      return (type) => type === BACKEND_CLOSE_COMPLETE || type === BACKEND_ERROR_RESPONSE;
    case FRONTEND_FUNCTION_CALL:
      return (type) => type === BACKEND_FUNCTION_CALL_RESPONSE || type === BACKEND_ERROR_RESPONSE;
    default:
      throw new Error(
        `PgrustPGlite: no reply terminator is defined for frontend message type ` +
          `"${String.fromCharCode(frontendType)}" (0x${frontendType.toString(16)})`,
      );
  }
}

/** Whether a frontend message is one the backend answers without being flushed. */
function isSelfFlushing(frontendType: number): boolean {
  return frontendType === 0 || frontendType === FRONTEND_QUERY || frontendType === FRONTEND_SYNC;
}

/** Always allocates: the ring's bytes are reused by the next read, so a view of them cannot be kept. */
function concat(head: Uint8Array, tail: Uint8Array): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(head.length + tail.length);
  joined.set(head, 0);
  joined.set(tail, head.length);
  return joined;
}

/**
 * The channel-name normalisation `pglUtils.toPostgresName` performs, reproduced here because it is
 * not on `@electric-sql/pglite`'s public surface. Same rule as the identifier one: a quoted name
 * keeps its case, an unquoted one is folded down, and that is the name a `NotificationResponse`
 * carries.
 */
function toPostgresName(input: string): string {
  return input.startsWith('"') && input.endsWith('"') ? input.slice(1, -1) : input.toLowerCase();
}

/** What one `execProtocol` call collects while the parser walks its bytes. */
class CurrentQuery {
  readonly results: messages.BackendMessage[] = [];
  readonly throwOnError: boolean;
  readonly onNotice: ((notice: messages.NoticeMessage) => void) | undefined;
  databaseError: messages.DatabaseError | null = null;

  constructor(throwOnError = false, onNotice?: (notice: messages.NoticeMessage) => void) {
    this.throwOnError = throwOnError;
    this.onNotice = onNotice;
  }
}

export class PgrustPGlite extends BasePGlite {
  override readonly debug: DebugLevel = 0;

  readonly waitReady: Promise<void>;

  readonly #toGuest: SabPipe;
  readonly #fromGuest: SabPipe;
  readonly #startupParameters: Readonly<Record<string, string>>;

  /** Backend bytes read but not yet consumed by a reply — never more than a trailing partial message. */
  #buffered: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  readonly #scratch = new Uint8Array(READ_CHUNK_BYTES);

  #ready = false;
  #closing = false;
  #closed = false;

  /**
   * Whether a reply is outstanding on the ring. The idle pump reads only when this is false, and
   * both sides of that check run without an `await` between them, so the pump can never take a byte
   * an exchange is waiting for.
   */
  #exchangeInFlight = false;
  #pumping = false;
  /**
   * The bytes the backend answered this session's own startup packet with — `AuthenticationOk`, the
   * `ParameterStatus` run, `BackendKeyData`, `ReadyForQuery`.
   *
   * Kept because a second client can turn up on this session and open with a handshake of its own:
   * `pglite-tools`' pg_dump is a whole libpq, and libpq's first act is a startup packet. The backend
   * is long past accepting one, so the handshake it already gave is replayed instead. PGlite does the
   * same thing by another route — it re-runs `ProcessStartupPacket` against its live backend.
   */
  #handshakeReply: Uint8Array = new Uint8Array(0);
  /** Whether the blocking raw-stream path is permitted at all; see `PgrustPGliteOptions.syncRawStream`. */
  readonly #syncRawStream: boolean;

  // The same three mutexes `PGlite` keeps, doing the same three jobs.
  readonly #queryMutex = new Mutex();
  readonly #transactionMutex = new Mutex();
  readonly #listenMutex = new Mutex();

  #protocolParser = new protocol.Parser();
  /** The pump's own parser: it is fed whole frames only, so it never shares partial state with one. */
  readonly #pumpParser = new protocol.Parser();
  #currentQuery = new CurrentQuery();

  readonly #extensions: Extensions;
  readonly #extensionsClose: Array<() => Promise<void>> = [];

  readonly #notifyListeners = new Map<string, Set<(payload: string) => void>>();
  readonly #globalNotifyListeners = new Set<(channel: string, payload: string) => void>();

  constructor(session: PgrustSessionPipes, options: PgrustPGliteOptions = {}) {
    super();
    this.#toGuest = session.toGuest;
    this.#fromGuest = session.fromGuest;
    if (options.parsers !== undefined) {
      this.parsers = { ...this.parsers, ...options.parsers };
    }
    if (options.serializers !== undefined) {
      this.serializers = { ...this.serializers, ...options.serializers };
    }
    if (options.debug !== undefined) {
      this.debug = options.debug;
    }
    this.#extensions = options.extensions ?? {};
    this.#syncRawStream = options.syncRawStream ?? true;
    this.#startupParameters = {
      user: options.user ?? "postgres",
      database: options.database ?? "postgres",
      application_name: options.applicationName ?? "pgxsinkit-live-scenario",
      client_encoding: "UTF8",
    };
    this.waitReady = this.#init();
  }

  /**
   * Open a client on an already-announced pgrust session, exactly as `PGlite.create` opens one on a
   * wasm instance: construct, await the ready promise, hand back an instance whose extension
   * namespaces are on its type.
   */
  static async create<TExtensions extends Extensions>(
    session: PgrustSessionPipes,
    options: PgrustPGliteOptions<TExtensions> = {},
  ): Promise<PgrustPGlite & PGliteInterfaceExtensions<TExtensions>> {
    const instance = new PgrustPGlite(session, options);
    await instance.waitReady;
    return instance as PgrustPGlite & PGliteInterfaceExtensions<TExtensions>;
  }

  // -------------------------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------------------------

  async #init(): Promise<void> {
    // Extension setup, in `PGlite.#init`'s shape: the namespace object is assigned onto the
    // instance under the extension's key, `init` runs once the database answers queries, and
    // `close` is kept for `close()`. There is no emscripten module here, so the options a setup
    // amends are an empty object it is welcome to ignore, and a bundle path has nowhere to go.
    const extensionInitFns: Array<() => Promise<void>> = [];
    for (const [name, extension] of Object.entries(this.#extensions)) {
      if (extension instanceof URL) {
        throw new Error(
          `PgrustPGlite: extension "${name}" is a bundle URL; a pgrust backend loads no PGlite ` +
            "extension bundles (only JS extensions with a setup function are supported)",
        );
      }
      const result = await (extension as Extension).setup(this as unknown as PGliteInterface, {});
      if (result.namespaceObj) {
        (this as unknown as Record<string, unknown>)[name] = result.namespaceObj;
      }
      if (result.bundlePath) {
        throw new Error(`PgrustPGlite: extension "${name}" asks for a bundle, which this transport cannot load`);
      }
      if (result.init) {
        extensionInitFns.push(result.init);
      }
      if (result.close) {
        this.#extensionsClose.push(result.close);
      }
    }

    // The startup packet, and everything through the first ReadyForQuery. The postmaster has
    // already spawned this backend (the host announced the connection record); this is the
    // handshake that backend is waiting on.
    this.#handshakeReply = await this.#exchange(encodeStartup(this.#startupParameters), 0);

    this.#ready = true;

    await this._initArrayTypes();

    for (const initFn of extensionInitFns) {
      await initFn();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------------------------

  /**
   * Enqueue frontend bytes without ever parking this thread.
   *
   * A short write is normal rather than exceptional — a schema script is larger than a ring — and
   * blocking through one would stop the very pump that drains it.
   */
  async #send(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      offset += this.#toGuest.write(bytes.subarray(offset), { block: false });
      if (offset < bytes.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  /**
   * Send one frontend message and return the raw bytes of the reply it ends with.
   *
   * `frontendType` is the message's own type byte, or 0 for the startup packet (which has none).
   * Anything the backend would otherwise hold in its output buffer is prised out with a `Flush`.
   */
  async #exchange(message: Uint8Array, frontendType: number): Promise<Uint8Array> {
    const isTerminator = endsReplyTo(frontendType);
    this.#exchangeInFlight = true;
    try {
      await this.#send(isSelfFlushing(frontendType) ? message : concat(message, FLUSH));

      let scanned = 0;
      for (;;) {
        const scan = this.#scanForReply(isTerminator, scanned);
        if (scan.reply !== null) {
          return scan.reply;
        }
        scanned = scan.scanned;
        const read = await this.#fromGuest.readAsync(this.#scratch, this.#scratch.length);
        if (read === 0) {
          this.#closed = true;
          throw new Error("PgrustPGlite: the backend closed the session while a reply was outstanding");
        }
        this.#buffered = concat(this.#buffered, this.#scratch.subarray(0, read));
      }
    } finally {
      this.#exchangeInFlight = false;
    }
  }

  /**
   * Walk the buffered bytes from `scanned` looking for the frame that ends this reply.
   *
   * The framing is the protocol's own — one type byte, one big-endian length that counts itself —
   * and it is here, in one place, because the asynchronous read loop and the blocking one differ in
   * nothing else. When the terminator is complete the reply is taken off the front of the buffer
   * and anything past it stays for the next call; otherwise the scan offset comes back so the
   * caller can read more and resume where it left off.
   */
  #scanForReply(
    isTerminator: (backendType: number) => boolean,
    scanned: number,
  ): { reply: Uint8Array<ArrayBuffer> | null; scanned: number } {
    let at = scanned;
    while (this.#buffered.length - at >= HEADER_BYTES) {
      const type = this.#buffered[at] as number;
      const view = new DataView(this.#buffered.buffer, this.#buffered.byteOffset + at + 1, 4);
      const end = at + 1 + view.getUint32(0, false);
      if (this.#buffered.length < end) {
        break;
      }
      at = end;
      if (isTerminator(type)) {
        const reply = this.#buffered.slice(0, end);
        this.#buffered = this.#buffered.slice(end);
        return { reply, scanned: 0 };
      }
    }
    return { reply: null, scanned: at };
  }

  /**
   * The message that decides how far a reply runs: the type byte of the LAST whole frontend message
   * in `message`, or 0 for a startup packet (which has no type byte and is never batched).
   *
   * `BasePGlite` sends exactly one message per call, so for every caller in PGlite this is the first
   * byte and nothing more. A libpq on the other side of `execProtocolRawStream` is not so tidy: it
   * flushes whatever its output buffer holds, which can be a whole `Parse`/`Bind`/`Describe`/
   * `Execute`/`Sync` in one write. It is the last of those that says when the backend has finished
   * answering — and whether the batch flushes itself.
   */
  #frontendTypeOf(message: Uint8Array): number {
    const first = message[0];
    if (first === undefined) {
      throw new Error("PgrustPGlite: refusing to send an empty protocol message");
    }
    if (first === 0) {
      return 0;
    }
    let type = first;
    let at = 0;
    while (message.length - at >= HEADER_BYTES) {
      const view = new DataView(message.buffer, message.byteOffset + at + 1, 4);
      const end = at + 1 + view.getUint32(0, false);
      if (end > message.length) {
        break; // A trailing partial frame: the last WHOLE message is still the one that answers.
      }
      type = message[at] as number;
      at = end;
    }
    return type;
  }

  // -------------------------------------------------------------------------------------------
  // The abstract transport hooks
  // -------------------------------------------------------------------------------------------

  /**
   * The messages that are answered here rather than on the wire, or null for the ordinary case.
   *
   * Two of them, and both exist because `execProtocolRawStream` can be driven by a whole libpq
   * rather than by `BasePGlite`: an `SSLRequest`/`GSSENCRequest` is refused (the answer is one byte,
   * `N`, after which libpq carries on unencrypted), and a startup packet is answered with the
   * handshake this session already completed. `Terminate` is the third, and the oldest: `close()`
   * owns it, so a caller who sends one through the protocol seam gets the same no-op `PGlite` gives
   * it rather than a session torn down under the client.
   */
  #answerLocally(message: Uint8Array, type: number): Uint8Array | null {
    if (type === FRONTEND_TERMINATE) {
      return new Uint8Array(0);
    }
    if (type !== 0) {
      return null;
    }
    if (message.length === SSL_REQUEST_BYTES) {
      const view = new DataView(message.buffer, message.byteOffset, SSL_REQUEST_BYTES);
      const code = view.getUint32(4, false);
      if (
        view.getUint32(0, false) === SSL_REQUEST_BYTES &&
        (code === SSL_REQUEST_CODE || code === GSSENC_REQUEST_CODE)
      ) {
        return DENIED;
      }
    }
    return this.#ready ? this.#handshakeReply.slice() : null;
  }

  override async execProtocolRaw(message: Uint8Array, _options: ExecProtocolOptions = {}): Promise<Uint8Array> {
    const type = this.#frontendTypeOf(message);
    const answered = this.#answerLocally(message, type);
    if (answered !== null) {
      return answered;
    }
    return await this.#exchange(message, type);
  }

  override async execProtocol(
    message: Uint8Array,
    { throwOnError = true, onNotice }: ExecProtocolOptions = {},
  ): Promise<ExecProtocolResult> {
    this.#currentQuery = new CurrentQuery(throwOnError, onNotice);
    const data = await this.execProtocolRaw(message);
    return { messages: this.#settle(data, throwOnError), data };
  }

  override async execProtocolStream(
    message: Uint8Array,
    { throwOnError = true, onNotice }: ExecProtocolOptions = {},
  ): Promise<messages.BackendMessage[]> {
    this.#currentQuery = new CurrentQuery(throwOnError, onNotice);
    const data = await this.execProtocolRaw(message);
    return this.#settle(data, throwOnError);
  }

  /**
   * The one method that may block, and the rule for when it does.
   *
   * **The rule:** `execProtocolRawStream` drives the ring with the BLOCKING half of `SabPipe` — and
   * therefore reaches `onRawData` inside its own synchronous prefix, before it returns a promise to
   * anybody — whenever both of these hold:
   *
   *  1. this agent may park in `Atomics.wait` ({@link CAN_BLOCK}: bun's main thread, any Worker; not
   *     a browser's main thread), and
   *  2. no other exchange is in flight, so nothing is waiting on the bytes it is about to consume
   *     and no `await` of ours is holding the ring.
   *
   * Otherwise it falls back to the asynchronous path, which is correct for every caller that awaits
   * it and wrong only for one that cannot.
   *
   * **Why this method and no other.** PGlite documents `execProtocolRawStream` as the seam its own
   * tools drive from synchronous wasm callbacks, and `pglite-tools`' pg_dump is exactly that: its
   * emscripten write callback calls this and its read callback consumes the buffered reply
   * immediately, on the same tick, inside a blocking `callMain` where no microtask can run. On the
   * asynchronous path the buffer is still empty when pg_dump reads it, pg_dump reads zero bytes,
   * and libpq concludes the server closed the connection. Nothing else in this class needs the
   * blocking path, and `execProtocolRaw` deliberately does not take it.
   *
   * A wire reply is read in ring-sized chunks and only completes at its terminator, so the whole
   * reply is in hand before anything can be handed on: one call, not a stream of them. The
   * contract — "every byte of the reply reaches `onRawData`" — is kept on both paths.
   */
  override async execProtocolRawStream(message: Uint8Array, { onRawData }: ExecProtocolOptionsStream): Promise<void> {
    const type = this.#frontendTypeOf(message);
    const answered = this.#answerLocally(message, type);
    if (answered !== null) {
      onRawData(answered);
      return;
    }
    if (this.#syncRawStream && CAN_BLOCK && !this.#exchangeInFlight) {
      onRawData(this.#exchangeSync(message, type));
      return;
    }
    onRawData(await this.execProtocolRaw(message));
  }

  /**
   * {@link PgrustPGlite.#exchange}, with the blocking half of the ring API: one `Atomics.wait` write
   * and one `Atomics.wait` read loop instead of two awaits. Same framing, same terminators, same
   * buffer — `#scanForReply` is the shared half — and the same `#exchangeInFlight` flag, so the idle
   * pump stays out of its way exactly as it does for the asynchronous path.
   */
  #exchangeSync(message: Uint8Array, frontendType: number): Uint8Array {
    const isTerminator = endsReplyTo(frontendType);
    this.#exchangeInFlight = true;
    try {
      // Blocking, unlike `#send`: nothing else on this agent can drain the ring while this call
      // holds it, so parking until there is room is the only honest wait available.
      this.#toGuest.write(isSelfFlushing(frontendType) ? message : concat(message, FLUSH), { block: true });

      let scanned = 0;
      for (;;) {
        const scan = this.#scanForReply(isTerminator, scanned);
        if (scan.reply !== null) {
          return scan.reply;
        }
        scanned = scan.scanned;
        const read = this.#fromGuest.readInto(this.#scratch, this.#scratch.length);
        if (read === 0) {
          this.#closed = true;
          throw new Error("PgrustPGlite: the backend closed the session while a reply was outstanding");
        }
        this.#buffered = concat(this.#buffered, this.#scratch.subarray(0, read));
      }
    } finally {
      this.#exchangeInFlight = false;
    }
  }

  /** Parse a reply, dispatch its notices and notifications, and surface any database error. */
  #settle(data: Uint8Array, throwOnError: boolean): messages.BackendMessage[] {
    this.#protocolParser.parse(data, (message) => {
      const kept = this.#dispatch(message);
      if (kept) {
        this.#currentQuery.results.push(kept);
      }
    });
    const databaseError = this.#currentQuery.databaseError;
    const results = this.#currentQuery.results;
    this.#currentQuery = new CurrentQuery();
    if (throwOnError && databaseError) {
      this.#protocolParser = new protocol.Parser(); // Reset the parser
      throw databaseError;
    }
    return results;
  }

  /** `PGlite.#parse`, verbatim in behaviour: the first error wins, notices and notifications fan out. */
  #dispatch(message: messages.BackendMessage): messages.BackendMessage | null {
    if (this.#currentQuery.databaseError) {
      return null;
    }
    if (message instanceof messages.DatabaseError) {
      if (this.#currentQuery.throwOnError) {
        this.#currentQuery.databaseError = message;
      }
    } else if (message instanceof messages.NoticeMessage) {
      if (this.debug > 0) {
        console.warn(message);
      }
      this.#currentQuery.onNotice?.(message);
    } else if (message instanceof messages.NotificationResponseMessage) {
      this.#deliverNotification(message);
    }
    return message;
  }

  /**
   * Fan one notification out to its listeners. `PGlite`'s own dispatch, and the pump's too: a
   * notification that arrived on a reply and one the idle pump took off the ring are the same event
   * and reach the same callbacks by the same route.
   */
  #deliverNotification(message: messages.NotificationResponseMessage): void {
    const listeners = this.#notifyListeners.get(message.channel);
    if (listeners) {
      // queueMicrotask so the callback runs after the synchronous parse has finished, exactly as
      // `PGlite` does — a listener that queries would otherwise re-enter the parser.
      listeners.forEach((callback) => queueMicrotask(() => callback(message.payload)));
    }
    this.#globalNotifyListeners.forEach((callback) => queueMicrotask(() => callback(message.channel, message.payload)));
  }

  // -------------------------------------------------------------------------------------------
  // The idle notification pump — what a second session needs, and nothing more
  // -------------------------------------------------------------------------------------------

  /**
   * Watch the out-pipe while this client is idle and deliver the notifications that arrive on it.
   *
   * Opt-in, and off by default: with one session a notification rides back on the notifying
   * statement's own reply, so nothing has to watch anything. Two sessions is the shape this exists
   * for — the listening backend writes its `NotificationResponse` while this client is between
   * queries, and without a pump the payload sits in the ring until the next `execProtocol` happens
   * to read past it.
   *
   * The rule that keeps it safe is the whole design: it reads only when `#exchangeInFlight` is
   * false, and there is no `await` between that check and the non-blocking `readIntoNow`, so it can
   * never consume a byte an outstanding reply is waiting for. What it takes off the front of the
   * buffer is a whole `NotificationResponse` and nothing else; any other frame that turns up while
   * idle is left buffered for the next exchange to parse, exactly as if the pump had never run.
   *
   * Resolves when `signal` aborts, when the session closes, or when the backend hangs up.
   */
  async pumpNotifications(signal: AbortSignal): Promise<void> {
    if (this.#pumping) {
      throw new Error("PgrustPGlite: the notification pump is already running on this client");
    }
    this.#pumping = true;
    const scratch = new Uint8Array(READ_CHUNK_BYTES);
    try {
      while (!signal.aborted && !this.#closing && !this.#closed) {
        if (this.#exchangeInFlight) {
          await delay(PUMP_IDLE_POLL_MS);
          continue;
        }
        const read = this.#fromGuest.readIntoNow(scratch, scratch.length);
        if (read === 0) {
          return; // The backend hung up; `close()` and the next exchange both report it themselves.
        }
        if (read < 0) {
          await delay(PUMP_IDLE_POLL_MS);
          continue;
        }
        this.#buffered = concat(this.#buffered, scratch.subarray(0, read));
        this.#drainNotifications();
      }
    } finally {
      this.#pumping = false;
    }
  }

  /** Take every leading whole `NotificationResponse` off the buffer and deliver it. */
  #drainNotifications(): void {
    for (;;) {
      if (this.#buffered.length < HEADER_BYTES || this.#buffered[0] !== BACKEND_NOTIFICATION_RESPONSE) {
        return;
      }
      const view = new DataView(this.#buffered.buffer, this.#buffered.byteOffset + 1, 4);
      const end = 1 + view.getUint32(0, false);
      if (this.#buffered.length < end) {
        return;
      }
      const frame = this.#buffered.slice(0, end);
      this.#buffered = this.#buffered.slice(end);
      this.#pumpParser.parse(frame, (message) => {
        if (message instanceof messages.NotificationResponseMessage) {
          this.#deliverNotification(message);
        }
      });
    }
  }

  /** There is no filesystem on this side of the wire: the backend owns its own, and syncs it itself. */
  override async syncToFs(): Promise<void> {
    // Intentionally empty.
  }

  /**
   * No `/dev/blob` here: this client is the wire and nothing else, and the file the facility needs
   * lives in a store it does not have. A subclass that owns one answers all three (see
   * `PgrustClientPGlite` in `pgrust-factory.ts`, which puts a real file at that path).
   */
  override async _handleBlob(_blob?: File | Blob): Promise<void> {
    // Intentionally empty.
  }

  override async _getWrittenBlob(): Promise<File | Blob | undefined> {
    return undefined;
  }

  override async _cleanupBlob(): Promise<void> {
    // Intentionally empty.
  }

  override async _checkReady(): Promise<void> {
    if (this.#closing) {
      throw new Error("PgrustPGlite is closing");
    }
    if (this.#closed) {
      throw new Error("PgrustPGlite is closed");
    }
    if (!this.#ready) {
      await this.waitReady;
    }
  }

  override async _runExclusiveQuery<T>(fn: () => Promise<T>): Promise<T> {
    return await this.#queryMutex.runExclusive(fn);
  }

  override async _runExclusiveTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return await this.#transactionMutex.runExclusive(fn);
  }

  async _runExclusiveListen<T>(fn: () => Promise<T>): Promise<T> {
    return await this.#listenMutex.runExclusive(fn);
  }

  // -------------------------------------------------------------------------------------------
  // Notifications — `PGlite`'s implementation, unchanged
  // -------------------------------------------------------------------------------------------

  override async listen(
    channel: string,
    callback: (payload: string) => void,
    tx?: Transaction,
  ): Promise<(tx?: Transaction) => Promise<void>> {
    return await this._runExclusiveListen(async () => await this.#listen(channel, callback, tx));
  }

  async #listen(
    channel: string,
    callback: (payload: string) => void,
    tx?: Transaction,
  ): Promise<(tx?: Transaction) => Promise<void>> {
    const pgChannel = toPostgresName(channel);
    const pg = tx ?? this;
    if (!this.#notifyListeners.has(pgChannel)) {
      this.#notifyListeners.set(pgChannel, new Set());
    }
    this.#notifyListeners.get(pgChannel)?.add(callback);
    try {
      await pg.exec(`LISTEN ${channel}`);
    } catch (error) {
      this.#notifyListeners.get(pgChannel)?.delete(callback);
      if (this.#notifyListeners.get(pgChannel)?.size === 0) {
        this.#notifyListeners.delete(pgChannel);
      }
      throw error;
    }
    return async (unlistenTx?: Transaction) => {
      await this.unlisten(pgChannel, callback, unlistenTx);
    };
  }

  async unlisten(channel: string, callback?: (payload: string) => void, tx?: Transaction): Promise<void> {
    await this._runExclusiveListen(async () => {
      await this.#unlisten(channel, callback, tx);
    });
  }

  async #unlisten(channel: string, callback?: (payload: string) => void, tx?: Transaction): Promise<void> {
    const pgChannel = toPostgresName(channel);
    const pg = tx ?? this;
    const cleanUp = async (): Promise<void> => {
      await pg.exec(`UNLISTEN ${channel}`);
      // Another query may have subscribed while that ran, so check again.
      if (this.#notifyListeners.get(pgChannel)?.size === 0) {
        this.#notifyListeners.delete(pgChannel);
      }
    };
    if (callback) {
      this.#notifyListeners.get(pgChannel)?.delete(callback);
      if (this.#notifyListeners.get(pgChannel)?.size === 0) {
        await cleanUp();
      }
    } else {
      await cleanUp();
    }
  }

  onNotification(callback: (channel: string, payload: string) => void): () => void {
    this.#globalNotifyListeners.add(callback);
    return () => {
      this.#globalNotifyListeners.delete(callback);
    };
  }

  offNotification(callback: (channel: string, payload: string) => void): void {
    this.#globalNotifyListeners.delete(callback);
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  get ready(): boolean {
    return this.#ready && !this.#closing && !this.#closed;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * End the session: run the extensions' own teardown, send `Terminate`, and wait for the backend's
   * `secure_close` — which this side sees as EOF on the ring it reads. The postmaster's shutdown is
   * a separate, later thing (the engine closes the listener); this is one client leaving.
   */
  async close(): Promise<void> {
    if (this.#closed || this.#closing) {
      return;
    }
    this.#closing = true;
    try {
      for (const closeExtension of this.#extensionsClose) {
        await closeExtension();
      }
      await this.#send(TERMINATE);
      for (;;) {
        const read = await this.#fromGuest.readAsync(this.#scratch, this.#scratch.length);
        if (read === 0) {
          break;
        }
      }
    } finally {
      this.#closed = true;
      this.#closing = false;
      this.#ready = false;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * No data directory this side of the wire: the store lives in the coordinator, not in this client.
   *
   * The signature is PGlite's rather than `Promise<never>` so a subclass that DOES hold the store —
   * `PgrustClientPGlite`, which the factory builds over the engine's own broker channel — can
   * override it with the real thing. A bare session, opened on rings alone, still has nowhere to
   * read a file from and says so.
   */
  async dumpDataDir(_compression?: PgrustDumpCompression): Promise<File | Blob> {
    throw new Error(
      "PgrustPGlite: dumpDataDir is not supported on a bare session — the data directory belongs to " +
        "the pgrust storage coordinator, and only a client built over its broker channel " +
        "(`createPgrustPglite`) can read it",
    );
  }
}
