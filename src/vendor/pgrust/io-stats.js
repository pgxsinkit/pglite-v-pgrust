// io-stats.js — optional counters of the store work a pgrust host does, for a harness that wants to
// know what one statement cost in file calls, broker requests and storage handle calls.
//
// OFF UNLESS ASKED. Every host that can count takes an `ioStats` buffer and does nothing different
// without one: no wrapper is installed, no clock is read. With one, three things are counted, each
// by the one agent that does it, into one buffer every agent shares:
//
//   guest file calls   per AGENT (the process instance is agent 0, pool slot s is agent s + 1):
//                      every WASI filesystem import the guest calls on a file or directory — by
//                      kind, with the bytes a read or write moved and the ms the guest thread spent
//                      inside the call. On the broker seam that time is the thread blocked on the
//                      coordinator (the adapter's own work plus every round trip); on the copy seam
//                      it is the private `Vfs`'s own. The pipe fds (stdio, the listener, the
//                      sessions') are not files and are never counted.
//   session reads      per AGENT: the first time an agent reads a Session's input (fd 0 under
//                      `--stdio-wire-threaded`, the session's in fd under `--host-pipes`), it is
//                      marked as that Session's backend. That is how a harness tells a backend's
//                      file calls from the checkpointer's without guessing from volumes.
//   coordinator        the storage coordinator: every broker request it answered, by opcode, with
//                      the request's own bytes; the ms its serve loop spent answering; and every
//                      synchronous access handle call its OPFS port made, by kind, with bytes and ms.
//
// ONE WRITER PER REGION. An agent writes only its own block and the coordinator only its own, so
// plain Float64 stores suffice; a reader snapshots the whole buffer and differences two snapshots.
// A snapshot taken while a thread is mid-call can miss that call, never corrupt a total.
//
// The clock is `performance.now()`, which a cross-origin isolated page coarsens to a few µs: a
// single in-memory file call is below that, so per-call times are quantized and only their sums
// over many calls mean anything.

export const IO_STATS_VERSION = 1;

/** Guest file call kinds, in the order their counters are laid out. */
export const GUEST_CALL_KINDS = ['read', 'write', 'sync', 'allocate', 'open', 'close', 'stat', 'seek', 'other'];

/** Broker request kinds: the protocol's seventeen opcodes grouped for reading. */
export const BROKER_REQUEST_KINDS = ['read', 'write', 'fsync', 'allocate', 'open', 'close', 'stat', 'other'];

/** Synchronous access handle call kinds, in the order their counters are laid out. */
export const HANDLE_CALL_KINDS = ['read', 'write', 'truncate', 'flush', 'getSize'];

// The broker's opcodes (@pgxsinkit/pglite-opfs-repacked `broker/protocol.ts`) and the kind each is
// read as. `truncate` is how the adapter answers both `fd_filestat_set_size` and `fd_allocate`;
// `size` and the three stats all answer "how big / what is it".
const OPCODE_KINDS = [
  'other', // 0: not an opcode
  'open', // 1
  'close', // 2
  'read', // 3
  'write', // 4
  'fsync', // 5
  'stat', // 6 fstat
  'stat', // 7 stat
  'stat', // 8 lstat
  'other', // 9 readdir
  'other', // 10 mkdir
  'other', // 11 rmdir
  'other', // 12 unlink
  'other', // 13 rename
  'allocate', // 14 truncate
  'stat', // 15 size
  'other', // 16 symlink
  'other', // 17 readlink
];
const OPCODES = OPCODE_KINDS.length;

