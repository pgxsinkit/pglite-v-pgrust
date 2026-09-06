/**
 * Hand-written types for the vendored `thread-worker.js`: the worker bootstrap the
 * `wasm32-wasip1-threads` build runs in all three of its roles — the process instance, a prewarmed
 * pool slot, and one `wasi_thread_start` run on that slot.
 *
 * Ours, not pgrust's. It is a **worker entry point**, not a library: it exports nothing and is
 * never imported, only handed to `new Worker(url, { type: "module" })` by the vendored
 * `threadWorkerUrl()`. This file exists so `src/vendor/pgrust/` type-checks as a whole under
 * `allowJs: false` and so a reader looking for the module finds its contract written down.
 *
 * The message it expects is `{ role: "process" | "thread-prewarm", … }`; the process role must be
 * instantiated **before** the pool is prewarmed, because with `--shared-memory` only the first
 * instance to run `__wasm_init_memory` initialises the passive data segments and the wasm main
 * thread's TLS block.
 */

export {};
