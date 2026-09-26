// broker-fs.js — the `--fs broker` seam: one instance's WASI FILE calls, routed to the
// coordinator worker's single repacked store instead of to a private copy of the packed image.
//
// WHY THIS EXISTS. Until now every worker built its OWN `Vfs` from its own copy of
// wasm/assets/vfs.img, so the process instance and the session instance had INDEPENDENT
// filesystems that diverged the moment either wrote (the KNOWN LIMIT at the top of
// threads-host.js). A second backend is impossible on that footing. Here the store lives
// alone in wasm/storage-worker.js and every other thread reaches it over a
// SharedArrayBuffer channel, blocking in Atomics.wait for the answer — which is the only
// shape that works, because a thread running wasm parks in futexes and can never observe a
// promise.
//
// WHAT THIS FILE IS. Nothing but wiring. The two halves both come from
// @pgxsinkit/pglite-opfs-repacked:
//
//   RepackedSyncClient    the synchronous half of the broker protocol (blocks on the channel)
//   createWasiPreview1Fs  the WASI preview1 filesystem adapter over that client
//
// The adapter owns fd 3 (the "/" preopen) and every fd >= 4, and `compose(base)` merges it
// over the host's own WASI object so fds 0/1/2 and every non-filesystem import —
// clock_time_get, poll_oneoff, random_get, proc_exit, thread-spawn — stay EXACTLY as
// threads-host.js built them.
//
// THE BUNDLE. The library is TypeScript in another repo; what we import here is its
// self-contained ESM redistribution bundle (`dist/browser-bundle.js`), which has no bare
// specifiers and no static imports at all, so it loads with no bundler in both hosts:
//
//   Node     import('file:///…/pgrust/wasm/vendor/pglite-opfs-repacked.js')
//   browser  import('http://localhost:8081/vendor/pglite-opfs-repacked.js')   (serve-coi.mjs)
//
// Both resolve from the SAME expression — `new URL('./vendor/pglite-opfs-repacked.js',
// import.meta.url)` — because the driver and the page sit at the same place relative to it.
// wasm/vendor/ is gitignored like wasm/assets/; link it in first:
//
//   mkdir -p wasm/vendor && ln -sfn \
//     /path/to/pgxsinkit/packages/pglite-opfs-repacked/dist/browser-bundle.js \
//     wasm/vendor/pglite-opfs-repacked.js
//   # the bundle is emitted by `bun run build:public-packages` in the pgxsinkit repo
//
// Override with PGRUST_REPACKED_BUNDLE (Node) or ?bundle= (browser).

export const VENDOR_BUNDLE_PATH = './vendor/pglite-opfs-repacked.js';

// A guest that talks to a coordinator which has gone away must fail loudly rather than park
// forever; 60s is far longer than any real request and far shorter than "never".
export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

// THE GATHER OPTION (`gather: true`), off by default. The library's adapter answers `fd_pwrite`
// with one broker write PER IOVEC, and Postgres's vectored writes (`pg_pwritev`: up to
// PG_IOV_MAX = 128 blocks at once, one iovec a block) therefore cost one round trip per 8 KiB
// block. Gathered, one `fd_pwrite` is one run of bytes and one broker write — chunked only by the
// channel's payload, which is why a gathering host also gives its guest channels
// `GATHER_PAYLOAD_BYTES` instead of the library's 64 KiB: 256 KiB of data per request, plus room
// for the request's own fields (fd, position, length: 17 bytes today), so a 32-block write is one
// request and a 128-block write four. Measured as lever H1 in pglite-v-pgrust's
// docs/results/2026-09-24-store-levers.md (§11): rows 11/6/14 at 0.79x/0.78x/0.91x alone.
export const GATHER_TRANSFER_BYTES = 256 * 1024;
export const GATHER_PAYLOAD_BYTES = GATHER_TRANSFER_BYTES + 64;

// WASI errno `io`: what a gathered write that throws answers, as the adapter's own guard does.
const WASI_EIO = 29;

/** The bundle URL both hosts resolve from their own module URL. */
export function repackedBundleUrl(base) {
  return new URL(VENDOR_BUNDLE_PATH, base).href;
}

/**
 * Load the library bundle. Kept as a function (rather than a static import) because the URL
 * is a runtime decision and because a worker must be able to load it before it builds a host.
 */
export async function loadRepackedBundle(url) {
  return import(url);
}

/**
 * Build one instance's filesystem seam: a client on `channel`, a WASI adapter over it, and a
 * `compose` the host applies to its own WASI object.
 *
 * `memory` is the SHARED WebAssembly.Memory every instance imports. The adapter re-reads
 * `memory.buffer` on every call by design: a shared memory grows underneath the host and a
 * cached view goes stale.
 *
 * `gather: true` makes one `fd_pwrite` one broker write (see THE GATHER OPTION above); the
 * channel's payload is the host's to size, at channel creation, before it reaches this worker.
 */