// WASI filesystem imports by kind. Anything not named here is not a file call.
const GUEST_KIND_OF = {
  fd_read: 'read',
  fd_pread: 'read',
  fd_write: 'write',
  fd_pwrite: 'write',
  fd_sync: 'sync',
  fd_datasync: 'sync',
  fd_allocate: 'allocate',
  fd_filestat_set_size: 'allocate',
  path_open: 'open',
  fd_close: 'close',
  fd_filestat_get: 'stat',
  path_filestat_get: 'stat',
  fd_seek: 'seek',
  fd_tell: 'seek',
  fd_fdstat_get: 'other',
  fd_fdstat_set_flags: 'other',
  fd_fdstat_set_rights: 'other',
  fd_filestat_set_times: 'other',
  fd_readdir: 'other',
  fd_advise: 'other',
  fd_prestat_get: 'other',
  fd_prestat_dir_name: 'other',
  path_create_directory: 'other',
  path_remove_directory: 'other',
  path_unlink_file: 'other',
  path_rename: 'other',
  path_readlink: 'other',
  path_symlink: 'other',
  path_link: 'other',
  path_filestat_set_times: 'other',
};
// The argument carrying the fd a call is about: first (index 0) everywhere but
// `path_symlink(old, len, fd, …)`.
const FD_ARGUMENT = { path_symlink: 2 };
// The argument pointing at the u32 byte count a read or write reports.
const COUNT_POINTER_ARGUMENT = { fd_read: 3, fd_pread: 4, fd_write: 3, fd_pwrite: 4 };

// ---- layout (Float64 indices) -------------------------------------------------------------------
//   0  version
//   1  agents
//   HEADER .. agent blocks: per kind [calls, bytes, ms], then the session mark (k + 1, or 0)
//   then the coordinator: per opcode [requests, request bytes], then [serving ms, requests served]
//   then the handles: per kind [calls, bytes, ms]
const HEADER = 8;
const AGENT_STRIDE = 32; // 9 kinds x 3 + the session mark, rounded up
const SESSION_MARK = GUEST_CALL_KINDS.length * 3;
const COORD_STRIDE = 48; // 18 opcodes x 2 + 2, rounded up
const SERVING_MS = OPCODES * 2;
const SERVED = SERVING_MS + 1;
const HANDLE_STRIDE = 16; // 5 kinds x 3, rounded up

const now = () => performance.now();

export class IoStats {
  /**
   * A fresh, zeroed buffer for `agents` guest agents (the process instance plus every pool slot).
   * Shared by default so it can cross to every worker; `shared: false` is for a host whose only
   * agent lives in the same worker as its reader and that may not have `SharedArrayBuffer`.
   */
  static create({ agents, shared = true }) {
    if (!Number.isSafeInteger(agents) || agents < 1) throw new RangeError('io-stats: agents must be a positive integer');
    const floats = HEADER + agents * AGENT_STRIDE + COORD_STRIDE + HANDLE_STRIDE;
    const buffer = shared ? new SharedArrayBuffer(floats * 8) : new ArrayBuffer(floats * 8);
    const view = new Float64Array(buffer);
    view[0] = IO_STATS_VERSION;
    view[1] = agents;
    return new IoStats(buffer);
  }

  /** The same counters over a buffer that arrived over `postMessage`. */
  static attach(buffer) {
    return new IoStats(buffer);
  }

  constructor(buffer) {
    const view = new Float64Array(buffer);
    if (view[0] !== IO_STATS_VERSION) throw new Error(`io-stats: buffer is version ${view[0]}, not ${IO_STATS_VERSION}`);
    this.buffer = buffer;
    this.view = view;
    this.agents = view[1];
    this.coordBase = HEADER + this.agents * AGENT_STRIDE;
    this.handleBase = this.coordBase + COORD_STRIDE;
  }

  agentBase(agent) {
    if (!Number.isSafeInteger(agent) || agent < 0 || agent >= this.agents) {
      throw new RangeError(`io-stats: agent ${agent} is outside 0..${this.agents - 1}`);
    }
    return HEADER + agent * AGENT_STRIDE;
  }

  /** Mark `agent` as Session `session`'s backend. The first mark stands. */
  markSession(agent, session) {
    const at = this.agentBase(agent) + SESSION_MARK;
    if (this.view[at] === 0) this.view[at] = session + 1;
  }

  /** A copy of every counter, for `describeIoStats`. */
  snapshot() {
    return this.view.slice();
  }
}

/**
 * Count every WASI file call `wasi` answers for fds above stdio, IN PLACE: each filesystem import on
 * the object is replaced by a wrapper that times it. Install it where the object holds the FILE
 * calls and nothing else — below a host's pipe layer, which answers the pipe fds before this sees
 * them. `memory()` returns the guest memory's current buffer (it may grow between calls).
 */
