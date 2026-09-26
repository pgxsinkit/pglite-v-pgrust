// store-levers.js — two optional levers on how the storage coordinator's store talks to its PORT,
// carried as a wrapper around that port in the coordinator (wasm/storage-worker.js) and never inside
// the store package, whose published build every PGlite OPFS column keeps running untouched. They are
// U1 and U2 of pglite-v-pgrust's store-levers note (docs/results/2026-09-24-store-levers.md, §2 and
// §11), where they were prototyped as a host-side wrapper of the same shape; re-implemented here so a
// phone can switch them on from the published page (`?storeLevers=grow,coalesce`). The note's U3
// (zero-skip) and U4 (metadata coalescing) are deliberately not here: a name this file does not know
// is refused, not ignored.
//
//   grow      U1. The arena file grows in STORE_LEVER_GROW_BYTES (4 MiB) chunks instead of one
//             truncate per allocation: a truncate that GROWS the arena past the file's real end is
//             rounded up to the next 4 MiB boundary, one that stays inside the slack already there
//             reaches no handle at all, and the store is always told the size it asked for (`getSize`
//             answers the logical size, and a read past it is short, exactly as at a file's end). The
//             slack is TRIMMED OFF ON CLOSE — a truncate to the logical size before the handle closes,
//             as the prototype did — so a cleanly closed store leaves the arena file the store's own
//             size. A growth truncate that fails is retried once at the exact size, so a quota the
//             chunk would cross surfaces as the store's own growth failure, not a lever's.
//   coalesce  U2. Contiguous arena writes inside ONE store call reach the handle as one write: held in
//             one STORE_LEVER_COALESCE_BYTES (1 MiB) buffer, and written out as soon as a write does
//             not continue the run or would overflow it, before anything else touches the arena
//             (read, getSize, truncate, flush, close), before any MUTATION of the other three files,
//             and when the store call returns. A write larger than the buffer goes straight through.
//
// ONLY THE ARENA. `arena.bin` is the one file either lever changes; the two metadata files and the
// activation file are passed through, and with `coalesce` their writes, truncates and flushes first
// write out whatever the arena is holding. That last rule is stricter than the prototype, which held
// arena bytes across a metadata append in the same call: here the platform sees every byte in the
// order the store issued it, and the common call — its arena writes, then one metadata frame — makes
// the same single arena write either way.
//
// WHAT THEY CHANGE. `coalesce`: nothing the store can observe, as long as the deferred writes land;
// every held byte reaches the handle before the call that wrote it returns. One that FAILS is where a
// wrapper outside the store has to be careful: the store believes those bytes are written. So a
// failed deferred write fails the wrapper CLOSED (StoreLeverWriteError): if it surfaces inside a
// store call the store sees it as its own platform failure and poisons itself; if it surfaces when
// the call returns, every later call through this wrapper throws it, and the broker answers every
// later request with a store fault. `grow`: the arena file is up to 4 MiB longer than the store's
// extents while it is open, and a coordinator that dies without closing leaves it so; reopening such
// a store was not exercised (every lane that uses this starts from an emptied directory).
//
// Counters of what the levers did (the store's arena calls against the handle calls they became) are
// reported with the coordinator's `storage-stopped`.

/** The levers a host may name, in the order they are reported. */
export const STORE_LEVER_NAMES = Object.freeze(['grow', 'coalesce']);

/** U1's chunk: the arena file grows to the next multiple of this. */
export const STORE_LEVER_GROW_BYTES = 4 * 1024 * 1024;

/** U2's buffer: the most arena bytes one coalesced write carries. */
export const STORE_LEVER_COALESCE_BYTES = 1024 * 1024;

const ARENA = 'arena.bin';

/** Thrown by every call once a deferred (coalesced) arena write has failed: the wrapper fails closed. */
export class StoreLeverWriteError extends Error {
  constructor(cause) {
    super(`a coalesced arena write failed after the store call that issued it: ${cause && cause.message ? cause.message : cause}`, { cause });
    this.name = 'StoreLeverWriteError';
  }
}

