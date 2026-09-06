import { describe, expect, test } from "bun:test";

import type { WireMessage } from "../../vendor/pgrust/wire.js";
import { encodeQuery, TERMINATE, WireReader } from "../../vendor/pgrust/wire.js";
import { assertNoQueryError, decodeQueryResult, toQueryError } from "./pgwire";

const encoder = new TextEncoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function cstring(value: string): Uint8Array {
  return concat([encoder.encode(value), Uint8Array.of(0)]);
}

function int16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setInt16(0, value, false);
  return out;
}

function int32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}

/** Wrap a body in the backend frame the WireReader expects: type byte, int32 length, body. */
function frame(type: string, body: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(type.charCodeAt(0)), int32(4 + body.length), body]);
}

/** `T` — one field per column: name, tableoid, attnum, typoid, typlen, atttypmod, format. */
function rowDescription(columns: readonly { name: string; typeid: number }[]): Uint8Array {
  const fields = columns.map((column) =>
    concat([
      cstring(column.name),
      int32(0), // tableoid
      int16(0), // attnum
      int32(column.typeid),
      int16(4), // typlen
      int32(-1), // atttypmod
      int16(0), // format = text
    ]),
  );
  return frame("T", concat([int16(columns.length), ...fields]));
}

/** `D` — int32 length then bytes per value; -1 is a SQL NULL. */
function dataRow(values: readonly (string | null)[]): Uint8Array {
  const cells = values.map((value) =>
    value === null ? int32(-1) : concat([int32(encoder.encode(value).length), encoder.encode(value)]),
  );
  return frame("D", concat([int16(values.length), ...cells]));
}

function commandComplete(tag: string): Uint8Array {
  return frame("C", cstring(tag));
}

/** `E` — one field per entry (code byte + cstring), terminated by a zero byte. */
function errorResponse(fields: Readonly<Record<string, string>>): Uint8Array {
  const entries = Object.entries(fields).map(([code, value]) =>
    concat([Uint8Array.of(code.charCodeAt(0)), cstring(value)]),
  );
  return frame("E", concat([...entries, Uint8Array.of(0)]));
}

function readyForQuery(status: string): Uint8Array {
  return frame("Z", encoder.encode(status));
}

/** Feed framed bytes through the vendored reader, exactly as the worker's stdout pump does. */
function read(...frames: readonly Uint8Array[]): WireMessage[] {
  const reader = new WireReader();
  reader.feed(concat(frames));
  const messages: WireMessage[] = [];
  let message = reader.next();
  while (message !== null) {
    messages.push(message);
    message = reader.next();
  }
  expect(reader.buffered).toBe(0);
  return messages;
}

describe("the vendored wire codec", () => {
  test("is importable as ES modules and encodes a simple-query frame", () => {
    const query = encodeQuery("SELECT 1");
    expect(String.fromCharCode(query[0] ?? 0)).toBe("Q");
    expect(new DataView(query.buffer).getInt32(1, false)).toBe(query.length - 1);
    expect(query[query.length - 1]).toBe(0);
    expect(TERMINATE.length).toBe(5);
    expect(String.fromCharCode(TERMINATE[0] ?? 0)).toBe("X");
  });

  test("re-frames a byte stream into the messages the decoder consumes", () => {
    const messages = read(commandComplete("SELECT 0"), readyForQuery("I"));
    expect(messages.map((message) => message.t)).toEqual(["C", "Z"]);
  });
});