export function countGuestFileCalls(wasi, { stats, agent, memory }) {
  const view = stats.view;
  const base = stats.agentBase(agent);
  let viewBuffer = null;
  let dataView = null;
  const countAt = (pointer) => {
    const buffer = memory();
    if (buffer !== viewBuffer) {
      viewBuffer = buffer;
      dataView = new DataView(buffer);
    }
    return dataView.getUint32(pointer, true);
  };
  for (const [name, kind] of Object.entries(GUEST_KIND_OF)) {
    const inner = wasi[name];
    if (typeof inner !== 'function') continue;
    const slot = base + GUEST_CALL_KINDS.indexOf(kind) * 3;
    const fdIsThird = FD_ARGUMENT[name] === 2;
    const countPointer = COUNT_POINTER_ARGUMENT[name];
    // Fixed arity rather than rest parameters, and no array: nothing is allocated per call. Every
    // WASI import takes nine arguments or fewer, and a JS function ignores the extra `undefined`s.
    wasi[name] = (a, b, c, d, e, f, g, h, i) => {
      if ((fdIsThird ? c : a) <= 2) return inner(a, b, c, d, e, f, g, h, i);
      const t0 = now();
      const rc = inner(a, b, c, d, e, f, g, h, i);
      view[slot + 2] += now() - t0;
      view[slot] += 1;
      if (countPointer !== undefined && rc === 0) view[slot + 1] += countAt(countPointer === 3 ? d : e);
      return rc;
    };
  }
  return wasi;
}

/**
 * Mark `agent` as a Session's backend the first time it reads that Session's input. Installed ABOVE
 * a host's pipe layer, where `fd_read` still sees the pipe fds. `sessionOf(fd)` is the Session an fd
 * is the input of, or -1.
 */
export function markSessionReads(wasi, { stats, agent, sessionOf }) {
  const inner = wasi.fd_read;
  if (typeof inner !== 'function') return wasi;
  let marked = false;
  wasi.fd_read = (fd, iovsPtr, iovsLen, nreadPtr) => {
    if (!marked) {
      const session = sessionOf(fd);
      if (session >= 0) {
        stats.markSession(agent, session);
        marked = true;
      }
    }
    return inner(fd, iovsPtr, iovsLen, nreadPtr);
  };
  return wasi;
}

/**
 * Count what a `RepackedSyncBroker` answers: every request by opcode (peeked on its channel before
 * the broker answers it), and the ms and requests of every `serveOnce()` that answered anything.
 * `serveForever()` calls `this.serveOnce()`, so shadowing it on the instance is enough.
 *
 * A request published between the peek and the broker's own scan is answered and counted in
 * `served` without an opcode; `describeIoStats` reports that remainder as `other`.
 */
export function countBrokerService(broker, channels, stats) {
  const view = stats.view;
  const base = stats.coordBase;
  const headers = channels.map((channel) => channel.header);
  const serveOnce = broker.serveOnce.bind(broker);
  // HEADER_STATE 0, HEADER_OPCODE 1, HEADER_REQUEST 2; STATE_REQUEST 1.
  broker.serveOnce = () => {
    for (const header of headers) {
      if (Atomics.load(header, 0) !== 1) continue;
      const opcode = Atomics.load(header, 1);
      const at = base + (opcode > 0 && opcode < OPCODES ? opcode : 0) * 2;
      view[at] += 1;
      view[at + 1] += Atomics.load(header, 2);
    }
    const t0 = now();
    const served = serveOnce();
    if (served > 0) {
      view[base + SERVING_MS] += now() - t0;
      view[base + SERVED] += served;
    }
    return served;
  };
  return broker;
}

/**
 * A directory handle whose files' synchronous access handles count every call: what an OPFS
 * `RepackedPort` asks of the platform, by kind, with bytes and ms. The port only ever calls
 * `values()` and `getFileHandle()` on its directory and `createSyncAccessHandle()` on a file, and
 * everything else is forwarded untouched.
 */