/**
 * A host's levers as `{ grow, coalesce }`, or null when none is on. Takes a list of names (the
 * order does not matter) or a comma-separated string; an unknown name is a RangeError.
 */
export function normalizeStoreLevers(value) {
  if (value === undefined || value === null || value === '') return null;
  const names = typeof value === 'string' ? value.split(',') : Array.from(value);
  const on = new Set();
  for (const raw of names) {
    const name = String(raw).trim();
    if (name === '') continue;
    if (!STORE_LEVER_NAMES.includes(name)) {
      throw new RangeError(`unknown store lever ${JSON.stringify(name)}; the levers are ${STORE_LEVER_NAMES.join(', ')}`);
    }
    on.add(name);
  }
  if (on.size === 0) return null;
  return Object.freeze({ grow: on.has('grow'), coalesce: on.has('coalesce') });
}

/** The levers that are on, by name, in STORE_LEVER_NAMES order. */
export function storeLeverList(levers) {
  return levers === null ? [] : STORE_LEVER_NAMES.filter((name) => levers[name]);
}

/**
 * Put the levers `spec` names around `port`, or return null when it names none.
 *
 * Returns `{ levers, port, view(vfs), report() }`: open the store on `port` instead of the original,
 * hand every consumer of the store `view(store)` instead of the store itself (the call boundary the
 * coalesced writes are flushed at), and read `report()` once the store has closed.
 */
