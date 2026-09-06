/**
 * How a store failure is named on its way out of the PGlite worker.
 *
 * `@pgxsinkit/pglite-opfs-repacked` throws typed errors that carry a stable string `storeCode`
 * (`StoreOwnedError` -> `STORE_OWNED`), or, for `FsError`, a PGlite-compatible numeric errno. An
 * error crosses `postMessage` as its message and its stack and nothing else: the class is gone, the
 * code is gone, and Firefox's `stack` does not even repeat the error's name. A Run failure that
 * reaches the page as bare prose is a failure nobody can look up in the store's error table, so the
 * name and the code are folded into the message here, before the error leaves the worker.
 *
 * Structural rather than `instanceof`: the codes are the package's documented stable surface, and
 * importing its error classes into a unit test would drag a browser-only filesystem in with them.
 */

/** `Name [CODE]` for a store error, or `undefined` for anything that is not one. */
export function storeErrorLabel(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const carrier = error as unknown as { readonly storeCode?: unknown; readonly code?: unknown };
  if (typeof carrier.storeCode === "string" && carrier.storeCode !== "") {
    return `${error.name} [${carrier.storeCode}]`;
  }
  if (error.name === "FsError" && typeof carrier.code === "number") {
    return `${error.name} [errno ${carrier.code}]`;
  }
  return undefined;
}

/**
 * The error the worker rethrows for a failed store operation: `<what failed>: <Name [CODE]>: <why>`.
 *
 * The original is kept as `cause` and its stack is carried over, so the console still shows where it
 * came from while the message alone is enough to diagnose the column.
 */
export function toStoreError(action: string, error: unknown): Error {
  const label = storeErrorLabel(error);
  const message = error instanceof Error ? error.message : String(error);
  const described = new Error(label === undefined ? `${action}: ${message}` : `${action}: ${label}: ${message}`, {
    cause: error,
  });
  if (error instanceof Error && error.stack !== undefined) {
    described.stack = `${described.message}\n${error.stack}`;
  }
  return described;
}