export function countHandleCalls(directory, stats) {
  const view = stats.view;
  const base = stats.handleBase;
  const slot = (kind) => base + HANDLE_CALL_KINDS.indexOf(kind) * 3;
  const READ = slot('read');
  const WRITE = slot('write');
  const TRUNCATE = slot('truncate');
  const FLUSH = slot('flush');
  const GET_SIZE = slot('getSize');
  const record = (at, bytes, t0) => {
    view[at + 2] += now() - t0;
    view[at] += 1;
    view[at + 1] += bytes;
  };
  const countingHandle = (handle) => ({
    read(buffer, options) {
      const t0 = now();
      const n = handle.read(buffer, options);
      record(READ, n, t0);
      return n;
    },
    write(buffer, options) {
      const t0 = now();
      const n = handle.write(buffer, options);
      record(WRITE, n, t0);
      return n;
    },
    truncate(size) {
      const t0 = now();
      handle.truncate(size);
      record(TRUNCATE, 0, t0);
    },
    flush() {
      const t0 = now();
      handle.flush();
      record(FLUSH, 0, t0);
    },
    getSize() {
      const t0 = now();
      const size = handle.getSize();
      record(GET_SIZE, 0, t0);
      return size;
    },
    close() {
      handle.close();
    },
  });
  const forward = (target, property) => {
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  return new Proxy(directory, {
    get(target, property) {
      if (property !== 'getFileHandle') return forward(target, property);
      return async (name, options) => {
        const file = await target.getFileHandle(name, options);
        return new Proxy(file, {
          get(fileTarget, fileProperty) {
            if (fileProperty !== 'createSyncAccessHandle') return forward(fileTarget, fileProperty);
            return async (...args) => countingHandle(await fileTarget.createSyncAccessHandle(...args));
          },
        });
      };
    },
  });
}

/**
 * What moved between two snapshots, by kind:
 *
 *   guest.all       every agent's file calls        { [kind]: { calls, bytes, ms } }
 *   guest.sessions  the Session backends' alone     (the same shape)
 *   guest.sessionAgents  which agents those are
 *   broker          { requests: { [kind]: n }, requestBytes, served, servingMs }
 *   handles         { [kind]: { calls, bytes, ms } }
 *
 * The session marks are read from `after`: an agent marked during the window counts for all of it.
 */
export function describeIoStats(before, after) {
  const d = (index) => (after[index] ?? 0) - (before[index] ?? 0);
  const agents = after[1] ?? 0;
  const empty = (kinds) => Object.fromEntries(kinds.map((kind) => [kind, { calls: 0, bytes: 0, ms: 0 }]));
  const all = empty(GUEST_CALL_KINDS);
  const sessions = empty(GUEST_CALL_KINDS);
  const sessionAgents = [];
  for (let agent = 0; agent < agents; agent += 1) {
    const base = HEADER + agent * AGENT_STRIDE;
    const isSession = (after[base + SESSION_MARK] ?? 0) > 0;
    if (isSession) sessionAgents.push(agent);
    GUEST_CALL_KINDS.forEach((kind, k) => {
      const calls = d(base + k * 3);
      const bytes = d(base + k * 3 + 1);
      const ms = d(base + k * 3 + 2);
      all[kind].calls += calls;
      all[kind].bytes += bytes;
      all[kind].ms += ms;
      if (isSession) {
        sessions[kind].calls += calls;
        sessions[kind].bytes += bytes;
        sessions[kind].ms += ms;
      }
    });
  }
  const coord = HEADER + agents * AGENT_STRIDE;
  const requests = Object.fromEntries(BROKER_REQUEST_KINDS.map((kind) => [kind, 0]));
  let requestBytes = 0;
  let classified = 0;
  for (let opcode = 0; opcode < OPCODES; opcode += 1) {
    const n = d(coord + opcode * 2);
    requests[OPCODE_KINDS[opcode]] += n;
    requestBytes += d(coord + opcode * 2 + 1);
    classified += n;
  }
  const served = d(coord + SERVED);
  // Answered without having been peeked (published mid-scan): counted, kind unknown.
  if (served > classified) requests.other += served - classified;
  const handleBase = coord + COORD_STRIDE;
  const handles = empty(HANDLE_CALL_KINDS);
  HANDLE_CALL_KINDS.forEach((kind, k) => {
    handles[kind] = {
      calls: d(handleBase + k * 3),
      bytes: d(handleBase + k * 3 + 1),
      ms: d(handleBase + k * 3 + 2),
    };
  });
  return {
    guest: { all, sessions, sessionAgents },
    broker: { requests, requestBytes, served, servingMs: d(coord + SERVING_MS) },
    handles,
  };
}
