import { describe, expect, test } from "bun:test";

import { storeErrorLabel, toStoreError } from "./store-error";

/** A stand-in for the package's typed errors: same two carriers, no browser filesystem to import. */
function storeError(name: string, message: string, storeCode: string): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, { storeCode });
  return error;
}

function fsError(message: string, code: number): Error {
  const error = new Error(message);
  error.name = "FsError";
  Object.assign(error, { code });
  return error;
}

describe("storeErrorLabel", () => {
  test("names a store error by its class and its stable code", () => {
    expect(storeErrorLabel(storeError("StoreOwnedError", "another owner", "STORE_OWNED"))).toBe(
      "StoreOwnedError [STORE_OWNED]",
    );
    expect(storeErrorLabel(storeError("CorruptStoreError", "bad bytes", "CORRUPT_STORE"))).toBe(
      "CorruptStoreError [CORRUPT_STORE]",
    );
  });

  test("names an FsError by its errno, which is the code it carries instead of a storeCode", () => {
    expect(storeErrorLabel(fsError("no such file", 44))).toBe("FsError [errno 44]");
  });

  test("is undefined for anything that is not a store error", () => {
    expect(storeErrorLabel(new Error("plain"))).toBeUndefined();
    expect(storeErrorLabel("not an error")).toBeUndefined();
    expect(storeErrorLabel(undefined)).toBeUndefined();
    // A numeric `code` on something that is not an FsError says nothing about a store.
    const other = new Error("http");
    Object.assign(other, { code: 404 });
    expect(storeErrorLabel(other)).toBeUndefined();
  });
});

describe("toStoreError", () => {
  test("puts what failed, the class, the code and the reason in the message", () => {
    const cause = storeError("StoreOwnedError", "another live instance owns the store", "STORE_OWNED");
    const described = toStoreError('the opfs-repacked store failed to open "dir"', cause);
    expect(described.message).toBe(
      'the opfs-repacked store failed to open "dir": StoreOwnedError [STORE_OWNED]: another live instance owns the store',
    );
    expect(described.cause).toBe(cause);
  });

  test("still says what failed when the error is not the store's", () => {
    expect(toStoreError("opening", new Error("boom")).message).toBe("opening: boom");
    expect(toStoreError("opening", "boom").message).toBe("opening: boom");
  });

  test("keeps the original stack, which is the only place the frames exist", () => {
    const cause = storeError("StoreClosedError", "closed", "STORE_CLOSED");
    cause.stack = "StoreClosedError: closed\n    at somewhere";
    const described = toStoreError("using", cause);
    expect(described.stack).toContain("at somewhere");
    // The message has to survive with it: the page shows the stack when it contains the message.
    expect(described.stack).toContain(described.message);
  });
});