describe("decodeQueryResult", () => {
  test("decodes columns, rows and the command tag of one result set", () => {
    const result = decodeQueryResult(
      read(
        rowDescription([
          { name: "id", typeid: 23 },
          { name: "label", typeid: 25 },
        ]),
        dataRow(["1", "one"]),
        dataRow(["2", null]),
        commandComplete("SELECT 2"),
        readyForQuery("I"),
      ),
    );

    expect(result.columns).toEqual(["id", "label"]);
    expect(result.rows).toEqual([
      ["1", "one"],
      ["2", null],
    ]);
    expect(result.tag).toBe("SELECT 2");
    expect(result.error).toBeNull();
    expect(result.resultSets).toBe(1);
  });

  test("decodes UTF-8 values that are not ASCII", () => {
    const result = decodeQueryResult(
      read(rowDescription([{ name: "v", typeid: 25 }]), dataRow(["héllo 世界"]), commandComplete("SELECT 1")),
    );
    expect(result.rows).toEqual([["héllo 世界"]]);
  });

  test("counts every result set of a multi-statement script and keeps the last one", () => {
    const result = decodeQueryResult(
      read(
        rowDescription([{ name: "a", typeid: 23 }]),
        dataRow(["1"]),
        commandComplete("SELECT 1"),
        rowDescription([{ name: "b", typeid: 23 }]),
        dataRow(["2"]),
        dataRow(["3"]),
        commandComplete("SELECT 2"),
        readyForQuery("I"),
      ),
    );

    expect(result.resultSets).toBe(2);
    expect(result.columns).toEqual(["b"]);
    expect(result.rows).toEqual([["2"], ["3"]]);
    expect(result.tag).toBe("SELECT 2");
  });

  test("reports a row-free statement as a tag with no columns", () => {
    const result = decodeQueryResult(read(commandComplete("INSERT 0 1"), readyForQuery("I")));
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
    expect(result.tag).toBe("INSERT 0 1");
    expect(result.resultSets).toBe(0);
  });

  test("keeps the first backend error and does not throw", () => {
    const result = decodeQueryResult(
      read(
        errorResponse({ S: "ERROR", C: "42P01", M: 'relation "missing" does not exist' }),
        errorResponse({ S: "ERROR", C: "42601", M: "syntax error" }),
        readyForQuery("E"),
      ),
    );

    expect(result.error).toEqual({
      severity: "ERROR",
      message: 'relation "missing" does not exist',
      code: "42P01",
    });
    expect(result.tag).toBeNull();
  });

  // A Concurrency Scenario counts tolerated failures by SQLSTATE — a lock timeout is a result, not a
  // Run failure — so the code has to survive the decode rather than only the message text.
  test("keeps the SQLSTATE of the error it kept", () => {
    const result = decodeQueryResult(
      read(errorResponse({ S: "ERROR", C: "55P03", M: "canceling statement due to lock timeout" }), readyForQuery("E")),
    );
    expect(result.error?.code).toBe("55P03");
  });

  test("reports an empty SQLSTATE for a backend error that carried none", () => {
    const result = decodeQueryResult(read(errorResponse({ S: "ERROR", M: "no code here" }), readyForQuery("E")));
    expect(result.error?.code).toBe("");
  });

  test("ignores notices, parameter status and backend key data", () => {
    const notice = frame(
      "N",
      concat([Uint8Array.of(0x53), cstring("NOTICE"), Uint8Array.of(0x4d), cstring("hi"), Uint8Array.of(0)]),
    );
    const result = decodeQueryResult(read(notice, commandComplete("SET"), readyForQuery("I")));
    expect(result.error).toBeNull();
    expect(result.tag).toBe("SET");
  });

  test("returns an empty result for an empty message list", () => {
    const result = decodeQueryResult([]);
    expect(result).toEqual({ rows: [], columns: [], tag: null, error: null, resultSets: 0 });
  });
});

describe("the Engine boundary", () => {
  test("turns a backend error into a thrown Error carrying the Postgres message text", () => {
    const result = decodeQueryResult(
      read(errorResponse({ S: "ERROR", C: "42P01", M: 'relation "missing" does not exist' }), readyForQuery("E")),
    );

    expect(() => {
      assertNoQueryError(result);
    }).toThrow('pgrust ERROR: relation "missing" does not exist (SQLSTATE 42P01)');
  });

  test("keeps the severity in the thrown message", () => {
    expect(toQueryError({ severity: "FATAL", message: "terminating connection", code: "" }).message).toBe(
      "pgrust FATAL: terminating connection",
    );
  });

  test("does not throw for a successful cycle", () => {
    const result = decodeQueryResult(read(commandComplete("SELECT 0"), readyForQuery("I")));
    expect(() => {
      assertNoQueryError(result);
    }).not.toThrow();
  });
});