export function applyStoreLevers(port, spec) {
  const levers = normalizeStoreLevers(spec);
  if (levers === null) return null;

  const counts = {
    storeWrites: 0,
    handleWrites: 0,
    storeTruncates: 0,
    handleTruncates: 0,
    trimmedBytes: 0,
  };
  let failed = null;
  let arena = null; // the arena handle's lever state, once acquired

  const check = () => {
    if (failed !== null) throw failed;
  };
  const flushArena = () => {
    if (arena !== null) arena.flushPending();
  };

  function arenaHandle(real) {
    let logical = -1;
    let physical = -1;
    let pendAt = -1;
    let pendLen = 0;
    let pendBuf = null;

    // U1's view of the file, read once from the handle the first time it is needed.
    const sizes = (label) => {
      if (physical >= 0) return;
      physical = real.getSize(label);
      logical = physical;
    };

    const flushPending = () => {
      if (pendLen === 0) return;
      const at = pendAt;
      const length = pendLen;
      pendAt = -1;
      pendLen = 0;
      let done = 0;
      try {
        while (done < length) {
          const n = real.write(pendBuf.subarray(done, length), at + done, 'store-levers.arena.coalesced-write');
          if (!Number.isSafeInteger(n) || n <= 0 || n > length - done) {
            throw new Error(`the handle wrote ${n} of ${length - done} bytes`);
          }
          counts.handleWrites += 1;
          done += n;
        }
      } catch (cause) {
        failed = new StoreLeverWriteError(cause);
        throw failed;
      }
    };

    const writeThrough = (source, at, label) => {
      const n = real.write(source, at, label);
      counts.handleWrites += 1;
      if (levers.grow && Number.isSafeInteger(n) && n > 0) {
        const end = at + n;
        if (end > logical) logical = end;
        if (end > physical) physical = end;
      }
      return n;
    };

    const growTo = (size, label) => {
      const chunked = Math.ceil(size / STORE_LEVER_GROW_BYTES) * STORE_LEVER_GROW_BYTES;
      try {
        real.truncate(chunked, label);
        counts.handleTruncates += 1;
        physical = chunked;
      } catch {
        // The chunk may cross a quota the exact size does not: ask for exactly what the store asked
        // for, so a failure that remains is the store's own growth failure and is handled as one.
        real.truncate(size, label);
        counts.handleTruncates += 1;
        physical = size;
      }
    };

    const handle = {
      name: real.name,
      getSize(label) {
        check();
        flushPending();
        if (!levers.grow) return real.getSize(label);
        sizes(label);
        return logical;
      },
      read(target, at, label) {
        check();
        flushPending();
        if (!levers.grow) return real.read(target, at, label);
        sizes(label);
        if (at >= logical) return 0;
        const room = logical - at;
        return real.read(target.byteLength > room ? target.subarray(0, room) : target, at, label);
      },
      write(source, at, label) {
        check();
        counts.storeWrites += 1;
        if (levers.grow) sizes(label);
        const length = source.byteLength;
        if (!levers.coalesce || length === 0) return writeThrough(source, at, label);
        if (pendLen > 0 && (at !== pendAt + pendLen || pendLen + length > STORE_LEVER_COALESCE_BYTES)) flushPending();
        if (length > STORE_LEVER_COALESCE_BYTES) return writeThrough(source, at, label);
        if (pendBuf === null) pendBuf = new Uint8Array(STORE_LEVER_COALESCE_BYTES);
        if (pendLen === 0) pendAt = at;
        pendBuf.set(source, pendLen);
        pendLen += length;
        if (levers.grow) {
          const end = at + length;
          if (end > logical) logical = end;
          if (end > physical) physical = end;
        }
        return length;
      },
      truncate(size, label) {
        check();
        flushPending();
        counts.storeTruncates += 1;
        if (!levers.grow) {
          real.truncate(size, label);
          counts.handleTruncates += 1;
          return;
        }
        sizes(label);
        if (size > logical) {
          // Growing: inside the slack a previous chunk left, nothing reaches the handle — those bytes
          // are zero already, the file only ever grew there by truncate.
          if (size > physical) growTo(size, label);
          logical = size;
          return;
        }
        real.truncate(size, label);
        counts.handleTruncates += 1;
        logical = size;
        physical = size;
      },
      flush(label) {
        check();
        flushPending();
        real.flush(label);
      },
      close() {
        // The handle is released whatever happens before it: an OPFS sync access handle that is never
        // closed keeps its directory owned until the worker dies.
        try {
          if (failed === null) {
            flushPending();
            if (levers.grow && logical >= 0 && physical > logical) {
              real.truncate(logical, 'store-levers.arena.trim');
              counts.handleTruncates += 1;
              counts.trimmedBytes += physical - logical;
              physical = logical;
            }
          }
        } finally {
          real.close();
        }
      },
    };
    arena = { flushPending };
    return handle;
  }

  // The other three files: passed through, except that with `coalesce` a mutation writes out the
  // arena's held bytes first, so the platform sees the store's writes in the store's order.
  function orderedHandle(real) {
    return {
      name: real.name,
      getSize: (label) => {
        check();
        return real.getSize(label);
      },
      read: (target, at, label) => {
        check();
        return real.read(target, at, label);
      },
      write: (source, at, label) => {
        check();
        flushArena();
        return real.write(source, at, label);
      },
      truncate: (size, label) => {
        check();
        flushArena();
        real.truncate(size, label);
      },
      flush: (label) => {
        check();
        flushArena();
        real.flush(label);
      },
      close: () => real.close(),
    };
  }

  // Every other member of the port (a memory port's test hooks, say) is forwarded untouched.
  const leveredPort = new Proxy(port, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'acquire' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (name, label) => {
        const real = await value.call(target, name, label);
        if (name === ARENA) return arenaHandle(real);
        return levers.coalesce ? orderedHandle(real) : real;
      };
    },
  });

  /**
   * The store as its consumers must see it: every method, and after it returns (or throws) the
   * arena's held bytes are written. A method called after a deferred write failed throws that
   * failure, except `close`, which must still release the handles.
   */
  function view(vfs) {
    const bound = new Map();
    return new Proxy(vfs, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        let wrapper = bound.get(prop);
        if (!wrapper) {
          wrapper = (...args) => {
            if (prop !== 'close') check();
            let result;
            try {
              result = value.apply(target, args);
            } catch (cause) {
              // The call's own failure is the one to report; a flush that fails as well has already
              // failed the wrapper closed for every call after this one.
              try {
                flushArena();
              } catch {}
              throw cause;
            }
            flushArena();
            return result;
          };
          bound.set(prop, wrapper);
        }
        return wrapper;
      },
    });
  }

  return {
    levers,
    port: leveredPort,
    view,
    report: () => ({ levers: storeLeverList(levers), failed: failed !== null, ...counts }),
  };
}