export function createBrokerFs({ bundle, channel, memory, label = 'guest', onLog, requestTimeoutMs, fdBase, gather = false }) {
  const attached = bundle.RepackedChannel.attach(channel);
  const client = new bundle.RepackedSyncClient(attached, {
    requestTimeoutMs: requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
  });
  // A JS exception thrown out of a WASI import leaves wasm as a foreign exception, which the
  // guest's nounwind frames turn into a bare `RuntimeError: unreachable` with no Rust message
  // at all. The adapter already converts every throw into EIO; this is where the stack we
  // would otherwise never see comes out.
  const onError = (call, cause) => {
    const detail = cause && cause.stack ? cause.stack : String(cause);
    if (onLog) onLog(`[${label}] wasi ${call} failed -> EIO: ${detail}`);
    else console.error(`[${label}] wasi ${call} failed -> EIO: ${detail}`);
  };
  const adapter = bundle.createWasiPreview1Fs({
    client,
    memory: () => memory.buffer,
    // Per-agent fd base (wasm/threads-host.js, "PIPE FDS, AND THE FD NUMBER
    // PLAN"): the adapter owns fd 3 and every fd >= fdBase, and N instances
    // sharing one guest fd table must not allocate overlapping fd numbers.
    // Undefined keeps the library default (preopenFd + 1 = 4).
    fdBase,
    onError,
  });
  // Before `compose`: the adapter hands its OWN members to the merged import object when the host
  // composes it, so a member replaced here is the one the guest calls.
  if (gather) gatherPwrites(adapter, client, memory, onError);
  return {
    channelId: attached.id,
    client,
    adapter,
    compose: (base) => adapter.compose(base),
    // Called when a guest thread returns: without it the coordinator holds this thread's store
    // descriptors until the whole channel detaches.
    closeAll: () => adapter.closeAll(),
    openFdCount: () => adapter.openFdCount(),
  };
}

/**
 * `gather: true`: one broker write per multi-iovec `fd_pwrite`.
 *
 * The adapter still does everything it does — resolves the fd, checks its rights, walks the iovecs,
 * writes the count back — and only the broker writes it makes DURING one such call are held: each
 * one is copied onto the end of a single run and answered in full at once, and the run goes to the
 * coordinator as ONE `client.write` when the adapter returns (chunked by the channel's payload, like
 * any write). The run's answer is then the call's: a short or failed run rewrites the count the
 * adapter reported, and a run that wrote nothing returns its errno, exactly as the per-iovec loop
 * reports a short or failed iovec. Single-iovec calls, `fd_write` and every read pass through.
 *
 * The adapter's writes within one `fd_pwrite` are contiguous on one fd by construction; one that is
 * not would be a new adapter, and is refused (EIO, logged) rather than reordered.
 */
function gatherPwrites(adapter, client, memory, onError) {
  const write = client.write.bind(client);
  let holding = false;
  let run = null; // { fd, at: bigint, length }
  let buffer = new Uint8Array(0);

  client.write = (fd, bytes, position) => {
    if (!holding) return write(fd, bytes, position);
    if (typeof position !== 'bigint') {
      run = null;
      throw new Error(`gathered fd_pwrite: a write to fd ${fd} has no position`);
    }
    if (run === null) {
      run = { fd, at: position, length: 0 };
    } else if (fd !== run.fd || position !== run.at + BigInt(run.length)) {
      run = null;
      throw new Error(`gathered fd_pwrite: a write to fd ${fd} at ${position} does not continue the run`);
    }
    const end = run.length + bytes.byteLength;
    if (end > buffer.byteLength) {
      const grown = new Uint8Array(Math.max(end, buffer.byteLength * 2, GATHER_TRANSFER_BYTES));
      grown.set(buffer.subarray(0, run.length));
      buffer = grown;
    }
    buffer.set(bytes, run.length);
    run.length = end;
    return { errno: 0, count: bytes.byteLength };
  };

  const pwrite = adapter.fd_pwrite;
  adapter.fd_pwrite = (fd, iovsPtr, iovsLen, offset, nwrittenPtr) => {
    if (iovsLen <= 1) return pwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr);
    holding = true;
    run = null;
    let rc;
    try {
      rc = pwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr);
    } finally {
      holding = false;
    }
    // Nothing held: the adapter refused the call, or every iovec was empty.
    if (run === null) return rc;
    const held = run;
    run = null;
    try {
      const result = write(held.fd, buffer.subarray(0, held.length), held.at);
      if (result.errno === 0 && result.count === held.length) return rc;
      new DataView(memory.buffer).setUint32(nwrittenPtr, result.count, true);
      return result.count > 0 ? 0 : result.errno;
    } catch (cause) {
      onError('fd_pwrite (gathered)', cause);
      return WASI_EIO;
    }
  };
}
